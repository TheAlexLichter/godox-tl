import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { loadMeshState, MeshStateError, type MeshState, saveMeshState } from "../src/state.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "godox-mesh-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: MeshState = {
  networkKey: new Uint8Array([
    0x3a, 0x21, 0xd5, 0xa9, 0x4e, 0x7f, 0x3f, 0x05, 0x56, 0x88, 0x1d, 0xc1, 0xe8, 0xd1, 0xbc, 0x8d,
  ]),
  appKey: new Uint8Array([
    0xde, 0xf7, 0x05, 0xc8, 0xb7, 0x5b, 0x70, 0xcf, 0x9b, 0x54, 0xa5, 0x93, 0xc4, 0xe7, 0x1e, 0x16,
  ]),
  deviceKey: new Uint8Array([
    0xbf, 0x0e, 0xa7, 0x57, 0x41, 0xf2, 0x23, 0x0e, 0x2a, 0x90, 0x05, 0xeb, 0x06, 0xff, 0xf2, 0x72,
  ]),
  ivIndex: 0,
  provisionerAddress: 1,
  nodeAddress: 2,
  sequenceNumber: 42,
  deviceAddress: "83E72030-EF94-6299-21DD-372408DE38C2",
};

const rawSample = {
  app_key: "819e28a5d5fe97f3290c8e3b2e9de156",
  device_address: "",
  device_key: "f31557523021f6294f54bf00ec18b5d5",
  iv_index: 0,
  network_key: "ff5a4609ace4789e81c531ee9492b2bd",
  node_address: 2,
  provisioner_address: 1,
  sequence_number: 30,
};

test("saveMeshState writes the mesh JSON format on disk", async () => {
  const path = join(dir, "light.json");
  await Effect.runPromise(saveMeshState(path, sample));
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  // Field names mirror the original reverse-engineered mesh_state.json shape.
  expect(Object.keys(raw).sort()).toEqual([
    "app_key",
    "device_address",
    "device_key",
    "iv_index",
    "network_key",
    "node_address",
    "provisioner_address",
    "sequence_number",
  ]);
  expect(raw["network_key"]).toBe("3a21d5a94e7f3f0556881dc1e8d1bc8d");
  expect(raw["app_key"]).toBe("def705c8b75b70cf9b54a593c4e71e16");
  expect(raw["device_key"]).toBe("bf0ea75741f2230e2a9005eb06fff272");
  expect(raw["node_address"]).toBe(2);
  expect(raw["provisioner_address"]).toBe(1);
  expect(raw["sequence_number"]).toBe(42);
  expect(raw["iv_index"]).toBe(0);
});

test("save → load round-trip preserves every field", async () => {
  const path = join(dir, "light.json");
  await Effect.runPromise(saveMeshState(path, sample));
  const round = await Effect.runPromise(loadMeshState(path));
  expect(round.networkKey).toEqual(sample.networkKey);
  expect(round.appKey).toEqual(sample.appKey);
  expect(round.deviceKey).toEqual(sample.deviceKey);
  expect(round.ivIndex).toBe(sample.ivIndex);
  expect(round.provisionerAddress).toBe(sample.provisionerAddress);
  expect(round.nodeAddress).toBe(sample.nodeAddress);
  expect(round.sequenceNumber).toBe(sample.sequenceNumber);
  expect(round.deviceAddress).toBe(sample.deviceAddress);
});

test("loadMeshState reads the original mesh_state.json shape byte-for-byte", async () => {
  // This is the JSON shape captured from the upstream reverse-engineering
  // tool. Treat it as a contract test for state-file compatibility.
  const path = join(dir, "mesh-state.json");
  const meshStateJson = `{
  "app_key": "819e28a5d5fe97f3290c8e3b2e9de156",
  "device_address": "",
  "device_key": "f31557523021f6294f54bf00ec18b5d5",
  "iv_index": 0,
  "network_key": "ff5a4609ace4789e81c531ee9492b2bd",
  "node_address": 2,
  "provisioner_address": 1,
  "sequence_number": 30
}
`;
  await import("node:fs/promises").then((m) => m.writeFile(path, meshStateJson));
  const state = await Effect.runPromise(loadMeshState(path));
  expect(state.sequenceNumber).toBe(30);
  expect(state.nodeAddress).toBe(2);
  expect(state.deviceAddress).toBe(""); // empty string preserved as empty, not undefined
  expect(Array.from(state.networkKey)).toEqual([
    0xff, 0x5a, 0x46, 0x09, 0xac, 0xe4, 0x78, 0x9e, 0x81, 0xc5, 0x31, 0xee, 0x94, 0x92, 0xb2, 0xbd,
  ]);
});

