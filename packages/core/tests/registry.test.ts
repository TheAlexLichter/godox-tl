import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  getLight,
  LightNotFoundError,
  listLights,
  load,
  register,
  removeLight,
} from "../src/registry.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "godox-registry-"));
  path = join(dir, "registry.json");
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
  const failure = Cause.failureOption(exit.cause);
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
