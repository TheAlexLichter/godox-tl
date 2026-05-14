// Public surface of the BLE transport. The higher-level mesh stack (network
// PDU, transport segmentation, access-layer encoders) consumes
// `scanDevices` to locate lights and `connectProxy` to drive one over a
// GATT proxy connection.

export { matchAddress, normalizeAddress } from "./address.ts";
export { BleError } from "./errors.ts";
export {
  buildDiscoveredDevice,
  dedupeDevices,
  MESH_PROVISIONING_SERVICE_UUID,
  MESH_PROXY_SERVICE_UUID,
  scanDevices,
} from "./scan.ts";
export { connectProvisioning } from "./provisioning.ts";
export { connectProxy, connectProxyWriter } from "./proxy.ts";
export { __setNobleForTesting, shutdownNoble } from "./noble.ts";
export type { NobleLike, PeripheralAdvertisementLike, PeripheralLike } from "./noble.ts";
export type {
  BleScanOptions,
  DiscoveredDevice,
  ProxyConnection,
  ProxyWriterConnection,
} from "./types.ts";
