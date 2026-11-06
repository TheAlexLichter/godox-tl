import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  getLight,
  LightNotFoundError,
  listLights,
  load,
  register,
  removeLight,
  readNodeAddress,
  RegistryError,
  save,
} from "../src/registry.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "godox-registry-"));
  path = join(dir, "registry.json");
});

const validEntry = {
  name: "a",
  address: "1",
  statePath: "/s/1.json",
  provisionedAt: "legacy timestamp",
};

test.each([
  null,
  [],
  "registry",
  {},
  { lights: null },
  { lights: [] },
  { lights: { a: null } },
  { lights: { a: { ...validEntry, name: 1 } } },
  { lights: { a: { ...validEntry, address: 1 } } },
  { lights: { a: { ...validEntry, statePath: null } } },
  { lights: { a: { ...validEntry, provisionedAt: 123 } } },
  { lights: { a: { address: "1" } } },
  ...[0, 0x8000, -1, 1.5, "2", null].map((nodeAddress) => ({
    lights: { a: { ...validEntry, nodeAddress } },
  })),
])("malformed registry fails instead of resetting to empty (%j)", async (raw) => {
  const text = JSON.stringify(raw);
  await writeFile(path, text);
  expect(await Effect.runPromise(Effect.flip(load(path)))).toBeInstanceOf(RegistryError);
  expect(
    await Effect.runPromise(
      Effect.flip(register({ name: "new", address: "2", statePath: "/new" }, path)),
    ),
  ).toBeInstanceOf(RegistryError);
  expect(await readFile(path, "utf8")).toBe(text);
});

test("registry codec preserves future fields and accepts unicast address bounds", async () => {
  const registry = {
    future: { enabled: true },
    lights: {
      a: { ...validEntry, nodeAddress: 1, future_entry: true },
      b: { ...validEntry, name: "b", nodeAddress: 0x7fff },
    },
  };
  await writeFile(path, JSON.stringify(registry));
  const loaded = await Effect.runPromise(load(path));
  expect(loaded).toEqual(registry);
  await Effect.runPromise(save(loaded, path));
  expect(await Effect.runPromise(load(path))).toEqual(registry);
});

test("registry field errors name the invalid entry field", async () => {
  await writeFile(path, JSON.stringify({ lights: { a: { ...validEntry, statePath: 42 } } }));
  const error = await Effect.runPromise(Effect.flip(load(path)));
  expect(error.message).toContain("lights.a.statePath");
});

test("registry save validates data before replacing a valid file", async () => {
  await Effect.runPromise(save({ lights: { a: validEntry } }, path));
  const before = await readFile(path, "utf8");
  const error = await Effect.runPromise(
    Effect.flip(save({ lights: { a: { ...validEntry, nodeAddress: 0 } } }, path)),
  );
  expect(error).toBeInstanceOf(RegistryError);
  expect(error.message).toContain("lights.a.nodeAddress");
  expect(await readFile(path, "utf8")).toBe(before);
});

test.each([undefined, 1, 0x7fff])(
  "readNodeAddress accepts optional node_address %j",
  async (node_address) => {
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({ node_address, future_field: true }));
    expect(await Effect.runPromise(readNodeAddress(statePath))).toBe(node_address);
  },
);

test.each([0, -1, 0x8000, 1.5, "2", null])(
  "readNodeAddress rejects invalid node_address %j",
  async (node_address) => {
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({ node_address }));
    const error = await Effect.runPromise(Effect.flip(readNodeAddress(statePath)));
    expect(error).toBeInstanceOf(RegistryError);
    expect(error.message).toContain("node_address");
  },
);

test("JSON syntax errors never retain mesh keys in registry or node-address errors", async () => {
  const secret = "private-network-key-value";
  await writeFile(path, `{"network_key":"${secret}" trailing`);
  for (const effect of [
    load(path).pipe(Effect.asVoid),
    readNodeAddress(path).pipe(Effect.asVoid),
  ]) {
    const error = await Effect.runPromise(Effect.flip(effect));
    expect(error).toBeInstanceOf(RegistryError);
    expect(
      `${error.message}\n${inspect(error, { depth: 20 })}\n${JSON.stringify(error)}`,
    ).not.toContain(secret);
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("load returns empty registry when file is missing", async () => {
  const reg = await Effect.runPromise(load(path));
  expect(reg).toEqual({ lights: {} });
});

test("register persists and getLight reads it back", async () => {
  const entry = await Effect.runPromise(
    register(
      {
        name: "kitchen",
        address: "AA:BB:CC",
        statePath: "/some/state.json",
        nodeAddress: 2,
      },
      path,
    ),
  );
  expect(entry.name).toBe("kitchen");
  expect(entry.address).toBe("AA:BB:CC");
  expect(entry.nodeAddress).toBe(2);
  expect(entry.provisionedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);

  const round = await Effect.runPromise(getLight("kitchen", path));
  expect(round).toEqual(entry);
});

test("register replaces an existing entry by name", async () => {
  await Effect.runPromise(register({ name: "a", address: "1", statePath: "/s/1.json" }, path));
  await Effect.runPromise(register({ name: "a", address: "2", statePath: "/s/2.json" }, path));
  const entries = await Effect.runPromise(listLights(path));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.address).toBe("2");
});

test("listLights returns all registered entries", async () => {
  await Effect.runPromise(register({ name: "a", address: "1", statePath: "/s/1.json" }, path));
  await Effect.runPromise(register({ name: "b", address: "2", statePath: "/s/2.json" }, path));
  const entries = await Effect.runPromise(listLights(path));
  expect(entries.map((e) => e.name).sort()).toEqual(["a", "b"]);
});

test("getLight fails with LightNotFoundError for unknown name", async () => {
  const exit = await Effect.runPromiseExit(getLight("ghost", path));
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) return;
  expect(failure.value._tag).toBe("LightNotFoundError");
  expect((failure.value as LightNotFoundError).name).toBe("ghost");
});

test("removeLight deletes an entry; second remove fails", async () => {
  await Effect.runPromise(register({ name: "x", address: "1", statePath: "/s/1.json" }, path));
  await Effect.runPromise(removeLight("x", path));
  const entries = await Effect.runPromise(listLights(path));
  expect(entries).toEqual([]);

  const exit = await Effect.runPromiseExit(removeLight("x", path));
  expect(Exit.isFailure(exit)).toBe(true);
});
