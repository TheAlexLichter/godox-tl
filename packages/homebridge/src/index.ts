import type { API } from "homebridge";
import { GodoxTLPlatform, PLATFORM_NAME, PLUGIN_NAME } from "./platform.ts";

export { GodoxTLPlatform, PLATFORM_NAME, PLUGIN_NAME };
export { GodoxLightAccessory, miredsToKelvin, kelvinToMireds } from "./accessory.ts";
export { Debouncer } from "./debounce.ts";
export { resolveConfig, expandName, shortAddr } from "./config.ts";
export type { PluginConfig, ResolvedConfig } from "./config.ts";

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GodoxTLPlatform);
};
