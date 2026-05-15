import { join } from "node:path";
import type { LightEntry } from "@godox-tl/core";
import { Effect, type Layer } from "effect";
import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { GodoxLightAccessory } from "./accessory.ts";
import { type PluginConfig, type ResolvedConfig, resolveConfig } from "./config.ts";
import { discoverKnownLights, runDiscoveryCycle, runStartupScan } from "./discovery.ts";
import { homebridgeLoggerLayer } from "./logger.ts";

export const PLATFORM_NAME = "GodoxTL";
export const PLUGIN_NAME = "homebridge-godox-tl";
export const defaultHomebridgeRegistryPath = (api: API): string =>
  join(api.user.storagePath(), "godox-tl", "registry.json");

interface CachedAccessory {
  readonly accessory: PlatformAccessory;
  light?: GodoxLightAccessory;
}

export class GodoxTLPlatform implements DynamicPlatformPlugin {
  public readonly accessoriesByUUID = new Map<string, CachedAccessory>();
  private readonly config: ResolvedConfig;
  private readonly loggerLayer: Layer.Layer<never>;
  private scanTimer: NodeJS.Timeout | undefined;

  constructor(
    public readonly log: Logger,
    rawConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = resolveConfig(rawConfig as PluginConfig, {
      defaultRegistryPath: defaultHomebridgeRegistryPath(api),
    });
    this.loggerLayer = homebridgeLoggerLayer(this.log);
    this.log.info("Godox TL platform loaded");
    this.api.on("didFinishLaunching", () => {
      void this.didFinishLaunching();
    });
    this.api.on("shutdown", () => {
      if (this.scanTimer) clearInterval(this.scanTimer);
    });
  }

  /** Called once per cached accessory at startup, before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessoriesByUUID.set(accessory.UUID, { accessory });
  }

  private async didFinishLaunching(): Promise<void> {
    try {
      const discovered = await Effect.runPromise(
        discoverKnownLights(this.config).pipe(Effect.provide(this.loggerLayer)),
      );
      const startup = await Effect.runPromise(
        runStartupScan(this.config, discovered).pipe(Effect.provide(this.loggerLayer)),
      );
      const entries = startup.entries;
      if (startup.provisioned.length > 0) {
        this.log.info(
          `Startup auto-provisioned ${startup.provisioned.length} light(s): ${startup.provisioned
            .map((e) => `${e.entry.name}@${e.entry.address}`)
            .join(", ")}`,
        );
      }
      const entrySummary = entries.map((e) => `${e.name}@${e.address}`).join(", ");
      this.log.info(
        `Loaded ${entries.length} known light(s) ` +
          `(registry=${this.config.registryPath}, mode=${this.config.discoveryMode})` +
          `${entrySummary ? `: ${entrySummary}` : ""}`,
      );
      this.materializeAccessories(entries, true);
    } catch (err) {
      this.log.error("Failed to load registry:", err);
    }
    if (this.config.autoProvision) {
      this.scanTimer = setInterval(() => {
        void this.scanCycle();
      }, this.config.scanIntervalSeconds * 1000);
      void this.scanCycle();
    } else {
      this.log.info(
        this.config.autoProvisionOnStartup
          ? "Periodic auto-provision is disabled (autoProvision=false); restart Homebridge to run the startup provisioning scan again."
          : "Auto-provision is disabled; enable autoProvisionOnStartup for one-shot startup provisioning or autoProvision for periodic provisioning.",
      );
    }
  }

  private async scanCycle(): Promise<void> {
    const known = new Set(
      [...this.accessoriesByUUID.values()]
        .map((c) => c.light?.entry.address)
        .filter((a): a is string => Boolean(a)),
    );
    try {
      const newEntries = await Effect.runPromise(
        runDiscoveryCycle(this.config, known).pipe(Effect.provide(this.loggerLayer)),
      );
      if (newEntries.length === 0) return;
      this.log.info(
        `Auto-provisioned ${newEntries.length} new light(s): ${newEntries
          .map((e) => `${e.entry.name}@${e.entry.address}`)
          .join(", ")}`,
      );
      this.materializeAccessories(newEntries.map((r) => r.entry));
    } catch (err) {
      this.log.warn("Scan cycle failed:", err);
    }
  }

  private uuidForEntry(entry: LightEntry): string {
    return this.api.hap.uuid.generate(`godox-tl:${entry.address}`);
  }

  private materializeAccessories(entries: ReadonlyArray<LightEntry>, reconcile = false): void {
    const newOnes: PlatformAccessory[] = [];
    const seenUUIDs = new Set<string>();
    for (const entry of entries) {
      const uuid = this.uuidForEntry(entry);
      seenUUIDs.add(uuid);
      const cached = this.accessoriesByUUID.get(uuid);
      if (cached) {
        if (!cached.light) {
          cached.light = new GodoxLightAccessory(entry, cached.accessory, this.api.hap, this.log, {
            enableColor: this.config.enableColor,
            fxPresets: this.config.fxPresets,
            rgbwPresets: this.config.rgbwPresets,
          });
        }
        continue;
      }
      const accessory = new this.api.platformAccessory(entry.name, uuid);
      const wrapper = new GodoxLightAccessory(entry, accessory, this.api.hap, this.log, {
        enableColor: this.config.enableColor,
        fxPresets: this.config.fxPresets,
        rgbwPresets: this.config.rgbwPresets,
      });
      this.accessoriesByUUID.set(uuid, { accessory, light: wrapper });
      newOnes.push(accessory);
    }
    if (newOnes.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newOnes);
    }
    if (reconcile) {
      const stale: PlatformAccessory[] = [];
      for (const [uuid, cached] of this.accessoriesByUUID) {
        if (seenUUIDs.has(uuid)) continue;
        stale.push(cached.accessory);
        this.accessoriesByUUID.delete(uuid);
      }
      if (stale.length > 0) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      }
    }
  }
}
