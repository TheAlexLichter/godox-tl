// @godox-tl/mesh — Native Node.js SIG Mesh client for Godox TL30 BLE control.
//
// This package is being built out in milestones:
//   1. crypto primitives  (AES-CCM, AES-CMAC, k1..k4, P-256 ECDH)  — see ./crypto
//   2. PDU codecs         (provisioning + network/transport/access) — see ./pdu
//   3. BLE transport      (@stoprocent/noble + Mesh Proxy Service)  — see ./ble  ✅
//   4. Provisioning state machine                                   — see ./provisioning
//   5. ConfigSession (App Key Add + Model App Bind)                 — see ./config
//   6. Godox V2 payload encoder                                     — see ./godox
//   7. End-to-end Layer factory: makeNodeMeshLayer                  — see below
//   8. Transport swap in CLI + plugin                               — consumer change
//
// The native mesh controller is wired into the CLI and Homebridge plugin.

import {
  LightController,
  type TransportError,
  type TransportUnsupportedError,
} from "@godox-tl/core";
import { Layer } from "effect";
import { makeMeshController, type MeshControllerOptions } from "./controller.ts";

/** Effect Layer that provides a `LightController` backed by the native mesh stack. */
export const makeNodeMeshLayer = (
  options: MeshControllerOptions,
): Layer.Layer<LightController, TransportError | TransportUnsupportedError> =>
  Layer.succeed(LightController, makeMeshController(options));

// Milestone 3: BLE transport.
export {
  BleError,
  buildDiscoveredDevice,
  connectProvisioning,
  connectProxy,
  connectProxyWriter,
  dedupeDevices,
  matchAddress,
  MESH_PROVISIONING_SERVICE_UUID,
  MESH_PROXY_SERVICE_UUID,
  normalizeAddress,
  scanDevices,
  shutdownNoble,
  __setNobleForTesting,
} from "./ble/index.ts";
export type {
  BleScanOptions,
  DiscoveredDevice,
  NobleLike,
  PeripheralAdvertisementLike,
  PeripheralLike,
  ProxyConnection,
  ProxyWriterConnection,
} from "./ble/index.ts";

// Milestone 4: PB-GATT provisioning state machine.
export {
  ConfirmationMismatchError,
  provisionLight,
  ProvisioningError,
} from "./provisioning/index.ts";
export type { ProvisioningResult, ProvisionLightOptions } from "./provisioning/index.ts";

// Milestone 5: ConfigSession (App Key Add + Model App Bind).
export {
  ConfigError,
  GODOX_VENDOR_MODEL,
  OPCODE_CONFIG_APP_KEY_ADD,
  OPCODE_CONFIG_APP_KEY_STATUS,
  OPCODE_CONFIG_MODEL_APP_BIND,
  OPCODE_CONFIG_MODEL_APP_STATUS,
  rebindNode,
  rebindOverConnection,
  STATUS_SUCCESS,
  TELINK_COMPANY_ID,
  TELINK_VENDOR_MODEL_ID,
} from "./config/index.ts";
export type {
  ConfigStage,
  ModelIdentifier,
  RebindOptions,
  RebindResult,
  VendorModelIdentifier,
} from "./config/index.ts";

// Send-side controller + state-file I/O (milestone 7).
export { makeMeshController } from "./controller.ts";
export type { MeshControllerOptions } from "./controller.ts";
export { loadMeshState, MeshStateError, saveMeshState } from "./state.ts";
export type { MeshState } from "./state.ts";
export { provisionAndRebind } from "./integration.ts";
export type { ProvisionAndRebindOptions, ProvisionAndRebindResult } from "./integration.ts";
