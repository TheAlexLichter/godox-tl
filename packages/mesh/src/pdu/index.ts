// PDU codecs for Bluetooth SIG Mesh — milestone 2.
//
// Layer stack (outermost to innermost on the wire):
//   Proxy → Network → Lower Transport → Upper Transport → Access

export { encodeAccessPdu, encodeVendorOpcode } from "./access.ts";
export {
  encodeDeviceKeyFrame,
  encodeGodoxFrame,
  type EncodeDeviceKeyFrameOpts,
  type EncodeGodoxFrameOpts,
} from "./accessFrame.ts";
export {
  decodeUnsegmentedAccess,
  encodeUnsegmentedAccess,
  type UnsegmentedAccessHeader,
} from "./lowerTransport.ts";
export {
  decodeNetworkPdu,
  encodeNetworkPdu,
  type DecodedNetworkPdu,
  type EncodeNetworkPduOpts,
} from "./network.ts";
export { decodeProxyPdu, encodeProxyPdu } from "./proxy.ts";
export { decryptAccessPdu, encryptAccessPdu } from "./upperTransport.ts";
