// Unit tests for the PB-GATT provisioning state machine. Real-hardware
// integration is gated behind MESH_HARDWARE_AVAILABLE=1 so CI never tries
// to drive a physical light.

import { Chunk, Effect, Exit, Fiber, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { aesCcmDecrypt, aesCcmEncrypt } from "../src/crypto/aes.ts";
import { cmac } from "../src/crypto/cmac.ts";
import { k1, s1 } from "../src/crypto/kdf.ts";
import { ConfirmationMismatchError, ProvisioningError } from "../src/provisioning/errors.ts";
import {
  decodeProvisioningPdu,
  DEFAULT_PB_GATT_MTU,
  encodeProvisioningPdu,
} from "../src/provisioning/pbGatt.ts";
import {
  PDU_CAPABILITIES,
  PDU_COMPLETE,
  PDU_CONFIRMATION,
  PDU_DATA,
  PDU_INVITE,
  PDU_PUBLIC_KEY,
  PDU_RANDOM,
  PDU_START,
} from "../src/provisioning/pdus.ts";
import {
  buildConfirmationInputs,
  buildProvisioningDataPlaintext,
  computeConfirmation,
  runProvisioning,
} from "../src/provisioning/session.ts";
import type { ProxyConnection } from "../src/ble/types.ts";
import type { BleError } from "../src/ble/errors.ts";

const hardwareAvailable = process.env.MESH_HARDWARE_AVAILABLE === "1";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
};

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

// --- Confirmation derivation ---------------------------------------------

test("computeConfirmation: matches k1(prck)+CMAC(random||zeros) hand-rolled chain", () => {
  // Deterministic, non-pathological inputs.
  const ecdhSecret = fromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
  const confirmationSalt = fromHex("aabbccddeeff00112233445566778899");
  const random = fromHex("0102030405060708090a0b0c0d0e0f10");

  const confirmationKey = k1(ecdhSecret, confirmationSalt, utf8("prck"));
  const authValue = new Uint8Array(16);
  const expected = cmac(confirmationKey, concat(random, authValue));

  const actual = computeConfirmation({ ecdhSecret, confirmationSalt, random });
  expect(toHex(actual)).toBe(toHex(expected));
  // The output must always be 16 bytes of CMAC.
  expect(actual).toHaveLength(16);
});

test("computeConfirmation: depends on every input (random change → different output)", () => {
  const ecdhSecret = new Uint8Array(32).fill(0x11);
  const confirmationSalt = new Uint8Array(16).fill(0x22);
  const a = computeConfirmation({
    ecdhSecret,
    confirmationSalt,
    random: new Uint8Array(16).fill(0x33),
  });
  const b = computeConfirmation({
    ecdhSecret,
    confirmationSalt,
    random: new Uint8Array(16).fill(0x44),
  });
  expect(toHex(a)).not.toBe(toHex(b));
});

// --- ConfirmationInputs layout --------------------------------------------

test("buildConfirmationInputs: concatenates inputs to exactly 145 bytes in the right order", () => {
  const invite = Uint8Array.of(0x00);
  const caps = new Uint8Array(11).fill(0xaa);
  const start = new Uint8Array(5).fill(0xbb);
  const provPub = new Uint8Array(64).fill(0xcc);
  const devPub = new Uint8Array(64).fill(0xdd);
  const result = buildConfirmationInputs({
    invitePayload: invite,
    capabilitiesPayload: caps,
    startPayload: start,
    provisionerPublicKey: provPub,
    devicePublicKey: devPub,
  });
  expect(result).toHaveLength(145);
  expect(result[0]).toBe(0x00);
  expect(result[1]).toBe(0xaa);
  expect(result[11]).toBe(0xaa);
  expect(result[12]).toBe(0xbb);
  expect(result[16]).toBe(0xbb);
  expect(result[17]).toBe(0xcc);
  expect(result[80]).toBe(0xcc);
  expect(result[81]).toBe(0xdd);
  expect(result[144]).toBe(0xdd);
});

// --- Provisioning data plaintext layout ----------------------------------

