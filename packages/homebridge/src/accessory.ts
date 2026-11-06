import { Domain, type LightEntry } from "@godox-tl/core";
import { makeMeshController, type MeshController } from "@godox-tl/mesh";
import { Effect, type Layer } from "effect";
import type { HAP, Logger, PlatformAccessory, Service } from "homebridge";
import type { FxPreset, RgbwPreset } from "./config.ts";
import { Debouncer } from "./debounce.ts";
import { homebridgeLoggerLayer } from "./logger.ts";

const { Cct, Fx, Hsi, Off, Rgbw, byte, hue, kelvin, pct, sat } = Domain;

const KELVIN_MIN = 2700;
const KELVIN_MAX = 6500;
// HomeKit ColorTemperature is in mireds; mireds = 1_000_000 / kelvin.
const MIRED_MIN = Math.round(1_000_000 / KELVIN_MAX); // ≈154
const MIRED_MAX = Math.round(1_000_000 / KELVIN_MIN); // ≈370
// HAP's default Lightbulb ColorTemperature range is wider than the Godox
// hardware range. Keep HomeKit's range here so cached/adaptive values such as
// 140 mireds are accepted, then clamp before encoding the Godox command.
const HOMEKIT_MIRED_MIN = 140;
const HOMEKIT_MIRED_MAX = 500;

const clampMireds = (mireds: number): number => Math.max(MIRED_MIN, Math.min(MIRED_MAX, mireds));

const miredsToKelvin = (mireds: number): number =>
  Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, Math.round(1_000_000 / mireds)));

const kelvinToMireds = (k: number): number => clampMireds(Math.round(1_000_000 / k));

interface CommandState {
  on: boolean;
  brightness: number;
  mireds: number;
  hue: number;
  saturation: number;
  mode: "cct" | "hsi" | "rgbw" | "fx";
  rgbw: {
    red: number;
    green: number;
    blue: number;
    white: number;
  };
  fx: {
    effect: number;
    subtype: number;
    filter: number;
  };
}

const cloneState = (state: CommandState): CommandState => ({
  ...state,
  rgbw: { ...state.rgbw },
  fx: { ...state.fx },
});

const formatHomeKitValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return `${value}`;
  if (value === null || value === undefined) return `${value}`;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const RESTORE_ECHO_SUPPRESSION_MS = 1_500;
// HAPStatus.SERVICE_COMMUNICATION_FAILURE; HAPStatus is an ambient const enum.
const COMMUNICATION_FAILURE = -70402;
type HomeKitCharacteristic = NonNullable<ReturnType<Service["getCharacteristic"]>>;

export interface HomeKitFeatureConfig {
  readonly enableColor: boolean;
  readonly fxPresets: ReadonlyArray<FxPreset>;
  readonly rgbwPresets: ReadonlyArray<RgbwPreset>;
  readonly mesh?: {
    readonly sequenceDirectory?: string;
    readonly statePaths?: ReadonlyArray<string>;
    readonly findPeripheralTimeoutMs?: number;
    readonly proxyAddresses?: ReadonlyArray<string>;
    readonly sendTimeoutMs?: number;
    readonly writeTimeoutMs?: number;
  };
}

/** Wraps one Service.Lightbulb for one registered light. */
export class GodoxLightAccessory {
  private readonly service: Service;
  private readonly controller: MeshController;
  private readonly loggerLayer: Layer.Layer<never>;
  private readonly debouncer: Debouncer<CommandState>;
  private state: CommandState = {
    on: false,
    brightness: 100,
    mireds: Math.round((MIRED_MIN + MIRED_MAX) / 2),
    hue: 0,
    saturation: 100,
    mode: "cct",
    rgbw: {
      red: 255,
      green: 255,
      blue: 255,
      white: 0,
    },
    fx: {
      effect: 1,
      subtype: 0,
      filter: 0,
    },
  };
  private lastActiveState: CommandState = cloneState({ ...this.state, on: true });
  private restoredMode: CommandState["mode"] | undefined;
  private suppressColorTemperatureModeSwitchUntil = 0;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private communicationFailed = false;
  private nextCommandId = 0;
  private lastCompletedCommandId = 0;

