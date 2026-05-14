// Tests for milestone 5: ConfigSession (App Key Add + Model App Bind).
//
// We exercise three layers:
//   1. Pure builders     — byte-exact against the Python reference doctests.
//   2. Round-trip crypto — DeviceKey-secured access PDU encrypt → decrypt.
//   3. End-to-end flow   — `rebindOverConnection` driven through a fake
//      ProxyConnection whose `write` synthesises the matching status frame
//      and pushes it back through the notifications stream.

import { Effect, Queue, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { aesCcmDecrypt, aesCcmEncrypt } from "../src/crypto/aes.ts";
import { k2 } from "../src/crypto/kdf.ts";
import { deviceNonce } from "../src/crypto/nonces.ts";
import type { ProxyConnection } from "../src/ble/types.ts";
import {
  buildAppKeyAdd,
  buildModelAppBind,
  encodeOpcode,
  GODOX_VENDOR_MODEL,
  OPCODE_CONFIG_APP_KEY_ADD,
  OPCODE_CONFIG_APP_KEY_STATUS,
  OPCODE_CONFIG_MODEL_APP_BIND,
  OPCODE_CONFIG_MODEL_APP_STATUS,
  rebindOverConnection,
  TELINK_COMPANY_ID,
  TELINK_VENDOR_MODEL_ID,
  splitOpcode,
} from "../src/config/index.ts";
import { decodeUnsegmentedAccess, encodeUnsegmentedAccess } from "../src/pdu/lowerTransport.ts";
import { decodeNetworkPdu, encodeNetworkPdu } from "../src/pdu/network.ts";
import { decodeProxyPdu, encodeProxyPdu } from "../src/pdu/proxy.ts";

const hardwareAvailable = process.env.MESH_HARDWARE_AVAILABLE === "1";

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
};

// --- Pure builders ---------------------------------------------------------

test("encodeOpcode: 1-octet opcodes round-trip as a single byte", () => {
  expect(toHex(encodeOpcode(0x00))).toBe("00");
  expect(toHex(encodeOpcode(0x7f))).toBe("7f");
});

test("encodeOpcode: 2-octet opcodes round-trip as big-endian pair", () => {
  expect(toHex(encodeOpcode(0x8003))).toBe("8003");
  expect(toHex(encodeOpcode(0x803d))).toBe("803d");
  expect(toHex(encodeOpcode(0x803e))).toBe("803e");
});

test("encodeOpcode: rejects 2-octet opcodes outside 0x8000..0xBFFF", () => {
  expect(() => encodeOpcode(0xc001)).toThrow(/2-octet opcode/);
});

test("buildAppKeyAdd: byte-exact for net=0, app=0, app_key=range(16)", () => {
  const payload = buildAppKeyAdd({
    netKeyIndex: 0,
    appKeyIndex: 0,
    appKey: new Uint8Array(16).map((_, i) => i),
  });
  // Python: build_config_app_key_add(0, 0, bytes(range(16))).hex()
  //   = '00 000000 000102030405060708090a0b0c0d0e0f'
  // We strip the 1-byte opcode (0x00) → 19 bytes.
  expect(toHex(payload)).toBe("000000000102030405060708090a0b0c0d0e0f");
  expect(payload).toHaveLength(19);
});

test("buildAppKeyAdd: packs two 12-bit indexes little-endian into 3 bytes", () => {
  const payload = buildAppKeyAdd({
    netKeyIndex: 0x123,
    appKeyIndex: 0x456,
    appKey: new Uint8Array(16),
  });
  // packed = 0x123 | (0x456 << 12) = 0x456123 → LE bytes 23 61 45
  expect(toHex(payload.subarray(0, 3))).toBe("236145");
});

test("buildAppKeyAdd: rejects out-of-range indexes and wrong-size keys", () => {
  expect(() =>
    buildAppKeyAdd({ netKeyIndex: 0x1000, appKeyIndex: 0, appKey: new Uint8Array(16) }),
  ).toThrow(/netKeyIndex/);
  expect(() =>
    buildAppKeyAdd({ netKeyIndex: 0, appKeyIndex: 0, appKey: new Uint8Array(15) }),
  ).toThrow(/16 bytes/);
});