test("buildProvisioningDataPlaintext: 25-byte layout is netKey||keyIndex||flags||ivIndex||unicast", () => {
  const networkKey = fromHex("0123456789abcdef0123456789abcdef");
  const plaintext = buildProvisioningDataPlaintext({
    networkKey,
    keyIndex: 0,
    flags: 0,
    ivIndex: 0,
    unicastAddress: 0x0002,
  });
  expect(plaintext).toHaveLength(25);
  expect(toHex(plaintext.subarray(0, 16))).toBe(toHex(networkKey));
  // key index 0 as 2 BE bytes
  expect(plaintext[16]).toBe(0x00);
  expect(plaintext[17]).toBe(0x00);
  // flags
  expect(plaintext[18]).toBe(0x00);
  // iv index 0 as 4 BE bytes
  expect(toHex(plaintext.subarray(19, 23))).toBe("00000000");
  // unicast address 0x0002 BE
  expect(plaintext[23]).toBe(0x00);
  expect(plaintext[24]).toBe(0x02);
});

test("buildProvisioningDataPlaintext: encodes a non-trivial unicast + ivIndex correctly", () => {
  const networkKey = new Uint8Array(16).fill(0x77);
  const plaintext = buildProvisioningDataPlaintext({
    networkKey,
    keyIndex: 0x0a5,
    flags: 0x01,
    ivIndex: 0x12345678,
    unicastAddress: 0x1234,
  });
  expect(plaintext[16]).toBe(0x00);
  expect(plaintext[17]).toBe(0xa5);
  expect(plaintext[18]).toBe(0x01);
  expect(toHex(plaintext.subarray(19, 23))).toBe("12345678");
  expect(plaintext[23]).toBe(0x12);
  expect(plaintext[24]).toBe(0x34);
});

// --- AES-CCM round-trip on provisioning data ------------------------------

test("AES-CCM round-trip on provisioning data plaintext returns the original bytes", () => {
  const sessionKey = new Uint8Array(16).fill(0x42);
  const sessionNonce = new Uint8Array(13).fill(0x69);
  const plaintext = buildProvisioningDataPlaintext({
    networkKey: new Uint8Array(16).fill(0xa5),
    keyIndex: 0,
    flags: 0,
    ivIndex: 0,
    unicastAddress: 0x0002,
  });
  const encrypted = aesCcmEncrypt(sessionKey, sessionNonce, plaintext, 8);
  expect(encrypted).toHaveLength(33); // 25 + 8 MIC
  const decrypted = aesCcmDecrypt(sessionKey, sessionNonce, encrypted, 8);
  expect(toHex(decrypted)).toBe(toHex(plaintext));
});

// --- PB-GATT framing ------------------------------------------------------

test("encodeProvisioningPdu: short PDUs emit a single SAR=0 frame", () => {
  const pdu = Uint8Array.of(PDU_INVITE, 0x00); // Invite(attention=0)
  const frames = encodeProvisioningPdu(pdu);
  expect(frames).toHaveLength(1);
  // header = (0 << 6) | 0x03 = 0x03
  expect(frames[0]![0]).toBe(0x03);
  expect(toHex(frames[0]!.subarray(1))).toBe(toHex(pdu));
});

test("encodeProvisioningPdu: long PDUs are segmented with SAR first/continuation/last", () => {
  // A 65-byte PDU split with MTU=20 → 19-byte payload per frame.
  const pdu = new Uint8Array(65).map((_, i) => i & 0xff);
  const frames = encodeProvisioningPdu(pdu, DEFAULT_PB_GATT_MTU);
  // ceil(65/19) = 4 frames
  expect(frames).toHaveLength(4);
  // SAR=1 (first), SAR=2 (continuation x2), SAR=3 (last)
  // header = (sar << 6) | 0x03
  expect(frames[0]![0]).toBe(0x43); // (1 << 6) | 0x03
  expect(frames[1]![0]).toBe(0x83); // (2 << 6) | 0x03
  expect(frames[2]![0]).toBe(0x83);
  expect(frames[3]![0]).toBe(0xc3); // (3 << 6) | 0x03

  // Reassemble payloads and check they match the original.
  const reassembled = concat(...frames.map((f) => f.subarray(1)));
  expect(toHex(reassembled)).toBe(toHex(pdu));
});

