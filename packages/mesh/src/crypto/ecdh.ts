// P-256 ECDH helpers for Bluetooth Mesh provisioning.
//
// Mesh provisioning exchanges raw 64-byte public keys (X||Y, no `0x04`
// uncompressed prefix) and uses the 32-byte X coordinate of the shared point
// as the shared secret. @noble/curves uses standard SEC1 encoding, so we add
// and strip the `0x04` prefix at the boundary.

import { p256 } from "@noble/curves/nist.js";

export interface KeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array; // 64 bytes: X || Y, no 0x04 prefix
}

/**
 * Generate a fresh P-256 keypair. The returned `publicKey` is 64 bytes
 * (X concatenated with Y), as used by the Mesh provisioning protocol.
 */
export const generateKeyPair = (): KeyPair => {
  const { secretKey, publicKey } = p256.keygen();
  const uncompressed = p256.getPublicKey(secretKey, false); // 65 bytes, 0x04||X||Y
  if (publicKey.length !== 65 && uncompressed.length !== 65) {
    throw new Error("P-256: unexpected public key length");
  }
  const xy = uncompressed.subarray(1); // strip 0x04
  return { privateKey: secretKey, publicKey: new Uint8Array(xy) };
};

/**
 * Compute the ECDH shared secret with a peer whose public key is the 64-byte
 * raw X||Y encoding. Returns the 32-byte X coordinate of the resulting point
 * (the standard Mesh shared secret).
 */
export const computeSharedSecret = (
  privateKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array => {
  if (peerPublicKey.length !== 64) {
    throw new Error(`P-256 peer public key must be 64 bytes (X||Y), got ${peerPublicKey.length}`);
  }
  const withPrefix = new Uint8Array(65);
  withPrefix[0] = 0x04;
  withPrefix.set(peerPublicKey, 1);
  // compressed=true returns 33-byte SEC1 (prefix 0x02/0x03 || X); strip the
  // prefix to yield the 32-byte X coordinate, which is the Mesh shared secret.
  const compressed = p256.getSharedSecret(privateKey, withPrefix, true);
  if (compressed.length !== 33) {
    throw new Error(`P-256 shared secret: unexpected length ${compressed.length}`);
  }
  return new Uint8Array(compressed.subarray(1));
};