  constructor(
    public readonly entry: LightEntry,
    private readonly accessory: PlatformAccessory,
    private readonly hap: HAP,
    private readonly log: Logger,
    private readonly features: HomeKitFeatureConfig = {
      enableColor: true,
      fxPresets: [],
      rgbwPresets: [],
    },
    debounceMs = 100,
  ) {
    this.controller = makeMeshController({
      address: entry.address,
      statePath: entry.statePath,
      ...features.mesh,
    });
    this.loggerLayer = homebridgeLoggerLayer(log);

    this.accessory
      .getService(this.hap.Service.AccessoryInformation)
      ?.setCharacteristic(this.hap.Characteristic.Manufacturer, "Godox")
      .setCharacteristic(this.hap.Characteristic.Model, "TL30")
      .setCharacteristic(this.hap.Characteristic.SerialNumber, entry.address);

    this.service =
      this.accessory.getService(this.hap.Service.Lightbulb) ??
      this.accessory.addService(this.hap.Service.Lightbulb, entry.name);

    this.service
      .getCharacteristic(this.hap.Characteristic.On)
      .onSet((v) => {
        this.log.debug(`[${this.entry.name}] HomeKit set On=${formatHomeKitValue(v)}`);
        if (v) {
          this.state = cloneState({ ...this.lastActiveState, on: true });
          this.suppressColorTemperatureEchoFor(this.state.mode);
        } else {
          if (this.state.on) {
            this.lastActiveState = cloneState({ ...this.state, on: true });
          }
          this.state = cloneState({ ...this.state, on: false });
          this.clearColorTemperatureEchoSuppression();
        }
        this.queue();
      })
      .onGet(() => this.readValue(this.state.on));

    this.service
      .getCharacteristic(this.hap.Characteristic.Brightness)
      .onSet((v) => {
        this.log.debug(`[${this.entry.name}] HomeKit set Brightness=${formatHomeKitValue(v)}`);
        this.state.brightness = Math.max(0, Math.min(100, Math.round(Number(v))));
        if (this.state.brightness > 0) this.state.on = true;
        this.queue();
      })
      .onGet(() => this.readValue(this.state.brightness));

    const colorTemperature = this.service
      .getCharacteristic(this.hap.Characteristic.ColorTemperature)
      .setProps({ minValue: HOMEKIT_MIRED_MIN, maxValue: HOMEKIT_MIRED_MAX })
      .updateValue(this.state.mireds);

    colorTemperature
      .onSet((v) => {
        this.log.debug(
          `[${this.entry.name}] HomeKit set ColorTemperature=${formatHomeKitValue(v)}`,
        );
        this.state.on = true;
        if (this.shouldSuppressColorTemperatureModeSwitch()) {
          this.state.mode = this.restoredMode ?? this.state.mode;
          this.setColorTemperatureForColorMode(colorTemperature);
        } else {
          this.clearColorTemperatureEchoSuppression();
          this.state.mireds = clampMireds(Math.round(Number(v)));
          this.state.mode = "cct";
          colorTemperature.updateValue(this.state.mireds);
          this.updateColorFromTemperature(this.state.mireds);
        }
        this.queue();
      })
      .onGet(() => this.readValue(this.colorTemperatureForHomeKit()));

    if (this.features.enableColor) {
      this.service
        .getCharacteristic(this.hap.Characteristic.Hue)
        .setProps({ minValue: 0, maxValue: 360 })
        .onSet((v) => {
          this.log.debug(`[${this.entry.name}] HomeKit set Hue=${formatHomeKitValue(v)}`);
          this.state.hue = Math.max(0, Math.min(360, Math.round(Number(v))));
          this.state.on = true;
          this.state.mode = "hsi";
          this.setColorTemperatureForColorMode(colorTemperature);
          this.suppressColorTemperatureEchoFor("hsi");
          this.queue();
        })
        .onGet(() => this.readValue(this.state.hue));

      this.service
        .getCharacteristic(this.hap.Characteristic.Saturation)
        .setProps({ minValue: 0, maxValue: 100 })
        .onSet((v) => {
          this.log.debug(`[${this.entry.name}] HomeKit set Saturation=${formatHomeKitValue(v)}`);
          this.state.saturation = Math.max(0, Math.min(100, Math.round(Number(v))));
          this.state.on = true;
          this.state.mode = "hsi";
          this.setColorTemperatureForColorMode(colorTemperature);
          this.suppressColorTemperatureEchoFor("hsi");
          this.queue();
        })
        .onGet(() => this.readValue(this.state.saturation));
    }

    for (const [index, preset] of this.features.fxPresets.entries()) {
      this.addMomentarySwitch(`FX: ${preset.name}`, `fx-${index}`, () => {
        this.clearColorTemperatureEchoSuppression();
        this.state = {
          ...this.state,
          on: true,
          brightness: preset.brightness,
          mode: "fx",
          fx: {
            effect: preset.effect,
            subtype: preset.subtype,
            filter: preset.filter,
          },
        };
        this.service.updateCharacteristic(this.hap.Characteristic.Brightness, preset.brightness);
        return this.commandForState(this.state);
      });
    }

    for (const [index, preset] of this.features.rgbwPresets.entries()) {
      this.addMomentarySwitch(`RGBW: ${preset.name}`, `rgbw-${index}`, () => {
        this.clearColorTemperatureEchoSuppression();
        this.state = {
          ...this.state,
          on: true,
          brightness: preset.brightness,
          mode: "rgbw",
          rgbw: {
            red: preset.red,
            green: preset.green,
            blue: preset.blue,
            white: preset.white,
          },
        };
        this.service.updateCharacteristic(this.hap.Characteristic.Brightness, preset.brightness);
        return this.commandForState(this.state);
      });
    }

    this.debouncer = new Debouncer<CommandState>(debounceMs, (s) => this.send(s));
  }