test("decodeProvisioningPdu: reassembles a multi-segment PDU", async () => {
  const original = new Uint8Array(50).map((_, i) => (i * 7) & 0xff);
  const frames = encodeProvisioningPdu(original, DEFAULT_PB_GATT_MTU);
  expect(frames.length).toBeGreaterThan(1);

  const stream = Stream.fromChunk(Chunk.fromIterable(frames as ReadonlyArray<Uint8Array>));
  const decoded = await Effect.runPromise(decodeProvisioningPdu(stream, "invite"));
  expect(toHex(decoded)).toBe(toHex(original));
});

test("decodeProvisioningPdu: ignores frames with the wrong message type", async () => {
  // SAR=0, MessageType=0 (Network PDU) — not a provisioning frame, must drop.
  const noise = Uint8Array.of(0x00, 0xde, 0xad, 0xbe, 0xef);
  const real = encodeProvisioningPdu(Uint8Array.of(PDU_COMPLETE))[0]!;
  const stream = Stream.fromChunk(Chunk.fromIterable([noise, real]));
  const decoded = await Effect.runPromise(decodeProvisioningPdu(stream, "complete"));
  expect(toHex(decoded)).toBe(toHex(Uint8Array.of(PDU_COMPLETE)));
});

test("decodeProvisioningPdu: fails if the stream ends with no PDU", async () => {
  const stream = Stream.fromChunk(Chunk.empty<Uint8Array>());
  const exit = await Effect.runPromiseExit(decodeProvisioningPdu(stream, "capabilities"));
  expect(exit._tag).toBe("Failure");
});

// --- State-machine happy path against a fake connection ------------------

/** A scriptable proxy connection that captures writes and emits notifications on demand. */
class FakeConnection {
  readonly address = "fake-light";
  readonly writes: Uint8Array[] = [];
  private resumeEmit: ((bytes: Uint8Array) => void) | undefined;
  private pending: Uint8Array[] = [];

  readonly notifications: Stream.Stream<Uint8Array, BleError> = Stream.async<Uint8Array, BleError>(
    (emit) => {
      this.resumeEmit = (bytes) => {
        void emit.single(bytes);
      };
      for (const b of this.pending) this.resumeEmit(b);
      this.pending.length = 0;
      return Effect.sync(() => {
        this.resumeEmit = undefined;
      });
    },
  );

  write = (pdu: Uint8Array): Effect.Effect<void, BleError> =>
    Effect.sync(() => {
      this.writes.push(new Uint8Array(pdu));
    });

  /** Push a frame so the next `decodeProvisioningPdu` call resolves with it. */
  emit(frame: Uint8Array): void {
    if (this.resumeEmit) this.resumeEmit(frame);
    else this.pending.push(frame);
  }
}

