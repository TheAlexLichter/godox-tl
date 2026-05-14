import { Domain, type LightController, type LightEntry } from "@godox-tl/core";
import { makeMeshController } from "@godox-tl/mesh";
import { Effect, type Layer } from "effect";
import type { HAP, Logger, PlatformAccessory, Service } from "homebridge";
import type { FxPreset, RgbwPreset } from "./config.ts";
import { Debouncer } from "./debounce.ts";
import { homebridgeLoggerLayer } from "./logger.ts";

const { Cct, Fx, Hsi, Off, Rgbw, byte, hue, kelvin, pct, sat } = Domain;

const KELVIN_MIN = 2800;
const KELVIN_MAX = 6500;
// HomeKit ColorTemperature is in mireds; mireds = 1_000_000 / kelvin.
const MIRED_MIN = Math.round(1_000_000 / KELVIN_MAX); // ≈154
const MIRED_MAX = Math.round(1_000_000 / KELVIN_MIN); // ≈357
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

const RESTORE_ECHO_SUPPRESSION_MS = 1_500;

export interface HomeKitFeatureConfig {
  readonly enableColor: boolean;
  readonly fxPresets: ReadonlyArray<FxPreset>;
  readonly rgbwPresets: ReadonlyArray<RgbwPreset>;
}

/** Wraps one Service.Lightbulb for one registered light. */
export class GodoxLightAccessory {
  private readonly service: Service;
  private readonly controller: LightController["Type"];
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
    this.controller = makeMeshController({ address: entry.address, statePath: entry.statePath });
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
      .onGet(() => this.state.on);

    this.service
      .getCharacteristic(this.hap.Characteristic.Brightness)
      .onSet((v) => {
        this.state.brightness = Math.max(0, Math.min(100, Math.round(Number(v))));
        if (this.state.brightness > 0) this.state.on = true;
        this.queue();
      })
      .onGet(() => this.state.brightness);

    const colorTemperature = this.service
      .getCharacteristic(this.hap.Characteristic.ColorTemperature)
      .setProps({ minValue: HOMEKIT_MIRED_MIN, maxValue: HOMEKIT_MIRED_MAX })
      .updateValue(this.state.mireds);

    colorTemperature
      .onSet((v) => {
        this.state.mireds = clampMireds(Math.round(Number(v)));
        colorTemperature.updateValue(this.state.mireds);
        this.state.on = true;
        if (this.shouldSuppressColorTemperatureModeSwitch()) {
          this.state.mode = this.restoredMode ?? this.state.mode;
        } else {
          this.clearColorTemperatureEchoSuppression();
          this.state.mode = "cct";
        }
        this.queue();
      })
      .onGet(() => this.state.mireds);

    if (this.features.enableColor) {
      this.service
        .getCharacteristic(this.hap.Characteristic.Hue)
        .setProps({ minValue: 0, maxValue: 360 })
        .onSet((v) => {
          this.state.hue = Math.max(0, Math.min(360, Math.round(Number(v))));
          this.state.on = true;
          this.clearColorTemperatureEchoSuppression();
          this.state.mode = "hsi";
          this.queue();
        })
        .onGet(() => this.state.hue);

      this.service
        .getCharacteristic(this.hap.Characteristic.Saturation)
        .setProps({ minValue: 0, maxValue: 100 })
        .onSet((v) => {
          this.state.saturation = Math.max(0, Math.min(100, Math.round(Number(v))));
          this.state.on = true;
          this.clearColorTemperatureEchoSuppression();
          this.state.mode = "hsi";
          this.queue();
        })
        .onGet(() => this.state.saturation);
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
    if (this.state.on) {
      this.lastActiveState = cloneState(this.state);
    }
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

  private send(s: CommandState): void {
    this.runCommand(this.commandForState(s));
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
    Effect.runPromise(
      (this.controller.send(cmd) as Effect.Effect<void>).pipe(Effect.provide(this.loggerLayer)),
    )
      .catch((err: unknown) => {
        this.log.error(`[${this.entry.name}] send failed:`, err);
      })
      .finally(after);
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
      .onGet(() => false);
  }

  /** For test/inspection: current local cache. */
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