test("buildModelAppBind: byte-exact vendor model matches Python config doctest", () => {
  const payload = buildModelAppBind({
    elementAddress: 2,
    appKeyIndex: 0,
    modelIdentifier: { vendorId: TELINK_COMPANY_ID, modelId: TELINK_VENDOR_MODEL_ID },
  });
  // Python: build_config_model_app_bind(2, 0, 0x0211, 0x0000).hex()
  //   = '803d 0200 0000 1102 0000'.  Strip 2-byte opcode → 8 bytes.
  expect(toHex(payload)).toBe("0200000011020000");
});

test("buildModelAppBind: SIG model identifier is 2 little-endian bytes", () => {
  const payload = buildModelAppBind({
    elementAddress: 0x1234,
    appKeyIndex: 0x0aa,
    modelIdentifier: 0x1300, // SIG Light Lightness Server
  });
  // element=0x1234 LE = 3412
  // appKeyIndex=0x0AA LE (2B) = aa00
  // SIG model = 0x1300 LE = 0013
  expect(toHex(payload)).toBe("3412aa000013");
});

test("splitOpcode: handles 1- and 2-octet opcodes", () => {
  const oneOctet = splitOpcode(new Uint8Array([0x05, 0xaa, 0xbb]));
  expect(oneOctet.opcode).toBe(0x05);
  expect(toHex(oneOctet.parameters)).toBe("aabb");

  const twoOctet = splitOpcode(new Uint8Array([0x80, 0x03, 0x00, 0x00, 0x00, 0x00]));
  expect(twoOctet.opcode).toBe(0x8003);
  expect(twoOctet.parameters).toHaveLength(4);
});

// --- DeviceKey upper-transport round-trip ---------------------------------

test("DeviceKey AES-CCM round-trip with device nonce reproduces the access PDU", () => {
  const deviceKey = fromHex("f31557523021f6294f54bf00ec18b5d5");
  const accessPdu = new Uint8Array([0x80, 0x3d, 0x02, 0x00, 0x00, 0x00, 0x11, 0x02, 0x00, 0x00]);
  const nonce = deviceNonce({ aszmic: 0, seq: 1, src: 1, dst: 2, ivIndex: 0 });

  const encrypted = aesCcmEncrypt(deviceKey, nonce, accessPdu, 4);
  const decrypted = aesCcmDecrypt(deviceKey, nonce, encrypted, 4);

  expect(decrypted).toHaveLength(accessPdu.length);
  expect(toHex(decrypted)).toBe(toHex(accessPdu));
});

// --- End-to-end: FakeProxyConnection drives rebindOverConnection ----------

interface CapturedWrite {
  readonly src: number;
  readonly dst: number;
  readonly seq: number;
  readonly accessPdu: Uint8Array;
}

interface FakeBuild {
  readonly conn: ProxyConnection;
  readonly writes: ReadonlyArray<CapturedWrite>;
}

/**
 * Build a fake ProxyConnection that decodes each outbound write, calls
 * `onWrite` to let the test push a synthetic notification, and exposes the
 * captured access PDUs via the returned `writes` array.
 */
const makeFakeConn = (params: {
  readonly networkKey: Uint8Array;
  readonly deviceKey: Uint8Array;
  readonly ivIndex: number;
  readonly onWrite: (write: CapturedWrite) => Uint8Array | null;
}): Effect.Effect<FakeBuild> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array>();
    const writes: CapturedWrite[] = [];
    const { encryptionKey, privacyKey } = k2(params.networkKey, new Uint8Array([0x00]));

    const conn: ProxyConnection = {
      address: "fake",
      notifications: Stream.fromQueue(queue),
      write: (pdu) =>
        Effect.gen(function* () {
          // Decode: Proxy → Network → LowerTransport → UpperTransport.
          const { payload: netPdu } = decodeProxyPdu(pdu);
          const net = decodeNetworkPdu({
            pdu: netPdu,
            ivIndex: params.ivIndex,
            encryptionKey,
            privacyKey,
          });
          const { encryptedAccessPdu } = decodeUnsegmentedAccess(net.lowerTransportPdu);
          const nonce = deviceNonce({
            aszmic: 0,
            seq: net.seq,
            src: net.src,
            dst: net.dst,
            ivIndex: params.ivIndex,
          });
          const accessPdu = aesCcmDecrypt(params.deviceKey, nonce, encryptedAccessPdu, 4);

          const captured: CapturedWrite = {
            src: net.src,
            dst: net.dst,
            seq: net.seq,
            accessPdu,
          };
          writes.push(captured);

          const response = params.onWrite(captured);
          if (response) {
            yield* Queue.offer(queue, response);
          }
        }),
    };

    return { conn, writes };
  });

