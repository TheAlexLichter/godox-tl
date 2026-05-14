// Public surface of milestone 5 — the post-provisioning ConfigSession.

export { ConfigError, type ConfigStage } from "./errors.ts";
export {
  buildAppKeyAdd,
  buildModelAppBind,
  encodeModelIdentifier,
  encodeOpcode,
  GODOX_VENDOR_MODEL,
  OPCODE_CONFIG_APP_KEY_ADD,
  OPCODE_CONFIG_APP_KEY_STATUS,
  OPCODE_CONFIG_MODEL_APP_BIND,
  OPCODE_CONFIG_MODEL_APP_STATUS,
  parseAppKeyStatus,
  parseModelAppStatus,
  splitOpcode,
  STATUS_SUCCESS,
  TELINK_COMPANY_ID,
  TELINK_VENDOR_MODEL_ID,
  type ModelIdentifier,
  type ParsedAppKeyStatus,
  type ParsedModelAppStatus,
  type VendorModelIdentifier,
} from "./messages.ts";
export { awaitConfigStatus, tryDecodeProxyNotification } from "./receiver.ts";
export type { AwaitConfigStatusOptions, DecodedStatus } from "./receiver.ts";
export { rebindNode, rebindOverConnection } from "./session.ts";
export type { RebindOptions, RebindResult } from "./session.ts";