test("saveMeshState is atomic — writes to .tmp then renames", async () => {
  // We can't observe the rename directly without a race, but we can verify
  // that the final file exists at the expected path and no .tmp file is
  // left behind in the happy path.
  const path = join(dir, "atomic.json");
  await Effect.runPromise(saveMeshState(path, sample));
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir);
  expect(entries).toContain("atomic.json");
  expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
});

test("loadMeshState fails with MeshStateError on missing file", async () => {
  const exit = await Effect.runPromiseExit(loadMeshState(join(dir, "nope.json")));
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const errorString = JSON.stringify(exit.cause);
    expect(errorString).toContain("MeshStateError");
  }
});

test("loadMeshState rejects corrupt hex keys and wrong key lengths", async () => {
  const invalidHexPath = join(dir, "invalid-hex.json");
  const shortKeyPath = join(dir, "short-key.json");
  const base = {
    app_key: "819e28a5d5fe97f3290c8e3b2e9de156",
    device_address: "",
    device_key: "f31557523021f6294f54bf00ec18b5d5",
    iv_index: 0,
    network_key: "ff5a4609ace4789e81c531ee9492b2bd",
    node_address: 2,
    provisioner_address: 1,
    sequence_number: 30,
  };
  await import("node:fs/promises").then((m) =>
    m.writeFile(invalidHexPath, JSON.stringify({ ...base, network_key: "zz".repeat(16) })),
  );
  await import("node:fs/promises").then((m) =>
    m.writeFile(shortKeyPath, JSON.stringify({ ...base, app_key: "aa".repeat(15) })),
  );

  const invalidHexExit = await Effect.runPromiseExit(loadMeshState(invalidHexPath));
  const shortKeyExit = await Effect.runPromiseExit(loadMeshState(shortKeyPath));

  expect(invalidHexExit._tag).toBe("Failure");
  expect(shortKeyExit._tag).toBe("Failure");
});

test.each([
  ["iv_index", -1],
  ["iv_index", 0x1_0000_0000],
  ["iv_index", 0.5],
  ["iv_index", "0"],
  ["node_address", 0],
  ["node_address", 0x8000],
  ["node_address", 1.5],
  ["node_address", "2"],
  ["provisioner_address", 0],
  ["provisioner_address", 0x8000],
  ["provisioner_address", 1.5],
  ["sequence_number", -1],
  ["sequence_number", 0x100_0001],
  ["sequence_number", 0.5],
  ["sequence_number", "30"],
  ["device_address", 42],
  ["device_address", null],
  ["sequence_directory", 42],
  ["sequence_directory", null],
  ...["network_key", "app_key", "device_key"].flatMap((field) =>
    [
      null,
      42,
      "aa".repeat(15),
      "aa".repeat(17),
      "a".repeat(31),
      "zz".repeat(16),
      `${"aa".repeat(16)}\n`,
    ].map((value) => [field, value]),
  ),
])("loadMeshState rejects invalid %s (%j) with a field-specific error", async (field, value) => {
  const path = join(dir, "invalid.json");
  await writeFile(path, JSON.stringify({ ...rawSample, [String(field)]: value }));
  const error = await Effect.runPromise(Effect.flip(loadMeshState(path)));
  expect(error).toBeInstanceOf(MeshStateError);
  expect(error.message).toContain(String(field));
});

test.each([null, [], "state", {}, { network_key: rawSample.network_key }])(
  "loadMeshState rejects malformed root or missing fields (%j)",
  async (raw) => {
    const path = join(dir, "malformed.json");
    await writeFile(path, JSON.stringify(raw));
    expect(await Effect.runPromise(Effect.flip(loadMeshState(path)))).toBeInstanceOf(
      MeshStateError,
    );
  },
);