  /** HomeKit sends a single characteristic at a time, but we coalesce all
   * in-flight changes into one BLE write to avoid flooding the mesh. */
  private queue(): void {
    if (this.disposed) throw new this.hap.HapStatusError(COMMUNICATION_FAILURE);
    if (this.state.on) {
      this.lastActiveState = cloneState(this.state);
    }
    this.log.debug(`[${this.entry.name}] queue ${this.stateSummary(this.state)}`);
    this.debouncer.schedule({ ...this.state });
  }

  private suppressColorTemperatureEchoFor(mode: CommandState["mode"]): void {
    if (mode === "cct") {
      this.clearColorTemperatureEchoSuppression();
      return;
    }
    this.restoredMode = mode;
    this.suppressColorTemperatureModeSwitchUntil = Date.now() + RESTORE_ECHO_SUPPRESSION_MS;
  }

  private shouldSuppressColorTemperatureModeSwitch(): boolean {
    return (
      this.restoredMode !== undefined &&
      this.restoredMode !== "cct" &&
      Date.now() <= this.suppressColorTemperatureModeSwitchUntil
    );
  }

  private clearColorTemperatureEchoSuppression(): void {
    this.restoredMode = undefined;
    this.suppressColorTemperatureModeSwitchUntil = 0;
  }

  private colorTemperatureForHomeKit(): number {
    return this.state.mode === "hsi" ? HOMEKIT_MIRED_MIN : this.state.mireds;
  }

  private setColorTemperatureForColorMode(colorTemperature: HomeKitCharacteristic): void {
    colorTemperature.value = HOMEKIT_MIRED_MIN;
  }

  private updateColorFromTemperature(mireds: number): void {
    if (!this.features.enableColor) return;
    const color = this.hap.ColorUtils.colorTemperatureToHueAndSaturation(mireds);
    this.state.hue = color.hue;
    this.state.saturation = color.saturation;
    this.service.getCharacteristic(this.hap.Characteristic.Hue).updateValue(color.hue);
    this.service
      .getCharacteristic(this.hap.Characteristic.Saturation)
      .updateValue(color.saturation);
  }