test("runProvisioning: walks the full happy path in order against a fake bearer", async () => {
  const fake = new FakeConnection();

  // Pre-stage all of the device's PDU responses. Each one is wrapped in a
  // PB-GATT SAR=0 frame, which `decodeProvisioningPdu` will reassemble.
  const frameOf = (pdu: Uint8Array): Uint8Array => encodeProvisioningPdu(pdu, 256)[0]!;

  // Capabilities: numElements=2, everything else zero. The state machine
  // will use the raw 11-byte payload verbatim for ConfirmationInputs.
  const capsPayload = new Uint8Array(11);
  capsPayload[0] = 0x02;
  capsPayload[1] = 0x00; // algorithms BE
  capsPayload[2] = 0x01; // FIPS P-256 = bit 0
  const capabilitiesPdu = concat(Uint8Array.of(PDU_CAPABILITIES), capsPayload);

  // Synthetic device public key — does not need to be on the curve since
  // the state machine just hands it to `computeSharedSecret`. We pick a
  // valid-looking 64-byte buffer that the curves lib will accept.
  // Instead, generate a fresh peer key via the same primitive so the
  // shared-secret call doesn't reject it.
  const { generateKeyPair } = await import("../src/crypto/ecdh.ts");
  const peer = generateKeyPair();
  const devicePublicKeyPdu = concat(Uint8Array.of(PDU_PUBLIC_KEY), peer.publicKey);

  // We don't know what the provisioner will generate, so we'll plan to
  // echo a confirmation/random pair that the verifier will accept. The
  // verifier uses the ecdhSecret + confirmationSalt + ourRandom, so we
  // need to know those values. Approach: drive the exchange end-to-end
  // with predictable provisioner randomness by stubbing `randomBytes`
  // through Node's crypto module isn't trivial here, so instead we
  // assert ordering + send a Random whose corresponding confirmation we
  // compute *after* observing the provisioner's writes.

  // The state machine subscribes to notifications fresh for each PDU
  // read (each `runFoldWhile` opens its own subscription, and any
  // unconsumed emissions are discarded when the subscription ends).
  // So we deliver one response at a time, after each provisioner write.

  const program = runProvisioning(fake as unknown as ProxyConnection, {
    networkKey: new Uint8Array(16).fill(0xab),
    appKey: new Uint8Array(16).fill(0xcd),
    nodeAddress: 0x0002,
    mtu: 256, // single-frame writes so the test can pluck PDU types by index
  });

  const fiber = Effect.runFork(program);

  const waitForWrites = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timeout waiting for predicate");
  };

  // After write #1 (Invite), deliver Capabilities.
  await waitForWrites(() => fake.writes.length >= 1);
  fake.emit(frameOf(capabilitiesPdu));

  // After writes #2+#3 (Start, PublicKey), deliver device PublicKey.
  await waitForWrites(() => fake.writes.length >= 3);
  fake.emit(frameOf(devicePublicKeyPdu));

  // After write #4 (provisioner Confirmation), we can read the provisioner
  // public key from write #3 to compute matching crypto.
  await waitForWrites(() => fake.writes.length >= 4);

  // Extract the provisioner's public key from write #2 (PublicKey PDU).
  // PB-GATT frame layout: [proxyHeader(0x03)][pduType(0x03)][...64 bytes]
  const provPublicKey = fake.writes[2]!.subarray(2);
  expect(provPublicKey).toHaveLength(64);

  // Now compute the same ECDH secret + confirmation salt the state
  // machine just computed, using the *peer* private key so we can craft
  // valid confirmation/random PDUs.
  const { computeSharedSecret } = await import("../src/crypto/ecdh.ts");
  const ecdhSecret = computeSharedSecret(peer.privateKey, provPublicKey);

  const confirmationInputs = buildConfirmationInputs({
    invitePayload: Uint8Array.of(0x00),
    capabilitiesPayload: capsPayload,
    startPayload: Uint8Array.of(0, 0, 0, 0, 0),
    provisionerPublicKey: provPublicKey,
    devicePublicKey: peer.publicKey,
  });
  const confirmationSalt = s1(confirmationInputs);

  // Pick any deterministic device random; compute matching confirmation.
  const deviceRandom = new Uint8Array(16).map((_, i) => 0x40 + i);
  const deviceConfirmation = computeConfirmation({
    ecdhSecret,
    confirmationSalt,
    random: deviceRandom,
  });

  fake.emit(frameOf(concat(Uint8Array.of(PDU_CONFIRMATION), deviceConfirmation)));

  // Wait for the provisioner's Random write (#4).
  await waitForWrites(() => fake.writes.length >= 5);

  fake.emit(frameOf(concat(Uint8Array.of(PDU_RANDOM), deviceRandom)));

  // Wait for the Data write (#5) then deliver Complete.
  await waitForWrites(() => fake.writes.length >= 6);

  fake.emit(frameOf(Uint8Array.of(PDU_COMPLETE)));

  const result = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isSuccess(result)).toBe(true);
  if (!Exit.isSuccess(result)) return;

  // Assert the right PDU types fired in order.
  // Each write is a single SAR=0 frame, so byte 1 is the PDU type.
  const writtenPduTypes = fake.writes.map((w) => w[1]);
  expect(writtenPduTypes).toEqual([
    PDU_INVITE,
    PDU_START,
    PDU_PUBLIC_KEY,
    PDU_CONFIRMATION,
    PDU_RANDOM,
    PDU_DATA,
  ]);

  // Result sanity checks.
  const value = result.value;
  expect(value.networkKey).toHaveLength(16);
  expect(value.appKey).toHaveLength(16);
  expect(value.deviceKey).toHaveLength(16);
  expect(value.nodeAddress).toBe(0x0002);
  expect(value.provisionerAddress).toBe(0x0001);
  expect(value.ivIndex).toBe(0);
  expect(value.sequenceNumber).toBe(0);
});