test("state codec accepts bounds, exhausted counters, uppercase keys and future fields", async () => {
  const path = join(dir, "bounds.json");
  await writeFile(
    path,
    JSON.stringify({
      ...rawSample,
      network_key: rawSample.network_key.toUpperCase(),
      iv_index: 0xffff_ffff,
      node_address: 0x7fff,
      provisioner_address: 0x7fff,
      sequence_number: 0x100_0000,
      sequence_directory: "",
      future_field: { enabled: true },
    }),
  );
  const loaded = await Effect.runPromise(loadMeshState(path));
  expect(loaded.ivIndex).toBe(0xffff_ffff);
  expect(loaded.nodeAddress).toBe(0x7fff);
  expect(loaded.provisionerAddress).toBe(0x7fff);
  expect(loaded.sequenceNumber).toBe(0x100_0000);
  expect(loaded.deviceAddress).toBe("");
  expect(loaded.sequenceDirectory).toBe("");
  await Effect.runPromise(saveMeshState(path, loaded));
  expect(await Effect.runPromise(loadMeshState(path))).toEqual(loaded);
  await Effect.runPromise(
    saveMeshState(path, {
      ...loaded,
      ivIndex: 0,
      nodeAddress: 1,
      provisionerAddress: 1,
      sequenceNumber: 0,
      sequenceDirectory: "/tmp/shared-sequences",
    }),
  );
  expect((await Effect.runPromise(loadMeshState(path))).sequenceDirectory).toBe(
    "/tmp/shared-sequences",
  );
});

test.each(["network_key", "app_key", "device_key"])(
  "state failures never retain the value of %s",
  async (field) => {
    const path = join(dir, "private.json");
    const secret = "secret-key-value-12345678901234567";
    for (const text of [
      JSON.stringify({ ...rawSample, [field]: secret }),
      `{"${field}":"${secret}" trailing`,
    ]) {
      await writeFile(path, text);
      const error = await Effect.runPromise(Effect.flip(loadMeshState(path)));
      expect(
        `${error.message}\n${inspect(error, { depth: 20 })}\n${JSON.stringify(error)}`,
      ).not.toContain(secret);
      expect(error).toBeInstanceOf(MeshStateError);
    }
  },
);

test.each([
  { networkKey: new Uint8Array(15) },
  { appKey: new Uint8Array(17) },
  { deviceKey: new Uint8Array(0) },
  { sequenceNumber: 0x100_0001 },
  { ivIndex: -1 },
  { nodeAddress: 0 },
  { provisionerAddress: 0x8000 },
  ...["networkKey", "appKey", "deviceKey"].flatMap((field) =>
    ["a".repeat(16), Array.from({ length: 16 }, () => 0xab), null, new Uint16Array(16)].map(
      (value) => ({ [field]: value }),
    ),
  ),
  { deviceAddress: null },
  { sequenceDirectory: null },
])(
  "saveMeshState rejects invalid runtime state before replacing the file (%j)",
  async (invalid) => {
    const path = join(dir, "preserved.json");
    await Effect.runPromise(saveMeshState(path, sample));
    const before = await readFile(path, "utf8");
    expect(
      await Effect.runPromise(Effect.flip(saveMeshState(path, { ...sample, ...invalid }))),
    ).toBeInstanceOf(MeshStateError);
    expect(await readFile(path, "utf8")).toBe(before);
  },
);

test.each(["networkKey", "appKey", "deviceKey"])(
  "saveMeshState does not retain invalid runtime %s material in errors",
  async (field) => {
    const path = join(dir, "private-save.json");
    const secret = "secret-key-value-12345678901234567";
    const error = await Effect.runPromise(
      Effect.flip(saveMeshState(path, { ...sample, [field]: secret })),
    );
    expect(error).toBeInstanceOf(MeshStateError);
    expect(error.message).toContain(field);
    expect(
      `${error.message}\n${inspect(error, { depth: 20 })}\n${JSON.stringify(error)}`,
    ).not.toContain(secret);
  },
);

test.each([undefined, ""])(
  "saveMeshState accepts Buffer keys and optional strings (%j)",
  async (optional) => {
    const path = join(dir, "optional.json");
    await Effect.runPromise(
      saveMeshState(path, {
        ...sample,
        networkKey: Buffer.from(sample.networkKey),
        appKey: Buffer.from(sample.appKey),
        deviceKey: Buffer.from(sample.deviceKey),
        deviceAddress: optional,
        sequenceDirectory: optional,
      }),
    );
    const loaded = await Effect.runPromise(loadMeshState(path));
    expect(loaded.networkKey).toEqual(sample.networkKey);
    expect(loaded.appKey).toEqual(sample.appKey);
    expect(loaded.deviceKey).toEqual(sample.deviceKey);
    expect(loaded.deviceAddress).toBe("");
    expect(loaded.sequenceDirectory).toBe(optional);
  },
);
