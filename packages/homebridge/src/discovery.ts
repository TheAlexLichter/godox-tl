import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DiscoveredDevice,
  type LightEntry,
  listLights,
  register,
  saveRegistry,
} from "@godox-tl/core";
import {
  normalizeAddress,
  provisionAndRebind,
  scanDevices as meshScanDevices,
} from "@godox-tl/mesh";
import { Effect } from "effect";
import type { ResolvedConfig } from "./config.ts";
import { expandName, statesDirForRegistry } from "./config.ts";

/** Resolve final list of known lights at startup. */
export const discoverKnownLights = (config: ResolvedConfig) =>
  Effect.gen(function* () {
    if (config.discoveryMode === "manual") {
      return config.manualLights;
    }
    const fromRegistry = yield* listLights(config.registryPath).pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<LightEntry>),
    );
    if (config.discoveryMode === "registry") {
      return fromRegistry;
    }
    // merge: manual overrides registry by name
    const manualByName = new Map(config.manualLights.map((l) => [l.name, l]));
    const merged: LightEntry[] = [...fromRegistry];
    for (let i = 0; i < merged.length; i++) {
      const m = manualByName.get(merged[i]!.name);
      if (m) merged[i] = m;
    }
    for (const m of config.manualLights) {
      if (!fromRegistry.some((l) => l.name === m.name)) merged.push(m);
    }
    return merged;
  });

export interface ProvisionResult {
  readonly entry: LightEntry;
  readonly newlyProvisioned: boolean;
}

const scanGodoxDevices = (config: ResolvedConfig, timeoutSeconds: number) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`BLE scan starting (${timeoutSeconds}s)`);
    const scan: Effect.Effect<ReadonlyArray<DiscoveredDevice>, unknown> = meshScanDevices({
      timeoutSeconds,
    });

    const devices: ReadonlyArray<DiscoveredDevice> = yield* scan.pipe(
      Effect.tapError((e) =>
        Effect.logWarning(`Scan failed: ${(e as { message?: string })?.message ?? String(e)}`),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<DiscoveredDevice>),
    );
    const summary = devices
      .map(
        (d) =>
          `${d.name || "(unnamed)"}@${d.address} ${d.unprovisioned ? "unprovisioned" : "provisioned"} rssi=${d.rssi}`,
      )
      .join(", ");
    const unprovisionedCount = devices.filter((d) => d.unprovisioned).length;
    const scanMessage = `BLE scan complete: ${devices.length} Godox-like device(s), ${unprovisionedCount} unprovisioned${
      summary ? `: ${summary}` : ""
    }`;
    yield* unprovisionedCount > 0 ? Effect.logInfo(scanMessage) : Effect.logDebug(scanMessage);
    return devices;
  });

const provisionCandidates = (
  config: ResolvedConfig,
  knownAddresses: ReadonlySet<string>,
  devices: ReadonlyArray<DiscoveredDevice>,
) =>
  Effect.gen(function* () {
    // Address comparison is format-insensitive: noble strips dashes on some
    // platforms while registries may carry user-entered separators.
    const knownNormalized = new Set(Array.from(knownAddresses, normalizeAddress));
    const candidates = devices.filter(
      (d) => d.unprovisioned && config.discoveryFilters.some((r) => r.test(d.name)),
    );
    if (candidates.length > 0) {
      yield* Effect.logInfo(
        `Auto-provision candidates: ${candidates.map((d) => `${d.address}(${d.name})`).join(", ")}`,
      );
    } else {
      const details = devices
        .map(
          (d) =>
            `{addr=${d.address}, name='${d.name}', unprov=${d.unprovisioned}, ` +
            `nameMatch=${config.discoveryFilters.some((r) => r.test(d.name))}, ` +
            `known=${knownNormalized.has(normalizeAddress(d.address))}}`,
        )
        .join(" ");
      const message = `Auto-provision candidates: 0${details ? `. Discovered: ${details}` : ""}`;
      yield* devices.some((d) => d.unprovisioned)
        ? Effect.logInfo(message)
        : Effect.logDebug(message);
    }

    const results: ProvisionResult[] = [];
    const statesDir = statesDirForRegistry(config.registryPath);

    // Give the BLE adapter a beat to settle after the discovery scan's
    // fire-and-forget `stopScanningAsync` before kicking off the provisioning
    // scan. Without this, noble's HCI state on Linux races and the connect
    // scan often misses the device we just discovered.
    if (candidates.length > 0) {
      yield* Effect.sleep("1500 millis");
    }

    for (const dev of candidates) {
      const name = expandName(config.nameTemplate, dev.address);
      const statePath = join(statesDir, `${name}.json`);
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const r = yield* provisionAndRebind(dev.address, { statePath });
          return yield* register(
            { name, address: dev.address, statePath, nodeAddress: r.state.nodeAddress },
            config.registryPath,
          );
        }),
      ).pipe(
        Effect.map((entry) => ({ entry, ok: true as const })),
        // Swallow ALL provisioning-time errors and treat them as a transient
        // skip — the periodic scan loop will retry next cycle. Letting any
        // error bubble up crashes the scan-cycle Effect and surfaces noisy
        // FiberFailure traces in the Homebridge log for what's usually just
        // a flaky BLE moment.
        Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (outcome.ok) {
        results.push({ entry: outcome.entry, newlyProvisioned: true });
      } else {
        const e = outcome.error as { readonly message?: string };
        yield* Effect.logWarning(
          `Auto-provision skipped ${dev.address} (${dev.name}): ${e?.message ?? String(outcome.error)}`,
        );
      }
    }
    return results as ReadonlyArray<ProvisionResult>;
  });

