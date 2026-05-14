import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  aesCcmDecrypt,
  aesCcmEncrypt,
  applicationNonce,
  cmac,
  computeSharedSecret,
  crc8,
  deviceNonce,
  generateKeyPair,
  k1,
  k2,
  k3,
  k4,
  networkNonce,
  proxyNonce,
  s1,
} from "../src/crypto/index.ts";

// ---- helpers --------------------------------------------------------------

const hex = (u8: Uint8Array): string =>
  Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (s: string): Uint8Array => {
  const clean = s.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error(`bad hex length: ${clean}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
};

// ---- AES-CMAC (RFC 4493 §4) -----------------------------------------------

const CMAC_KEY = fromHex("2b7e151628aed2a6abf7158809cf4f3c");

test("CMAC: empty message vector (RFC 4493)", () => {
  expect(hex(cmac(CMAC_KEY, new Uint8Array(0)))).toBe("bb1d6929e95937287fa37d129b756746");
});

test("CMAC: 16-byte message vector (RFC 4493)", () => {
  const msg = fromHex("6bc1bee22e409f96e93d7e117393172a");
  expect(hex(cmac(CMAC_KEY, msg))).toBe("070a16b46b4d4144f79bdd9dd04a287c");
});

test("CMAC: 40-byte message vector (RFC 4493)", () => {
  // Validates the multi-block, padded-final-block path.
  const msg = fromHex(
    "6bc1bee22e409f96e93d7e117393172a" + "ae2d8a571e03ac9c9eb76fac45af8e51" + "30c81c46a35ce411",
  );
  expect(hex(cmac(CMAC_KEY, msg))).toBe("dfa66747de9ae63030ca32611497c827");
});

test("CMAC: 64-byte message vector (RFC 4493)", () => {
  // Validates the complete-final-block path (no 0x80 padding).
  const msg = fromHex(
    "6bc1bee22e409f96e93d7e117393172a" +
      "ae2d8a571e03ac9c9eb76fac45af8e51" +
      "30c81c46a35ce411e5fbc1191a0a52ef" +
      "f69f2445df4f9b17ad2b417be66c3710",
  );
  expect(hex(cmac(CMAC_KEY, msg))).toBe("51f0bebf7e3b9d92fc49741779363cfe");
});

// ---- Mesh Profile §8.1.1 (and §3.8.6) sample-data vectors -----------------

test("s1('test') matches Mesh Profile §8.1.1 sample data", () => {
  expect(hex(s1(new TextEncoder().encode("test")))).toBe("b73cefbd641ef2ea598c2b6efb62f79c");
});

test("k1 matches Mesh Profile §8.1.1 sample data", () => {
  const n = fromHex("3216d1509884b533248541792b877f98");
  const salt = fromHex("2ba14ffa0df84a2831938d57d276cab4");
  const p = fromHex("5a09d60797eeb4478aada59db3352a0d");
  expect(hex(k1(n, salt, p))).toBe("f6ed15a8934afbe7d83e8dcb57fcf5d7");
});

test("k2 matches Mesh Profile §8.1.1 sample data (P = 0x00)", () => {
  const n = fromHex("f7a2a44f8e8a8029064f173ddc1e2b00");
  const result = k2(n, Uint8Array.of(0x00));
  expect(result.nid).toBe(0x7f);
  expect(hex(result.encryptionKey)).toBe("9f589181a0f50de73c8070c7a6d27f46");
  expect(hex(result.privacyKey)).toBe("4c715bd4a64b938f99b453351653124f");
});

test("k3 matches Mesh Profile §8.1.1 sample data", () => {
  const n = fromHex("f7a2a44f8e8a8029064f173ddc1e2b00");
  expect(hex(k3(n))).toBe("ff046958233db014");
});

test("k4 matches Mesh Profile §8.1.1 sample data", () => {
  const n = fromHex("3216d1509884b533248541792b877f98");
  expect(k4(n)).toBe(0x38);
});

// Cross-check against the Python reference's k3 doctest, which uses a
// different NetKey than the Mesh Profile sample data above.
test("k3 cross-check against godox-ul60bi-bt doctest", () => {
  const n = fromHex("98b2e7ef8211c6deca2401adbe52e715");
  expect(hex(k3(n))).toBe("76d34c230a1a7b01");
});

test("k4 cross-check against godox-ul60bi-bt doctest", () => {
  const n = fromHex("fa0a2c615756eca3f896ce061ed4d890");
  expect(k4(n)).toBe(49);
});

// ---- AES-CCM round trip ---------------------------------------------------

test("AES-CCM round-trips short plaintext with 4-byte MIC", () => {
  const key = new Uint8Array(16);
  const nonce = new Uint8Array(13);
  const pt = new TextEncoder().encode("abc");
  const ct = aesCcmEncrypt(key, nonce, pt, 4);
  expect(ct.length).toBe(pt.length + 4);
  expect(aesCcmDecrypt(key, nonce, ct, 4)).toEqual(pt);
});

test("AES-CCM round-trips with associated data and 8-byte MIC", () => {
  const key = fromHex("404142434445464748494a4b4c4d4e4f");
  const nonce = fromHex("1011121314151617");
  const aad = fromHex("0001020304050607");
  const pt = fromHex("20212223");
  const ct = aesCcmEncrypt(key, nonce, pt, 8, aad);
  expect(aesCcmDecrypt(key, nonce, ct, 8, aad)).toEqual(pt);
});

test("AES-CCM decrypt rejects a tampered MIC", () => {
  const key = new Uint8Array(16);
  const nonce = new Uint8Array(13);
  const ct = aesCcmEncrypt(key, nonce, new TextEncoder().encode("abc"), 4);
  ct[ct.length - 1] ^= 0x01;
  expect(() => aesCcmDecrypt(key, nonce, ct, 4)).toThrow();
});

// ---- Godox CRC-8 ----------------------------------------------------------

test("CRC-8 matches Python doctest", () => {
  // checksum(bytes.fromhex("fe00ffffffffff")) == 127
  expect(crc8(fromHex("fe00ffffffffff"))).toBe(127);
});

test("CRC-8 of empty input is 0", () => {
  expect(crc8(new Uint8Array(0))).toBe(0);
});

test("CRC-8 reproduces the trailing byte of every captured V2 payload", () => {
  const fixturesDir = join(import.meta.dirname, "fixtures", "set");
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(fixturesDir, f), "utf8")) as {
      godox_v2_payload_hex: string;
    };
    const payload = fromHex(data.godox_v2_payload_hex);
    expect(payload.length).toBe(8);
    const body = payload.subarray(0, 7);
    const expectedCrc = payload[7]!;
    expect(crc8(body)).toBe(expectedCrc);
  }
});

// ---- Mesh nonce builders (§3.8.5) -----------------------------------------

test("networkNonce packs fields per Mesh §3.8.5.1", () => {
  // Type=0x00 | CTL/TTL | SEQ(3) | SRC(2) | 0x0000 | IVIndex(4)
  const n = networkNonce({ ctl: 0, ttl: 10, seq: 1, src: 0x0001, ivIndex: 0 });
  // 0x00 | 0x0a | 00 00 01 | 00 01 | 00 00 | 00 00 00 00 = 13 bytes
  expect(hex(n)).toBe("000a0000010001000000000000");
  expect(n.length).toBe(13);
});

test("networkNonce: CTL=1, TTL=0x7f, larger SEQ/SRC/IV", () => {
  const n = networkNonce({
    ctl: 1,
    ttl: 0x7f,
    seq: 0x010203,
    src: 0x1234,
    ivIndex: 0xaabbccdd,
  });
  expect(hex(n)).toBe("00ff01020312340000aabbccdd");
});

test("applicationNonce packs fields per Mesh §3.8.5.2", () => {
  // Type=0x01 | ASZMIC<<7 | SEQ(3) | SRC(2) | DST(2) | IVIndex(4)
  const n = applicationNonce({
    aszmic: 0,
    seq: 1,
    src: 0x0001,
    dst: 0x0002,
    ivIndex: 0,
  });
  expect(hex(n)).toBe("01000000010001000200000000");
  expect(n.length).toBe(13);
});

test("applicationNonce: ASZMIC=1 sets bit 7 of octet 1", () => {
  const n = applicationNonce({
    aszmic: 1,
    seq: 0xabcdef,
    src: 0xdead,
    dst: 0xbeef,
    ivIndex: 0x12345678,
  });
  expect(hex(n)).toBe("0180abcdefdeadbeef12345678");
});

test("deviceNonce packs fields per Mesh §3.8.5.3", () => {
  // Type=0x02 | ASZMIC<<7 | SEQ(3) | SRC(2) | DST(2) | IVIndex(4)
  const n = deviceNonce({
    aszmic: 0,
    seq: 1,
    src: 0x0001,
    dst: 0x0002,
    ivIndex: 0,
  });
  expect(hex(n)).toBe("02000000010001000200000000");
});

test("proxyNonce packs fields per Mesh §3.8.5.4", () => {
  // Type=0x03 | 0x00 | SEQ(3) | SRC(2) | 0x0000 | IVIndex(4)
  const n = proxyNonce({ seq: 1, src: 0x0001, ivIndex: 0 });
  expect(hex(n)).toBe("03000000010001000000000000");
});

test("nonce builders reject out-of-range values", () => {
  expect(() => networkNonce({ ctl: 2, ttl: 0, seq: 0, src: 0, ivIndex: 0 })).toThrow();
  expect(() => networkNonce({ ctl: 0, ttl: 128, seq: 0, src: 0, ivIndex: 0 })).toThrow();
  expect(() =>
    applicationNonce({ aszmic: 0, seq: 0x1000000, src: 0, dst: 0, ivIndex: 0 }),
  ).toThrow();
  expect(() => applicationNonce({ aszmic: 0, seq: 0, src: 0x10000, dst: 0, ivIndex: 0 })).toThrow();
});

// ---- P-256 ECDH round trip ------------------------------------------------

test("P-256 ECDH: both sides derive the same shared secret", () => {
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  expect(alice.publicKey.length).toBe(64);
  expect(bob.publicKey.length).toBe(64);
  expect(alice.privateKey.length).toBe(32);

  const s1AB = computeSharedSecret(alice.privateKey, bob.publicKey);
  const s1BA = computeSharedSecret(bob.privateKey, alice.publicKey);
  expect(s1AB.length).toBe(32);
  expect(s1BA.length).toBe(32);
  expect(hex(s1AB)).toBe(hex(s1BA));
});

test("P-256 ECDH: rejects a peer public key with wrong length", () => {
  const alice = generateKeyPair();
  expect(() => computeSharedSecret(alice.privateKey, new Uint8Array(32))).toThrow();
});
