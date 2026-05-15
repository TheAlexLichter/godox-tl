import { dirname, join } from "node:path";
import { defaultRegistryPath as defaultCoreRegistryPath, type LightEntry } from "@godox-tl/core";

export type DiscoveryMode = "registry" | "manual" | "merge";

export interface FxPresetConfig {
  readonly name?: string;
  readonly brightness?: number;
  readonly effect?: number;
  readonly subtype?: number;
  readonly level?: number;
  readonly filter?: number;
}

export interface RgbwPresetConfig {
  readonly name?: string;
  readonly brightness?: number;
  readonly red?: number;
  readonly green?: number;
  readonly blue?: number;
  readonly white?: number;
}

export interface PluginConfig {
  readonly name?: string;
  readonly registryPath?: string;
  readonly discoveryMode?: DiscoveryMode;
  readonly autoProvision?: boolean;
  readonly startupScan?: boolean;
  readonly startupPruneMissing?: boolean;
  readonly autoProvisionOnStartup?: boolean;
  readonly scanIntervalSeconds?: number;
  readonly discoveryFilters?: ReadonlyArray<string>;
  readonly nameTemplate?: string;
  readonly enableColor?: boolean;
  readonly fxPresets?: ReadonlyArray<FxPresetConfig>;
  readonly rgbwPresets?: ReadonlyArray<RgbwPresetConfig>;
  readonly lights?: ReadonlyArray<Partial<LightEntry>>;
}

export interface FxPreset {
  readonly name: string;
  readonly brightness: number;
  readonly effect: number;
  readonly subtype: number;
  readonly filter: number;
}

export interface RgbwPreset {
  readonly name: string;
  readonly brightness: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly white: number;
}

export interface ResolvedConfig {
  readonly registryPath: string;
  readonly discoveryMode: DiscoveryMode;
  readonly autoProvision: boolean;
  readonly startupScan: boolean;
  readonly startupPruneMissing: boolean;
  readonly autoProvisionOnStartup: boolean;
  readonly scanIntervalSeconds: number;
  readonly discoveryFilters: ReadonlyArray<RegExp>;
  readonly nameTemplate: string;
  readonly enableColor: boolean;
  readonly fxPresets: ReadonlyArray<FxPreset>;
  readonly rgbwPresets: ReadonlyArray<RgbwPreset>;
  readonly manualLights: ReadonlyArray<LightEntry>;
}

export interface ResolveConfigOptions {
  readonly defaultRegistryPath?: string;
}

const DEFAULT_FILTERS = ["^GD_LED$"];

const clampInt = (
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number => {
  const n = Number.isFinite(value) ? Math.round(value as number) : fallback;
  return Math.max(min, Math.min(max, n));
};

const resolveFxPresets = (presets: ReadonlyArray<FxPresetConfig> = []): ReadonlyArray<FxPreset> =>
  presets
    .filter((p): p is FxPresetConfig & { readonly effect: number } =>
      Boolean(p.name && Number.isFinite(p.effect)),
    )
    .map((p) => ({
      name: p.name as string,
      brightness: clampInt(p.brightness, 0, 100, 100),
      effect: clampInt(p.effect, 0, 255, 1),
      subtype: clampInt(p.subtype ?? p.level, 0, 255, 0),
      filter: clampInt(p.filter, 0, 255, 0),
    }));

const resolveRgbwPresets = (
  presets: ReadonlyArray<RgbwPresetConfig> = [],
): ReadonlyArray<RgbwPreset> =>
  presets
    .filter((p): p is RgbwPresetConfig & { readonly name: string } => Boolean(p.name))
    .map((p) => ({
      name: p.name,
      brightness: clampInt(p.brightness, 0, 100, 100),
      red: clampInt(p.red, 0, 255, 0),
      green: clampInt(p.green, 0, 255, 0),
      blue: clampInt(p.blue, 0, 255, 0),
      white: clampInt(p.white, 0, 255, 0),
    }));

export const statesDirForRegistry = (registryPath: string): string =>
  join(dirname(registryPath), "states");

export const resolveConfig = (
  raw: PluginConfig,
  options: ResolveConfigOptions = {},
): ResolvedConfig => {
  const filters = (
    raw.discoveryFilters && raw.discoveryFilters.length > 0 ? raw.discoveryFilters : DEFAULT_FILTERS
  ).map((s) => new RegExp(s));

  const manualLights: LightEntry[] = (raw.lights ?? [])
    .filter((l): l is LightEntry & Partial<{ provisionedAt: string }> =>
      Boolean(l.name && l.address && l.statePath),
    )
    .map((l) => ({
      name: l.name as string,
      address: l.address as string,
      statePath: l.statePath as string,
      nodeAddress: l.nodeAddress,
      provisionedAt: l.provisionedAt ?? new Date(0).toISOString(),
    }));

  return {
    registryPath: raw.registryPath || options.defaultRegistryPath || defaultCoreRegistryPath(),
    discoveryMode: raw.discoveryMode ?? "merge",
    autoProvision: raw.autoProvision ?? false,
    startupScan: raw.startupScan ?? true,
    startupPruneMissing: raw.startupPruneMissing ?? false,
    autoProvisionOnStartup: raw.autoProvisionOnStartup ?? true,
    scanIntervalSeconds: Math.max(10, raw.scanIntervalSeconds ?? 60),
    discoveryFilters: filters,
    nameTemplate: raw.nameTemplate ?? "godox-{shortAddr}",
    enableColor: raw.enableColor ?? true,
    fxPresets: resolveFxPresets(raw.fxPresets),
    rgbwPresets: resolveRgbwPresets(raw.rgbwPresets),
    manualLights,
  };
};

export const shortAddr = (address: string): string => {
  const hex = address.replace(/[^0-9a-fA-F]/g, "");
  return (hex.slice(-6) || hex).toLowerCase();
};

export const expandName = (template: string, address: string): string =>
  template.replace(/\{shortAddr\}/g, shortAddr(address));
