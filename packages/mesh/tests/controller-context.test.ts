import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@godox-tl/core";
import { Effect, Logger, type LogLevel, References } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { __setNobleForTesting, MESH_PROXY_SERVICE_UUID } from "../src/ble/index.ts";
import type { NobleLike } from "../src/ble/noble.ts";
import { makeMeshController } from "../src/controller.ts";
import { saveMeshState } from "../src/state.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "godox-controller-context-"));
});

afterEach(async () => {
  __setNobleForTesting(undefined);
  await rm(dir, { recursive: true, force: true });
});

const setupController = async (
  coalesce: boolean,
  options: { readonly idleMs?: number; readonly disconnect?: () => Promise<void> } = {},
) => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, {
      networkKey: new Uint8Array(16),
      appKey: new Uint8Array(16),
      deviceKey: new Uint8Array(16),
      ivIndex: 0,
      provisionerAddress: 1,
      nodeAddress: 2,
      sequenceNumber: 0,
      sequenceDirectory: join(dir, "sequences"),
    }),
  );

  let signalFirstWrite: (() => void) | undefined;
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteStarted = new Promise<void>((resolve) => {
    signalFirstWrite = resolve;
  });
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let firstWrite = true;
  class FakeNoble extends EventEmitter implements NobleLike {
    readonly state = "poweredOn";

    async startScanningAsync(): Promise<void> {
      queueMicrotask(() =>
        this.emit("discover", {
          address: "AA:BB:CC:DD:EE:FF",
          state: "connected",
          connectAsync: async () => {},
          disconnectAsync: options.disconnect ?? (async () => {}),
          discoverServicesAsync: async () => [
            {
              uuid: MESH_PROXY_SERVICE_UUID,
              discoverCharacteristicsAsync: async () => [
                {
                  uuid: "2add",
                  properties: ["writeWithoutResponse"],
                  writeAsync: async () => {
                    if (firstWrite) {
                      firstWrite = false;
                      signalFirstWrite?.();
                      await firstWriteReleased;
                    }
                  },
                },
              ],
            },
          ],
        }),
      );
    }

    async stopScanningAsync(): Promise<void> {}
  }
  __setNobleForTesting(new FakeNoble());

  return {
    controller: makeMeshController({
      address: "AA:BB:CC:DD:EE:FF",
      statePath,
      coalesce,
      connectionIdleMs: options.idleMs ?? 10_000,
    }),
    firstWriteStarted,
    releaseFirstWrite: () => releaseFirstWrite?.(),
  };
};

const runWithLogger = (
  controller: ReturnType<typeof makeMeshController>,
  brightness: number,
  messages: string[],
  level: LogLevel.LogLevel = "Debug",
) =>
  Effect.runPromise(
    controller
      .send(
        Domain.Cct.make({
          brightness: Domain.pct(brightness),
          temperature: Domain.kelvin(4000),
        }),
      )
      .pipe(
        Effect.provideService(References.MinimumLogLevel, level),
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => messages.push(String(message)))]),
        ),
      ),
  );

test("first and queued sends retain each caller's logger and minimum log level", async () => {
  const { controller, firstWriteStarted, releaseFirstWrite } = await setupController(false);
  const firstMessages: string[] = [];
  const quietMessages: string[] = [];
  const lastMessages: string[] = [];
  const first = runWithLogger(controller, 10, firstMessages);
  await firstWriteStarted;
  const quiet = runWithLogger(controller, 20, quietMessages, "Info");
  const last = runWithLogger(controller, 30, lastMessages);
  releaseFirstWrite();
  await Promise.all([first, quiet, last]);

  expect(firstMessages.filter((message) => message.includes("[mesh] sent Cct"))).toHaveLength(1);
  expect(firstMessages.some((message) => message.includes("[ble] scanning"))).toBe(true);
  expect(quietMessages).toEqual([]);
  expect(lastMessages.filter((message) => message.includes("[mesh] sent Cct"))).toHaveLength(1);
  expect(lastMessages.some((message) => message.includes("[mesh] reusing writer"))).toBe(true);
}, 10_000);

test("coalesced work uses the newest command's runtime, while settling superseded callers", async () => {
  const { controller, firstWriteStarted, releaseFirstWrite } = await setupController(true);
  const firstMessages: string[] = [];
  const supersededMessages: string[] = [];
  const newestMessages: string[] = [];
  const first = runWithLogger(controller, 10, firstMessages);
  await firstWriteStarted;
  const superseded = runWithLogger(controller, 20, supersededMessages);
  const newest = runWithLogger(controller, 30, newestMessages);
  releaseFirstWrite();
  await Promise.all([first, superseded, newest]);

  expect(firstMessages.filter((message) => message.includes("[mesh] sent Cct"))).toHaveLength(1);
  expect(supersededMessages).toEqual(["[mesh] command queued"]);
  expect(newestMessages.filter((message) => message.includes("[mesh] sent Cct"))).toHaveLength(1);
}, 10_000);

test("idle writer cleanup retains the caller's logger for disconnect failures", async () => {
  const { controller, firstWriteStarted, releaseFirstWrite } = await setupController(false, {
    idleMs: 5,
    disconnect: async () => {
      throw new Error("disconnect refused");
    },
  });
  const messages: string[] = [];
  const sending = runWithLogger(controller, 30, messages);
  await firstWriteStarted;
  releaseFirstWrite();
  await sending;

  await vi.waitFor(() => {
    expect(
      messages.filter((message) => message.includes("Failed to close BLE connection")),
    ).toHaveLength(2);
  });
}, 10_000);
