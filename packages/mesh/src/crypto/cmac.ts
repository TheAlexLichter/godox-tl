// AES-CMAC implementation per RFC 4493.
//
// The underlying AES block primitive is Node's built-in AES-128-CBC with a
// zero IV: feeding the prepared blocks through CBC produces the running CMAC
// state for free, since CBC XORs the previous ciphertext into the next
// plaintext (which is exactly the CMAC chain). Subkey derivation (K1/K2) and
// the last-block padding/XOR are implemented in TypeScript per the RFC.

import { createCipheriv } from "node:crypto";

const BLOCK_SIZE = 16;
const RB = 0x87;
const ZERO_IV = new Uint8Array(BLOCK_SIZE);

const aesCbcEncryptZeroIv = (key: Uint8Array, data: Uint8Array): Buffer => {
  const cipher = createCipheriv("aes-128-cbc", key, ZERO_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

/** Left-shift a 16-byte big-endian block by one bit; conditionally XOR Rb on overflow. */
const leftShiftOne = (block: Uint8Array): Uint8Array => {
  const out = new Uint8Array(BLOCK_SIZE);
  let overflow = 0;
  for (let i = BLOCK_SIZE - 1; i >= 0; i--) {
    const b = block[i]!;
    out[i] = ((b << 1) & 0xff) | overflow;
    overflow = (b & 0x80) >> 7;
  }
  if (overflow !== 0) {
    out[BLOCK_SIZE - 1] = (out[BLOCK_SIZE - 1]! ^ RB) & 0xff;
  }
  return out;
};

const deriveSubkeys = (key: Uint8Array): { k1: Uint8Array; k2: Uint8Array } => {
  const l = aesCbcEncryptZeroIv(key, new Uint8Array(BLOCK_SIZE));
  const k1 = leftShiftOne(l);
  const k2 = leftShiftOne(k1);
  return { k1, k2 };
};

/**
 * AES-CMAC of `message` under `key`.
 *
 * @param key - 16-byte AES key.
 * @param message - Message of any length.
 * @returns 16-byte authentication tag.
 */
export const cmac = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  const { k1, k2 } = deriveSubkeys(key);

  const msgLen = message.length;
  const complete = msgLen > 0 && msgLen % BLOCK_SIZE === 0;
  const nBlocks = complete ? msgLen / BLOCK_SIZE : Math.floor(msgLen / BLOCK_SIZE) + 1;

  // Build a contiguous buffer of nBlocks * 16 bytes. The final block is the
  // padded message block XORed with K1 (complete) or K2 (incomplete).
  const buf = new Uint8Array(nBlocks * BLOCK_SIZE);
  buf.set(message.subarray(0, (nBlocks - 1) * BLOCK_SIZE), 0);
  const lastStart = (nBlocks - 1) * BLOCK_SIZE;
  if (complete) {
    for (let i = 0; i < BLOCK_SIZE; i++) {
      buf[lastStart + i] = message[lastStart + i]! ^ k1[i]!;
    }
  } else {
    const tail = message.subarray(lastStart);
    buf.set(tail, lastStart);
    buf[lastStart + tail.length] = 0x80;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      buf[lastStart + i] = buf[lastStart + i]! ^ k2[i]!;
    }
  }

  // CBC with zero IV emits the running CMAC chain; the last ciphertext block
  // is the CMAC tag.
  const ct = aesCbcEncryptZeroIv(key, buf);
  return new Uint8Array(ct.subarray(ct.length - BLOCK_SIZE));
};
