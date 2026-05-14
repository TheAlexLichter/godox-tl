// Network PDU — encrypts the LowerTransport PDU under the NetKey-derived
// encryption key, then obfuscates the (ctl||ttl||seq||src) header per
// Mesh Profile §3.8.7.3.
//
// Wire layout (after obfuscation):
//   [ ivi(1) | nid(7) ]            : 1 byte
//   obfuscated_header              : 6 bytes  (ctl/ttl, seq[3], src[2])
//   encDst || encLTP || netMic     : 2 + N + (4 or 8) bytes

import { aesCcmDecrypt, aesCcmEncrypt, aesEcbEncrypt } from "../crypto/aes.ts";
import { networkNonce } from "../crypto/nonces.ts";

const netMicLenForCtl = (ctl: 0 | 1): 4 | 8 => (ctl === 0 ? 4 : 8);

/**
 * Apply the Mesh Profile §3.8.7.3 header obfuscation in-place on a freshly
 * built network PDU. The privacy random is bytes 7..13 of the PDU (the first
 * 7 bytes of the encrypted network payload, i.e. encDst[2] + first 5 of
 * encLTP). The PECB is AES-ECB(privacyKey, 0x00..00 || ivIndex || privacyRandom);
 * XOR the first 6 bytes of PECB with the 6 header bytes.
 *
 * This is its own inverse (XOR), so it doubles as deobfuscate.
 */
const obfuscateInPlace = (pdu: Uint8Array, privacyKey: Uint8Array, ivIndex: number): void => {
  if (pdu.length < 14) {
    throw new Error("network PDU too short to obfuscate (need >= 14 bytes)");
  }
  const privacyPlaintext = new Uint8Array(16);
  // bytes 0..4 : zero pad
  // bytes 5..8 : iv index big-endian
  privacyPlaintext[5] = (ivIndex >>> 24) & 0xff;
  privacyPlaintext[6] = (ivIndex >>> 16) & 0xff;
  privacyPlaintext[7] = (ivIndex >>> 8) & 0xff;
  privacyPlaintext[8] = ivIndex & 0xff;
  // bytes 9..15 : privacy random = pdu[7..14]
  privacyPlaintext.set(pdu.subarray(7, 14), 9);

  const pecb = aesEcbEncrypt(privacyKey, privacyPlaintext);
  for (let i = 0; i < 6; i += 1) {
    pdu[1 + i] = pdu[1 + i]! ^ pecb[i]!;
  }
};

export interface EncodeNetworkPduOpts {
  readonly nid: number;
  readonly ivIndex: number;
  readonly ctl: 0 | 1;
  readonly ttl: number;
  readonly seq: number;
  readonly src: number;
  readonly dst: number;
  readonly lowerTransportPdu: Uint8Array;
  readonly encryptionKey: Uint8Array;
  readonly privacyKey: Uint8Array;
}

export const encodeNetworkPdu = (opts: EncodeNetworkPduOpts): Uint8Array => {
  const { nid, ivIndex, ctl, ttl, seq, src, dst, lowerTransportPdu, encryptionKey, privacyKey } =
    opts;
  if (nid < 0 || nid > 0x7f) throw new RangeError("nid must fit in 7 bits");
  if (ttl < 0 || ttl > 0x7f) throw new RangeError("ttl must fit in 7 bits");
  if (seq < 0 || seq > 0xff_ff_ff) throw new RangeError("seq must fit in 24 bits");
  if (src < 0 || src > 0xff_ff) throw new RangeError("src must fit in 16 bits");
  if (dst < 0 || dst > 0xff_ff) throw new RangeError("dst must fit in 16 bits");

  const nonce = networkNonce({ ctl, ttl, seq, src, ivIndex });

  // Encrypt (dst || lowerTransportPdu) under encryptionKey.
  const netPayload = new Uint8Array(2 + lowerTransportPdu.length);
  netPayload[0] = (dst >>> 8) & 0xff;
  netPayload[1] = dst & 0xff;
  netPayload.set(lowerTransportPdu, 2);
  const encrypted = aesCcmEncrypt(encryptionKey, nonce, netPayload, netMicLenForCtl(ctl));

  // Assemble PDU: ivi/nid (1) || ctl/ttl (1) || seq (3) || src (2) || encrypted
  const ctlTtl = ((ctl & 0x01) << 7) | (ttl & 0x7f);
  const ivi = ivIndex & 0x01;
  const byte0 = (ivi << 7) | (nid & 0x7f);

  const pdu = new Uint8Array(7 + encrypted.length);
  pdu[0] = byte0;
  pdu[1] = ctlTtl;
  pdu[2] = (seq >>> 16) & 0xff;
  pdu[3] = (seq >>> 8) & 0xff;
  pdu[4] = seq & 0xff;
  pdu[5] = (src >>> 8) & 0xff;
  pdu[6] = src & 0xff;
  pdu.set(encrypted, 7);

  obfuscateInPlace(pdu, privacyKey, ivIndex);
  return pdu;
};

export interface DecodedNetworkPdu {
  readonly ivi: 0 | 1;
  readonly nid: number;
  readonly ctl: 0 | 1;
  readonly ttl: number;
  readonly seq: number;
  readonly src: number;
  readonly dst: number;
  readonly lowerTransportPdu: Uint8Array;
}

export const decodeNetworkPdu = (opts: {
  readonly pdu: Uint8Array;
  readonly ivIndex: number;
  readonly encryptionKey: Uint8Array;
  readonly privacyKey: Uint8Array;
}): DecodedNetworkPdu => {
  const { ivIndex, encryptionKey, privacyKey } = opts;
  if (opts.pdu.length < 14) {
    throw new Error("network PDU too short");
  }
  // Copy so we don't mutate caller's buffer when deobfuscating.
  const pdu = opts.pdu.slice();
  obfuscateInPlace(pdu, privacyKey, ivIndex); // XOR is its own inverse

  const ivi = ((pdu[0]! >>> 7) & 0x01) as 0 | 1;
  const nid = pdu[0]! & 0x7f;
  const ctl = ((pdu[1]! >>> 7) & 0x01) as 0 | 1;
  const ttl = pdu[1]! & 0x7f;
  const seq = (pdu[2]! << 16) | (pdu[3]! << 8) | pdu[4]!;
  const src = (pdu[5]! << 8) | pdu[6]!;

  const nonce = networkNonce({ ctl, ttl, seq, src, ivIndex });
  const decrypted = aesCcmDecrypt(encryptionKey, nonce, pdu.subarray(7), netMicLenForCtl(ctl));
  const dst = (decrypted[0]! << 8) | decrypted[1]!;
  const lowerTransportPdu = decrypted.slice(2);

  return { ivi, nid, ctl, ttl, seq, src, dst, lowerTransportPdu };
};