  private send(s: CommandState): void {
    const cmd = this.commandForState(s);
    this.log.debug(`[${this.entry.name}] send ${cmd._tag} ${this.stateSummary(s)}`);
    this.runCommand(cmd);
  }

  private stateSummary(s: CommandState): string {
    return `on=${s.on} mode=${s.mode} brightness=${s.brightness} mireds=${s.mireds} hue=${s.hue} saturation=${s.saturation}`;
  }

  private commandForState(s: CommandState): Domain.LightCommand {
    if (!s.on) return Off.make({});
    if (s.mode === "hsi") {
      return Hsi.make({
        brightness: pct(s.brightness),
        hue: hue(s.hue),
        saturation: sat(s.saturation),
      });
    }
    if (s.mode === "rgbw") {
      return Rgbw.make({
        brightness: pct(s.brightness),
        red: byte(s.rgbw.red),
        green: byte(s.rgbw.green),
        blue: byte(s.rgbw.blue),
        white: byte(s.rgbw.white),
      });
    }
    if (s.mode === "fx") {
      return Fx.make({
        brightness: pct(s.brightness),
        effect: byte(s.fx.effect),
        subtype: byte(s.fx.subtype),
        filter: byte(s.fx.filter),
      });
    }
    return Cct.make({
      brightness: pct(s.brightness),
      temperature: kelvin(miredsToKelvin(s.mireds)),
    });
  }

  private runCommand(cmd: Domain.LightCommand, after?: () => void): void {
    if (this.disposed) return;
    const commandId = ++this.nextCommandId;
    Effect.runPromise(
      (this.controller.send(cmd) as Effect.Effect<void, unknown>).pipe(
        Effect.provide(this.loggerLayer),
        Effect.tap(() => Effect.sync(() => this.completeCommand(commandId, false))),
        Effect.catch((err) =>
          Effect.sync(() => {
            if (this.disposed) return;
            this.completeCommand(commandId, true);
            this.log.warn(`[${this.entry.name}] send failed: ${this.formatSendError(err)}`);
          }),
        ),
      ),
    )
      .catch((err: unknown) => {
        if (this.disposed) return;
        this.completeCommand(commandId, true);
        this.log.error(
          `[${this.entry.name}] send failed unexpectedly: ${this.formatSendError(err)}`,
        );
      })
      .finally(() => {
        if (!this.disposed) after?.();
      });
  }

  private completeCommand(commandId: number, failed: boolean): void {
    if (this.disposed || commandId < this.lastCompletedCommandId) return;
    this.lastCompletedCommandId = commandId;
    this.communicationFailed = failed;
  }

  private readValue<T>(value: T): T {
    if (this.disposed || this.communicationFailed) {
      throw new this.hap.HapStatusError(COMMUNICATION_FAILURE);
    }
    return value;
  }

  private formatSendError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "object" && err !== null) {
      const message = (err as { readonly message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return String(err);
  }

  private addMomentarySwitch(
    name: string,
    subtype: string,
    buildCommand: () => Domain.LightCommand,
  ): void {
    const service =
      this.accessory.getServiceById(this.hap.Service.Switch, subtype) ??
      this.accessory.addService(this.hap.Service.Switch, name, subtype);

    service
      .getCharacteristic(this.hap.Characteristic.On)
      .onSet((v) => {
        if (!v) return;
        this.runCommand(buildCommand(), () => {
          service.updateCharacteristic(this.hap.Characteristic.On, false);
        });
      })
      .onGet(() => this.readValue(false));
  }

  /** Discard pending HomeKit changes and await the controller's BLE cleanup. */
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.debouncer.cancel();
      this.disposal = Effect.runPromise(
        this.controller.close().pipe(Effect.provide(this.loggerLayer)),
      );
    }
    return this.disposal;
  }

  /** For test/inspection: desired settings, not confirmed physical output. */
  get currentState(): Readonly<CommandState> {
    return this.state;
  }
}

export {
  HOMEKIT_MIRED_MAX,
  HOMEKIT_MIRED_MIN,
  MIRED_MAX,
  MIRED_MIN,
  clampMireds,
  kelvinToMireds,
  miredsToKelvin,
};
