// Mesh state file — stores the material needed to address an already
// provisioned Bluetooth SIG Mesh node.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Data, Effect, Schema, SchemaIssue } from "effect";

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
  /** Shared mesh/source sequence store. Persisted so CLI and Homebridge agree. */
  readonly sequenceDirectory?: string;
}

export class MeshStateError extends Data.TaggedError("MeshStateError")<{
  readonly path?: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");

const KeyHex = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32}$/)).check(
  Schema.isBetweenLength(32, 32),
);
const UnicastAddress = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0x7fff }));
const RawMeshStateSchema = Schema.Struct({
  app_key: KeyHex,
  device_address: Schema.optionalKey(Schema.String),
  device_key: KeyHex,
  iv_index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff })),
  network_key: KeyHex,
  node_address: UnicastAddress,
  provisioner_address: UnicastAddress,
  // The next-unused counter may equal 2^24 when its final sequence is consumed.
  sequence_number: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0x100_0000 })),
  sequence_directory: Schema.optionalKey(Schema.String),
});
type RawMeshState = typeof RawMeshStateSchema.Type;
const MeshStateJson = Schema.fromJsonString(RawMeshStateSchema, { space: 2 });
const decodeState = Schema.decodeUnknownSync(MeshStateJson, { errors: "all", reportInput: false });
const encodeState = Schema.encodeSync(MeshStateJson);
const KeyBytes = Schema.Uint8Array.check(Schema.isBetweenLength(16, 16));
const MeshStateInputSchema = Schema.Struct({
  networkKey: KeyBytes,
  appKey: KeyBytes,
  deviceKey: KeyBytes,
  ivIndex: RawMeshStateSchema.fields.iv_index,
  provisionerAddress: UnicastAddress,
  nodeAddress: UnicastAddress,
  sequenceNumber: RawMeshStateSchema.fields.sequence_number,
  deviceAddress: Schema.optional(Schema.String),
  sequenceDirectory: Schema.optional(Schema.String),
});
const validateStateInput = Schema.decodeUnknownSync(MeshStateInputSchema, {
  errors: "all",
  reportInput: false,
});

// Never attach the original schema issue: JSON/parser diagnostics can contain
// secret key material even when input reporting is disabled.
const safeCause = (cause: unknown): unknown => {
  if (!Schema.isSchemaError(cause)) return cause;
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1({
    leafHook: () => "Invalid value",
    checkHook: () => "Invalid value",
  })(cause.issue);
  const fields = [...new Set(issues.map((issue) => issue.path?.map(String).join(".") || "$"))];
  return new Error(`invalid mesh state fields: ${fields.join(", ")}`);
};

const stateError = (path: string, action: "read" | "write", cause: unknown): MeshStateError => {
  const safe = safeCause(cause);
  return new MeshStateError({
    path,
    message: `failed to ${action} ${path}${Schema.isSchemaError(cause) && safe instanceof Error ? `: ${safe.message}` : ""}`,
    cause: safe,
  });
};

const fromRaw = (raw: RawMeshState): MeshState => ({
  networkKey: hexToBytes(raw.network_key),
  appKey: hexToBytes(raw.app_key),
  deviceKey: hexToBytes(raw.device_key),
  ivIndex: raw.iv_index,
  provisionerAddress: raw.provisioner_address,
  nodeAddress: raw.node_address,
  sequenceNumber: raw.sequence_number,
  deviceAddress: raw.device_address ?? undefined,
  sequenceDirectory: raw.sequence_directory,
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
  ...(s.sequenceDirectory !== undefined ? { sequence_directory: s.sequenceDirectory } : {}),
});

export const loadMeshState = (path: string): Effect.Effect<MeshState, MeshStateError> =>
  Effect.tryPromise({
    try: async () => {
      const text = await readFile(path, "utf8");
      return fromRaw(decodeState(text));
    },
    catch: (cause) => stateError(path, "read", cause),
  });

export const saveMeshState = (
  path: string,
  state: MeshState,
): Effect.Effect<void, MeshStateError> =>
  Effect.tryPromise({
    try: async () => {
      const text = encodeState(toRaw(validateStateInput(state)));
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${text}\n`, "utf8");
      await rename(tmp, path);
    },
    catch: (cause) => stateError(path, "write", cause),
  });