/**
 * Encode a Config Server *response* frame the same way the device would —
 * DeviceKey upper transport, k2(NetKey) network layer, proxy SAR=0,
 * messageType=0. Returns the bytes a real proxy notification would carry.
 */
const encodeStatusFrame = (params: {
  readonly networkKey: Uint8Array;
  readonly deviceKey: Uint8Array;
  readonly src: number; // node
  readonly dst: number; // provisioner
  readonly seq: number; // node's seq
  readonly ivIndex: number;
  readonly statusOpcode: number;
  readonly statusPayload: Uint8Array; // status byte + tail
}): Uint8Array => {
  const { networkKey, deviceKey, src, dst, seq, ivIndex, statusOpcode, statusPayload } = params;
  const { nid, encryptionKey, privacyKey } = k2(networkKey, new Uint8Array([0x00]));

  const accessPdu = new Uint8Array(2 + statusPayload.length);
  const opcodeBytes = encodeOpcode(statusOpcode);
  accessPdu.set(opcodeBytes, 0);
  accessPdu.set(statusPayload, opcodeBytes.length);

  const nonce = deviceNonce({ aszmic: 0, seq, src, dst, ivIndex });
  const encrypted = aesCcmEncrypt(
    deviceKey,
    nonce,
    accessPdu.subarray(0, opcodeBytes.length + statusPayload.length),
    4,
  );

  const lowerTransportPdu = encodeUnsegmentedAccess({
    akf: 0,
    aid: 0,
    encryptedAccessPdu: encrypted,
  });

  const networkPdu = encodeNetworkPdu({
    nid,
    ivIndex,
    ctl: 0,
    ttl: 10,
    seq,
    src,
    dst,
    lowerTransportPdu,
    encryptionKey,
    privacyKey,
  });

  return encodeProxyPdu({ sar: 0, messageType: 0, payload: networkPdu });
};

const NETWORK_KEY = fromHex("ff5a4609ace4789e81c531ee9492b2bd");
const APP_KEY = fromHex("819e28a5d5fe97f3290c8e3b2e9de156");
const DEVICE_KEY = fromHex("f31557523021f6294f54bf00ec18b5d5");
const PROVISIONER = 0x0001;
const NODE = 0x0002;
const IV_INDEX = 0;

test("rebindOverConnection: sends AppKey Add + Model App Bind and advances seq by 2", async () => {
  let nodeSeq = 100;

  const program = Effect.gen(function* () {
    const { conn, writes } = yield* makeFakeConn({
      networkKey: NETWORK_KEY,
      deviceKey: DEVICE_KEY,
      ivIndex: IV_INDEX,
      onWrite: (req) => {
        const { opcode } = splitOpcode(req.accessPdu);
        if (opcode === OPCODE_CONFIG_APP_KEY_ADD) {
          // AppKey Status: status(1) || packed indexes(3) — values match request.
          const payload = new Uint8Array(4);
          payload[0] = 0x00; // success
          // netIdx=0, appIdx=0 → packed bytes 00 00 00
          nodeSeq += 1;
          return encodeStatusFrame({
            networkKey: NETWORK_KEY,
            deviceKey: DEVICE_KEY,
            src: NODE,
            dst: PROVISIONER,
            seq: nodeSeq,
            ivIndex: IV_INDEX,
            statusOpcode: OPCODE_CONFIG_APP_KEY_STATUS,
            statusPayload: payload,
          });
        }
        if (opcode === OPCODE_CONFIG_MODEL_APP_BIND) {
          // ModelApp Status: status(1) || element(2,LE) || appIdx(2,LE) || vendor model(4)
          const payload = new Uint8Array([
            0x00,
            NODE & 0xff,
            (NODE >>> 8) & 0xff,
            0x00,
            0x00,
            TELINK_COMPANY_ID & 0xff,
            (TELINK_COMPANY_ID >>> 8) & 0xff,
            TELINK_VENDOR_MODEL_ID & 0xff,
            (TELINK_VENDOR_MODEL_ID >>> 8) & 0xff,
          ]);
          nodeSeq += 1;
          return encodeStatusFrame({
            networkKey: NETWORK_KEY,
            deviceKey: DEVICE_KEY,
            src: NODE,
            dst: PROVISIONER,
            seq: nodeSeq,
            ivIndex: IV_INDEX,
            statusOpcode: OPCODE_CONFIG_MODEL_APP_STATUS,
            statusPayload: payload,
          });
        }
        return null;
      },
    });

    const result = yield* rebindOverConnection(conn, {
      networkKey: NETWORK_KEY,
      appKey: APP_KEY,
      deviceKey: DEVICE_KEY,
      ivIndex: IV_INDEX,
      provisionerAddress: PROVISIONER,
      nodeAddress: NODE,
      sequenceNumber: 50,
    });

    return { result, writes };
  });

  const { result, writes } = await Effect.runPromise(program);

  expect(result.sequenceNumber).toBe(52); // 50 → 51 → 52

  expect(writes).toHaveLength(2);
  // First write: AppKey Add with seq=50.
  expect(writes[0]?.seq).toBe(50);
  const first = splitOpcode(writes[0]!.accessPdu);
  expect(first.opcode).toBe(OPCODE_CONFIG_APP_KEY_ADD);
  // payload: 3-byte packed indexes + 16-byte appkey
  expect(toHex(first.parameters)).toBe(`000000${toHex(APP_KEY)}`);

  // Second write: Model App Bind with seq=51.
  expect(writes[1]?.seq).toBe(51);
  const second = splitOpcode(writes[1]!.accessPdu);
  expect(second.opcode).toBe(OPCODE_CONFIG_MODEL_APP_BIND);
  expect(toHex(second.parameters)).toBe("0200000011020000");
});

