#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { connectProxy } from "../src/ble/proxy.ts";
import { VENDOR_OPCODE, encodeRawV2 } from "../src/godox/protocol.ts";
import { encodeGodoxFrame } from "../src/pdu/accessFrame.ts";

const usage = () => {
  console.error(`Usage:
  node --experimental-strip-types packages/mesh/scripts/send-raw-v2.mjs \\
    --address <ble-address> --state <state.json> --model <hex|dec> --end <hex|dec> --data <hex bytes>

Examples:
  # Known CCT-like payload: brightness=50, cct=4500K, gm=50
  node --experimental-strip-types packages/mesh/scripts/send-raw-v2.mjs \\
    --address d48531f5ab9b43adc9a8bc7421e102db \\
    --state ~/.config/godox-tl/states/ios-test.json \\
    --model 0xf0 --end 0 --data 32,2d,32,00,00`);
};

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key?.startsWith("--") || value === undefined) {
    usage();
    process.exit(2);
  }
  args.set(key.slice(2), value);
}

const required = ["address", "state", "model", "end", "data"];
for (const key of required) {
  if (!args.has(key)) {
    usage();
    process.exit(2);
  }
}

const parseByte = (value, label) => {
  const n = Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
  if (!Number.isInteger(n) || n < 0 || n > 0xff) {
    throw new Error(`${label} must be a byte, got ${value}`);
  }
  return n;
};

const parseData = (value) => {
  const compact = value.replaceAll(/\s|,/g, "");
  if (compact.length === 0) return [];
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact)) {
    throw new Error(`--data must be comma-separated bytes or contiguous hex, got ${value}`);
  }
  const bytes = [];
  for (let i = 0; i < compact.length; i += 2) {
    bytes.push(Number.parseInt(compact.slice(i, i + 2), 16));
  }
  if (bytes.length > 5) throw new Error("--data may contain at most 5 bytes");
  return bytes;
};

const hexToBytes = (hex, label) => {
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${label} must be a 16-byte hex key`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
};

const toHex = (bytes) => Buffer.from(bytes).toString("hex");

const main = Effect.gen(function* () {
  const statePath = args.get("state").replace(/^~(?=$|\/)/, process.env.HOME);
  const state = JSON.parse(yield* Effect.promise(() => readFile(statePath, "utf8")));

  const payload = encodeRawV2(
    parseByte(args.get("model"), "model"),
    parseByte(args.get("end"), "end"),
    parseData(args.get("data")),
  );

  const seq = state.sequence_number;
  const proxyPdu = encodeGodoxFrame({
    netKey: hexToBytes(state.network_key, "network_key"),
    appKey: hexToBytes(state.app_key, "app_key"),
    src: state.provisioner_address,
    dst: state.node_address,
    seq,
    ivIndex: state.iv_index,
    vendorOpcode: VENDOR_OPCODE,
    godoxV2Payload: payload,
  });

  const nextState = { ...state, sequence_number: seq + 1 };
  yield* Effect.promise(() => writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`));

  console.log(`seq=${seq} payload=${toHex(payload)} proxy=${toHex(proxyPdu)}`);
  const conn = yield* connectProxy(args.get("address"));
  yield* conn.write(proxyPdu);
  yield* Effect.sleep("250 millis");
});

Effect.runPromise(Effect.scoped(main)).catch((error) => {
  console.error(error);
  process.exit(1);
});
