// Mesh state file — stores the material needed to address an already
// provisioned Bluetooth SIG Mesh node.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Data, Effect } from "effect";

export interface MeshState {
  readonly networkKey: Uint8Array;
  readonly appKey: Uint8Array;
  readonly deviceKey: Uint8Array;
  readonly ivIndex: number;
  readonly provisionerAddress: number;
  readonly nodeAddress: number;
  readonly sequenceNumber: number;
  /** Optional BLE address captured during provisioning or recovery. */
  readonly deviceAddress?: string;
}

export class MeshStateError extends Data.TaggedError("MeshStateError")<{
  readonly path?: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const hexToBytes = (hex: string, field: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`${field} contains non-hex characters`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const keyToBytes = (hex: string, field: string): Uint8Array => {
  const bytes = hexToBytes(hex, field);
  if (bytes.length !== 16) throw new Error(`${field} must be 16 bytes, got ${bytes.length}`);
  return bytes;
};

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");

interface RawMeshState {
  readonly app_key: string;
  readonly device_address?: string;
  readonly device_key: string;
  readonly iv_index: number;
  readonly network_key: string;
  readonly node_address: number;
  readonly provisioner_address: number;
  readonly sequence_number: number;
}

const fromRaw = (raw: RawMeshState): MeshState => ({
  networkKey: keyToBytes(raw.network_key, "network_key"),
  appKey: keyToBytes(raw.app_key, "app_key"),
  deviceKey: keyToBytes(raw.device_key, "device_key"),
  ivIndex: raw.iv_index,
  provisionerAddress: raw.provisioner_address,
  nodeAddress: raw.node_address,
  sequenceNumber: raw.sequence_number,
  deviceAddress: raw.device_address ?? undefined,
});

const toRaw = (s: MeshState): RawMeshState => ({
  app_key: bytesToHex(s.appKey),
  device_address: s.deviceAddress ?? "",
  device_key: bytesToHex(s.deviceKey),
  iv_index: s.ivIndex,
  network_key: bytesToHex(s.networkKey),
  node_address: s.nodeAddress,
  provisioner_address: s.provisionerAddress,
  sequence_number: s.sequenceNumber,
});

export const loadMeshState = (path: string): Effect.Effect<MeshState, MeshStateError> =>
  Effect.tryPromise({
    try: async () => {
      const text = await readFile(path, "utf8");
      const raw = JSON.parse(text) as RawMeshState;
      return fromRaw(raw);
    },
    catch: (cause) => new MeshStateError({ path, message: `failed to read ${path}`, cause }),
  });

export const saveMeshState = (
  path: string,
  state: MeshState,
): Effect.Effect<void, MeshStateError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(toRaw(state), null, 2)}\n`, "utf8");
      await rename(tmp, path);
    },
    catch: (cause) => new MeshStateError({ path, message: `failed to write ${path}`, cause }),
  });