export interface StartupScanResult {
  readonly entries: ReadonlyArray<LightEntry>;
  readonly provisioned: ReadonlyArray<ProvisionResult>;
}

const recoverEntriesFromStateFiles = (
  config: ResolvedConfig,
  devices: ReadonlyArray<DiscoveredDevice>,
  existing: ReadonlyArray<LightEntry>,
) =>
  Effect.tryPromise({
    try: async () => {
      const existingAddresses = new Set(existing.map((e) => normalizeAddress(e.address)));
      const existingNames = new Set(existing.map((e) => e.name));
      const discoveredProvisionedAddresses = new Set(
        devices.filter((d) => !d.unprovisioned).map((d) => normalizeAddress(d.address)),
      );

      const statesDir = statesDirForRegistry(config.registryPath);
      const names = await readdir(statesDir).catch(() => [] as string[]);
      const recovered: LightEntry[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const statePath = join(statesDir, name);
        let parsed: {
          device_address?: string;
          node_address?: number;
        };
        try {
          parsed = JSON.parse(await readFile(statePath, "utf8")) as {
            device_address?: string;
            node_address?: number;
          };
        } catch {
          continue;
        }
        if (!parsed.device_address) continue;
        if (existingAddresses.has(normalizeAddress(parsed.device_address))) continue;
        if (!discoveredProvisionedAddresses.has(normalizeAddress(parsed.device_address))) continue;
        const entryName = expandName(config.nameTemplate, parsed.device_address);
        if (existingNames.has(entryName)) continue;
        existingNames.add(entryName);
        recovered.push({
          name: entryName,
          address: parsed.device_address,
          statePath,
          nodeAddress: parsed.node_address,
          provisionedAt: new Date(0).toISOString(),
        });
      }
      return recovered;
    },
    catch: () => [] as ReadonlyArray<LightEntry>,
  });

export const runStartupScan = (config: ResolvedConfig, entries: ReadonlyArray<LightEntry>) =>
  Effect.gen(function* () {
    if (!config.startupScan) {
      return { entries, provisioned: [] } satisfies StartupScanResult;
    }

    const scanTimeoutSeconds = Math.min(10, config.scanIntervalSeconds);
    const devices = yield* scanGodoxDevices(config, scanTimeoutSeconds);

    const recovered = yield* recoverEntriesFromStateFiles(config, devices, entries);
    if (recovered.length > 0) {
      yield* Effect.logInfo(
        `Startup scan recovered ${recovered.length} registry entr${recovered.length === 1 ? "y" : "ies"} from state files: ${recovered
          .map((e) => `${e.name}@${e.address}`)
          .join(", ")}`,
      );
    }

    const knownBeforeProvision = [...entries, ...recovered];
    const provisioned = config.autoProvisionOnStartup
      ? yield* provisionCandidates(
          config,
          new Set(knownBeforeProvision.map((e) => e.address)),
          devices,
        )
      : [];
    const allEntries = [...knownBeforeProvision, ...provisioned.map((r) => r.entry)];

    if (recovered.length > 0 && config.discoveryMode !== "manual") {
      const nextRegistry = Object.fromEntries(allEntries.map((e) => [e.name, e]));
      yield* saveRegistry({ lights: nextRegistry }, config.registryPath);
    }

    const discoveredKnownAddresses = new Set(
      devices.filter((d) => !d.unprovisioned).map((d) => normalizeAddress(d.address)),
    );
    if (!config.startupPruneMissing || discoveredKnownAddresses.size === 0) {
      return { entries: allEntries, provisioned } satisfies StartupScanResult;
    }

    const filtered = allEntries.filter((e) =>
      discoveredKnownAddresses.has(normalizeAddress(e.address)),
    );
    const removed = allEntries.filter(
      (e) => !discoveredKnownAddresses.has(normalizeAddress(e.address)),
    );
    if (removed.length > 0) {
      yield* Effect.logWarning(
        `Startup scan pruned ${removed.length} missing light(s): ${removed
          .map((e) => `${e.name}@${e.address}`)
          .join(", ")}`,
      );
    }

    if (config.discoveryMode !== "manual") {
      const nextRegistry = Object.fromEntries(filtered.map((e) => [e.name, e]));
      yield* saveRegistry({ lights: nextRegistry }, config.registryPath);
    }

    return { entries: filtered, provisioned } satisfies StartupScanResult;
  });

/** Run a single periodic-scan cycle. Returns any lights that were auto-provisioned this cycle.
 *
 * For each scan result whose name matches `discoveryFilters`, is `unprovisioned`,
 * and whose address isn't already registered, invokes provision + rebind +
 * register. Skips silently on `ProvisioningTimeoutError` — the light is
 * probably already paired to another network. */
export const runDiscoveryCycle = (config: ResolvedConfig, knownAddresses: ReadonlySet<string>) =>
  Effect.gen(function* () {
    if (!config.autoProvision) return [] as ReadonlyArray<ProvisionResult>;

    const scanTimeoutSeconds = Math.min(10, config.scanIntervalSeconds);
    const devices = yield* scanGodoxDevices(config, scanTimeoutSeconds);
    return yield* provisionCandidates(config, knownAddresses, devices);
  });
