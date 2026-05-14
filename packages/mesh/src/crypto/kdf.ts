// Bluetooth Mesh Profile v1.0.1 §3.8.6 key derivation functions.
//
// s1, k1, k2, k3, k4 are all defined in terms of AES-CMAC.

import { cmac } from "./cmac.ts";

const ZERO_KEY = new Uint8Array(16);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/** Mesh `s1` salt: `s1(M) = AES-CMAC(ZERO, M)`. */
export const s1 = (message: Uint8Array): Uint8Array => cmac(ZERO_KEY, message);

/**
 * Mesh `k1` key derivation:
 * `T  = AES-CMAC(SALT, N)`; `k1 = AES-CMAC(T, P)`.
 */
export const k1 = (n: Uint8Array, salt: Uint8Array, p: Uint8Array): Uint8Array => {
  const t = cmac(salt, n);
  return cmac(t, p);
};

export interface K2Result {
  readonly nid: number;
  readonly encryptionKey: Uint8Array;
  readonly privacyKey: Uint8Array;
}

/**
 * Mesh `k2` key derivation. Produces NID (7-bit), 16-byte EncryptionKey, and
 * 16-byte PrivacyKey from a 16-byte NetKey `n` and parameter `p` (usually
 * `0x00` for Network PDU encryption).
 */
export const k2 = (n: Uint8Array, p: Uint8Array): K2Result => {
  const salt = cmac(ZERO_KEY, utf8("smk2"));
  const t = cmac(salt, n);
  const t1 = cmac(t, concat(p, Uint8Array.of(0x01)));
  const t2 = cmac(t, concat(t1, p, Uint8Array.of(0x02)));
  const t3 = cmac(t, concat(t2, p, Uint8Array.of(0x03)));
  return {
    nid: t1[15]! & 0x7f,
    encryptionKey: t2,
    privacyKey: t3,
  };
};

/** Mesh `k3` Network ID derivation: returns the lower 8 bytes of `AES-CMAC(T, "id64" || 0x01)`. */
export const k3 = (n: Uint8Array): Uint8Array => {
  const salt = cmac(ZERO_KEY, utf8("smk3"));
  const t = cmac(salt, n);
  const t2 = cmac(t, concat(utf8("id64"), Uint8Array.of(0x01)));
  return t2.subarray(8);
};

/** Mesh `k4` AID derivation: returns the lower 6 bits of `AES-CMAC(T, "id6" || 0x01)[15]`. */
export const k4 = (n: Uint8Array): number => {
  const salt = cmac(ZERO_KEY, utf8("smk4"));
  const t = cmac(salt, n);
  const t2 = cmac(t, concat(utf8("id6"), Uint8Array.of(0x01)));
  return t2[15]! & 0x3f;
};
