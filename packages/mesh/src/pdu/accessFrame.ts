// Top-level Godox frame encoder — the single entry point the rest of the
// codebase calls when it wants to send a Godox vendor command to a mesh
// node. Composes Access → Upper Transport → Lower Transport → Network →
// Proxy and returns the bytes that go on the wire.

import { k2 } from "../crypto/kdf.ts";
import { k4 } from "../crypto/kdf.ts";
import { applicationNonce, deviceNonce } from "../crypto/nonces.ts";
import { encodeAccessPdu } from "./access.ts";
import { encodeUnsegmentedAccess } from "./lowerTransport.ts";
import { encodeNetworkPdu } from "./network.ts";
import { encodeProxyPdu } from "./proxy.ts";
import { encryptAccessPdu } from "./upperTransport.ts";

const DEFAULT_TTL = 10;

export interface EncodeGodoxFrameOpts {
  readonly netKey: Uint8Array;
  readonly appKey: Uint8Array;
  readonly src: number;
  readonly dst: number;
  readonly seq: number;
  readonly ivIndex: number;
  readonly vendorOpcode: Uint8Array;
  readonly godoxV2Payload: Uint8Array;
  readonly ttl?: number;
}

export const encodeGodoxFrame = (opts: EncodeGodoxFrameOpts): Uint8Array => {
  const {
    netKey,
    appKey,
    src,
    dst,
    seq,
    ivIndex,
    vendorOpcode,
    godoxV2Payload,
    ttl = DEFAULT_TTL,
  } = opts;

  const { nid, encryptionKey, privacyKey } = k2(netKey, new Uint8Array([0x00]));
  const aid = k4(appKey);

  const accessPdu = encodeAccessPdu({ opcode: vendorOpcode, payload: godoxV2Payload });

  const upperNonce = applicationNonce({ aszmic: 0, seq, src, dst, ivIndex });
  const encryptedAccessPdu = encryptAccessPdu({
    accessPdu,
    appKey,
    nonce: upperNonce,
    szmic: 0,
  });

  const lowerTransportPdu = encodeUnsegmentedAccess({
    akf: 1,
    aid,
    encryptedAccessPdu,
  });

  const networkPdu = encodeNetworkPdu({
    nid,
    ivIndex,
    ctl: 0,
    ttl,
    seq,
    src,
    dst,
    lowerTransportPdu,
    encryptionKey,
    privacyKey,
  });

  return encodeProxyPdu({ sar: 0, messageType: 0, payload: networkPdu });
};

/**
 * Variant for Config Server messages (App Key Add, Model App Bind, …) that
 * are secured with the device key rather than an app key. Lower transport
 * AKF=0, AID=0. Provided here for completeness; the controller's config
 * session will use it during provisioning bind.
 */
export interface EncodeDeviceKeyFrameOpts {
  readonly netKey: Uint8Array;
  readonly deviceKey: Uint8Array;
  readonly src: number;
  readonly dst: number;
  readonly seq: number;
  readonly ivIndex: number;
  readonly accessPdu: Uint8Array;
  readonly ttl?: number;
}

export const encodeDeviceKeyFrame = (opts: EncodeDeviceKeyFrameOpts): Uint8Array => {
  const { netKey, deviceKey, src, dst, seq, ivIndex, accessPdu, ttl = DEFAULT_TTL } = opts;
  const { nid, encryptionKey, privacyKey } = k2(netKey, new Uint8Array([0x00]));

  const upperNonce = deviceNonce({ aszmic: 0, seq, src, dst, ivIndex });
  const encryptedAccessPdu = encryptAccessPdu({
    accessPdu,
    appKey: deviceKey,
    nonce: upperNonce,
    szmic: 0,
  });

  const lowerTransportPdu = encodeUnsegmentedAccess({
    akf: 0,
    aid: 0,
    encryptedAccessPdu,
  });

  const networkPdu = encodeNetworkPdu({
    nid,
    ivIndex,
    ctl: 0,
    ttl,
    seq,
    src,
    dst,
    lowerTransportPdu,
    encryptionKey,
    privacyKey,
  });

  return encodeProxyPdu({ sar: 0, messageType: 0, payload: networkPdu });
};