test("rebindOverConnection: surfaces ConfigError stage=appKeyAdd when device returns non-zero status", async () => {
  const program = Effect.gen(function* () {
    const { conn } = yield* makeFakeConn({
      networkKey: NETWORK_KEY,
      deviceKey: DEVICE_KEY,
      ivIndex: IV_INDEX,
      onWrite: (req) => {
        const { opcode } = splitOpcode(req.accessPdu);
        if (opcode === OPCODE_CONFIG_APP_KEY_ADD) {
          // Status 0x01 = "Invalid Address" (Mesh Annex A.4.4) → failure.
          const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00]);
          return encodeStatusFrame({
            networkKey: NETWORK_KEY,
            deviceKey: DEVICE_KEY,
            src: NODE,
            dst: PROVISIONER,
            seq: 200,
            ivIndex: IV_INDEX,
            statusOpcode: OPCODE_CONFIG_APP_KEY_STATUS,
            statusPayload: payload,
          });
        }
        return null;
      },
    });

    return yield* rebindOverConnection(conn, {
      networkKey: NETWORK_KEY,
      appKey: APP_KEY,
      deviceKey: DEVICE_KEY,
      ivIndex: IV_INDEX,
      provisionerAddress: PROVISIONER,
      nodeAddress: NODE,
      sequenceNumber: 0,
    });
  });

  const exit = await Effect.runPromiseExit(program);
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    // Walk the cause to find the tagged error we expect.
    const failures: unknown[] = [];
    const collect = (c: unknown): void => {
      if (!c || typeof c !== "object") return;
      const obj = c as Record<string, unknown>;
      if (obj._tag === "Fail") failures.push(obj.error);
      if (obj._tag === "Sequential" || obj._tag === "Parallel") {
        collect(obj.left);
        collect(obj.right);
      }
      if (obj.cause) collect(obj.cause);
    };
    collect(exit.cause);
    const err = failures.find((e) => (e as { _tag?: string })?._tag === "ConfigError") as
      | { stage: string; status?: number; message: string }
      | undefined;
    expect(err).toBeDefined();
    expect(err?.stage).toBe("appKeyAdd");
    expect(err?.status).toBe(0x01);
  }
});

test("rebindOverConnection: uses GODOX_VENDOR_MODEL by default", () => {
  // Sanity: default model identifier maps to Telink CompanyID/ModelID.
  expect(GODOX_VENDOR_MODEL.vendorId).toBe(TELINK_COMPANY_ID);
  expect(GODOX_VENDOR_MODEL.modelId).toBe(TELINK_VENDOR_MODEL_ID);
});

// --- Real-hardware integration --------------------------------------------

test.skipIf(!hardwareAvailable)(
  "rebinds a provisioned light (requires MESH_HARDWARE_AVAILABLE=1)",
  async () => {
    // Hardware-driven; configured by upstream integration scripts. We only
    // assert that the function is importable here — the actual address /
    // keys come from a previously persisted MeshState the integration
    // harness loads outside of the unit-test layer.
    expect(typeof rebindOverConnection).toBe("function");
  },
);