test("runProvisioning: rejects a bogus device confirmation with ConfirmationMismatchError", async () => {
  const fake = new FakeConnection();
  const frameOf = (pdu: Uint8Array): Uint8Array => encodeProvisioningPdu(pdu, 256)[0]!;

  const capsPayload = new Uint8Array(11);
  capsPayload[0] = 0x01;
  capsPayload[2] = 0x01;

  const { generateKeyPair } = await import("../src/crypto/ecdh.ts");
  const peer = generateKeyPair();

  const fiber = Effect.runFork(
    runProvisioning(fake as unknown as ProxyConnection, {
      networkKey: new Uint8Array(16).fill(0xab),
      nodeAddress: 0x0002,
      mtu: 256,
    }),
  );

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timeout");
  };

  // Drip-feed device responses after each provisioner write.
  await waitFor(() => fake.writes.length >= 1);
  fake.emit(frameOf(concat(Uint8Array.of(PDU_CAPABILITIES), capsPayload)));
  await waitFor(() => fake.writes.length >= 3);
  fake.emit(frameOf(concat(Uint8Array.of(PDU_PUBLIC_KEY), peer.publicKey)));
  // Wait for the provisioner's Confirmation write, then send a bogus
  // device Confirmation + Random pair that the verifier must reject.
  await waitFor(() => fake.writes.length >= 4);
  fake.emit(frameOf(concat(Uint8Array.of(PDU_CONFIRMATION), new Uint8Array(16).fill(0xff))));
  await waitFor(() => fake.writes.length >= 5);
  fake.emit(frameOf(concat(Uint8Array.of(PDU_RANDOM), new Uint8Array(16).fill(0x11))));

  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  // Squash through cause to find the tagged error.
  const message = JSON.stringify(exit.cause);
  expect(message).toContain("ConfirmationMismatchError");
});

// --- Tag wiring sanity ----------------------------------------------------

test("ProvisioningError + ConfirmationMismatchError are properly tagged", () => {
  const e1 = new ProvisioningError({ stage: "invite", message: "boom" });
  expect(e1._tag).toBe("ProvisioningError");
  expect(e1.stage).toBe("invite");
  const e2 = new ConfirmationMismatchError({ expected: "00", actual: "ff" });
  expect(e2._tag).toBe("ConfirmationMismatchError");
});

// --- Hardware path (skipped by default) ----------------------------------

test.skipIf(!hardwareAvailable)(
  "provisionLight: provisions a real factory-reset light (requires MESH_HARDWARE_AVAILABLE=1)",
  async () => {
    // Address must be supplied via env in the real run.
    const address = process.env.MESH_HARDWARE_ADDRESS;
    if (!address) throw new Error("MESH_HARDWARE_ADDRESS must be set for the hardware test");
    const { provisionLight } = await import("../src/provisioning/session.ts");
    const result = await Effect.runPromise(Effect.scoped(provisionLight(address)));
    expect(result.networkKey).toHaveLength(16);
    expect(result.deviceKey).toHaveLength(16);
    expect(result.nodeAddress).toBeGreaterThanOrEqual(1);
  },
);
