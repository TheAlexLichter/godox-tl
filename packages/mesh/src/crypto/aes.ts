// AES primitives used by Bluetooth SIG Mesh.
//
// AES-CCM is delegated to Node's built-in `crypto` (it supports `aes-128-ccm`
// natively; @noble/ciphers v2.2 does not). AES-ECB single-block encryption is
// used by the AES-CMAC implementation in `cmac.ts`.

import { createCipheriv, createDecipheriv } from "node:crypto";
import { ecb } from "@noble/ciphers/aes.js";

/**
 * Encrypt with AES-128-CCM and return ciphertext concatenated with the MIC.
 *
 * @param key - 16-byte AES key.
 * @param nonce - 7..13 byte CCM nonce (Mesh uses 13).
 * @param plaintext - Plaintext bytes.
 * @param micLen - Authentication tag length (4 or 8 in Mesh).
 * @param associatedData - Optional AAD bytes.
 */
export const aesCcmEncrypt = (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  micLen: number,
  associatedData?: Uint8Array,
): Uint8Array => {
  const cipher = createCipheriv("aes-128-ccm", key, nonce, {
    authTagLength: micLen,
  });
  if (associatedData !== undefined && associatedData.length > 0) {
    cipher.setAAD(associatedData, { plaintextLength: plaintext.length });
  }
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(ct.length + tag.length);
  out.set(ct, 0);
  out.set(tag, ct.length);
  return out;
};

/**
 * Decrypt AES-128-CCM. Input must be ciphertext concatenated with the MIC.
 * Throws if authentication fails.
 */
export const aesCcmDecrypt = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextWithMic: Uint8Array,
  micLen: number,
  associatedData?: Uint8Array,
): Uint8Array => {
  if (ciphertextWithMic.length < micLen) {
    throw new Error("AES-CCM: ciphertext shorter than MIC length");
  }
  const ctLen = ciphertextWithMic.length - micLen;
  const ct = ciphertextWithMic.subarray(0, ctLen);
  const tag = ciphertextWithMic.subarray(ctLen);
  const decipher = createDecipheriv("aes-128-ccm", key, nonce, {
    authTagLength: micLen,
  });
  decipher.setAuthTag(tag);
  if (associatedData !== undefined && associatedData.length > 0) {
    decipher.setAAD(associatedData, { plaintextLength: ctLen });
  }
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return new Uint8Array(pt.buffer, pt.byteOffset, pt.byteLength);
};

/**
 * Encrypt a single 16-byte block under AES-128-ECB (no padding).
 * Used by the AES-CMAC subkey derivation and message processing.
 */
export const aesEcbEncrypt = (key: Uint8Array, block: Uint8Array): Uint8Array => {
  if (block.length !== 16) {
    throw new Error(`aesEcbEncrypt: block must be 16 bytes, got ${block.length}`);
  }
  const cipher = ecb(key, { disablePadding: true });
  return cipher.encrypt(block);
};
