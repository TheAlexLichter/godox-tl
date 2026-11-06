import { join } from "node:path";
import type { LightEntry } from "@godox-tl/core";
import { loadMeshState, normalizeAddress } from "@godox-tl/mesh";
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
      const proxyFallbacks = await this.proxyFallbacksFor(entries);
      this.materializeAccessories(entries, true, proxyFallbacks);
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
    const knownEntries = [...this.accessoriesByUUID.values()]
      .map((c) => c.light?.entry)
      .filter((entry): entry is LightEntry => Boolean(entry));
    try {
      const newEntries = await Effect.runPromise(
        runDiscoveryCycle(this.config, knownEntries).pipe(Effect.provide(this.loggerLayer)),
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

  private async proxyFallbacksFor(
    entries: ReadonlyArray<LightEntry>,
  ): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
    const groups = new Map<string, LightEntry[]>();
    for (const entry of entries) {
      try {
        const state = await Effect.runPromise(loadMeshState(entry.statePath));
        const key = `${this.hex(state.networkKey)}:${this.hex(state.appKey)}`;
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      } catch {
        this.log.warn(
          `[${entry.name}] mesh state could not be read; BLE proxy fallback disabled for this light.`,
        );
      }
    }

    const fallbacks = new Map<string, ReadonlyArray<string>>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const entry of group) {
        fallbacks.set(
          normalizeAddress(entry.address),
          group.filter((peer) => peer.address !== entry.address).map((peer) => peer.address),
        );
      }
    }
    if (groups.size > 1) {
      this.log.warn(
        `Known lights span ${groups.size} separate mesh network(s); BLE proxy fallback only works within each network. Factory-reset and re-provision lights to put them on one shared mesh.`,
      );
    }
    return fallbacks;
  }

  private hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private materializeAccessories(
    entries: ReadonlyArray<LightEntry>,
    reconcile = false,
    proxyFallbacks: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  ): void {
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
            mesh: {
              sequenceDirectory: this.config.sequenceDirectory,
              statePaths: entries.map((light) => light.statePath),
              findPeripheralTimeoutMs: this.config.bleFindTimeoutMs,
              proxyAddresses: proxyFallbacks.get(normalizeAddress(entry.address)) ?? [],
              sendTimeoutMs: this.config.bleSendTimeoutMs,
              writeTimeoutMs: this.config.bleWriteTimeoutMs,
            },
          });
        }
        continue;
      }
      const accessory = new this.api.platformAccessory(entry.name, uuid);
      const wrapper = new GodoxLightAccessory(entry, accessory, this.api.hap, this.log, {
        enableColor: this.config.enableColor,
        fxPresets: this.config.fxPresets,
        rgbwPresets: this.config.rgbwPresets,
        mesh: {
          sequenceDirectory: this.config.sequenceDirectory,
          statePaths: entries.map((light) => light.statePath),
          findPeripheralTimeoutMs: this.config.bleFindTimeoutMs,
          proxyAddresses: proxyFallbacks.get(normalizeAddress(entry.address)) ?? [],
          sendTimeoutMs: this.config.bleSendTimeoutMs,
          writeTimeoutMs: this.config.bleWriteTimeoutMs,
        },
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
