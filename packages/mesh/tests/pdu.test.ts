import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { k2 } from "../src/crypto/kdf.ts";
import { encodeVendorOpcode } from "../src/pdu/access.ts";
import { encodeGodoxFrame } from "../src/pdu/accessFrame.ts";
import { decodeUnsegmentedAccess, encodeUnsegmentedAccess } from "../src/pdu/lowerTransport.ts";
import { decodeNetworkPdu, encodeNetworkPdu } from "../src/pdu/network.ts";
import { decodeProxyPdu, encodeProxyPdu } from "../src/pdu/proxy.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");

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

interface StateFixture {
  readonly app_key: string;
  readonly device_key: string;
  readonly iv_index: number;
  readonly network_key: string;
  readonly node_address: number;
  readonly provisioner_address: number;
}

interface FrameFixture {
  readonly sequence: number;
  readonly iv_index: number;
  readonly vendor_opcode: number;
  readonly godox_v2_payload_hex: string;
  readonly proxy_pdu_hex: string;
}

const state = JSON.parse(
  readFileSync(join(fixturesDir, "state-sample.json"), "utf8"),
) as StateFixture;

const netKey = fromHex(state.network_key);
const appKey = fromHex(state.app_key);

const replayFixture = (fixture: FrameFixture): string => {
  const frame = encodeGodoxFrame({
    netKey,
    appKey,
    src: state.provisioner_address,
    dst: state.node_address,
    seq: fixture.sequence,
    ivIndex: fixture.iv_index,
    vendorOpcode: encodeVendorOpcode(fixture.vendor_opcode),
    godoxV2Payload: fromHex(fixture.godox_v2_payload_hex),
  });
  return toHex(frame);
};

const setDir = join(fixturesDir, "set");
const setFiles = readdirSync(setDir).filter((f) => f.endsWith(".json"));
for (const file of setFiles) {
  test(`fixture replay byte-exact: set/${file}`, () => {
    const fixture = JSON.parse(readFileSync(join(setDir, file), "utf8")) as FrameFixture;
    expect(replayFixture(fixture)).toBe(fixture.proxy_pdu_hex);
  });
}

const offDir = join(fixturesDir, "off");
const offFiles = readdirSync(offDir).filter((f) => f.endsWith(".json"));
for (const file of offFiles) {
  test(`fixture replay byte-exact: off/${file}`, () => {
    const fixture = JSON.parse(readFileSync(join(offDir, file), "utf8")) as FrameFixture;
    expect(replayFixture(fixture)).toBe(fixture.proxy_pdu_hex);
  });
}

test("encodeVendorOpcode packs 135664 as Telink little-endian f01102", () => {
  expect(toHex(encodeVendorOpcode(135_664))).toBe("f01102");
});

test("proxy PDU: encode/decode round-trip", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const enc = encodeProxyPdu({ sar: 0, messageType: 0, payload });
  expect(enc[0]).toBe(0x00);
  const dec = decodeProxyPdu(enc);
  expect(dec.sar).toBe(0);
  expect(dec.messageType).toBe(0);
  expect(Array.from(dec.payload)).toEqual(Array.from(payload));
});

test("lower transport: unsegmented access round-trip preserves akf/aid/payload", () => {
  const encryptedAccessPdu = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const enc = encodeUnsegmentedAccess({ akf: 1, aid: 0x31, encryptedAccessPdu });
  expect(enc[0]).toBe(0x71); // (1<<6) | 0x31
  const dec = decodeUnsegmentedAccess(enc);
  expect(dec.header.akf).toBe(1);
  expect(dec.header.aid).toBe(0x31);
  expect(Array.from(dec.encryptedAccessPdu)).toEqual(Array.from(encryptedAccessPdu));
});

test("network PDU: encode → decode round-trip", () => {
  const { nid, encryptionKey, privacyKey } = k2(netKey, new Uint8Array([0x00]));
  const lowerTransportPdu = new Uint8Array([0x70, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  const encoded = encodeNetworkPdu({
    nid,
    ivIndex: 0,
    ctl: 0,
    ttl: 10,
    seq: 0x012345,
    src: 0x0001,
    dst: 0x0002,
    lowerTransportPdu,
    encryptionKey,
    privacyKey,
  });
  const decoded = decodeNetworkPdu({
    pdu: encoded,
    ivIndex: 0,
    encryptionKey,
    privacyKey,
  });
  expect(decoded.nid).toBe(nid);
  expect(decoded.ctl).toBe(0);
  expect(decoded.ttl).toBe(10);
  expect(decoded.seq).toBe(0x012345);
  expect(decoded.src).toBe(0x0001);
  expect(decoded.dst).toBe(0x0002);
  expect(Array.from(decoded.lowerTransportPdu)).toEqual(Array.from(lowerTransportPdu));
});
