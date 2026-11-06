import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@godox-tl/core";
import { Effect, Logger, References, Tracer } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BleError } from "../src/ble/errors.ts";
import { connectProxyWriter } from "../src/ble/proxy.ts";
import type { ProxyWriterConnection } from "../src/ble/types.ts";
import { makeMeshController } from "../src/controller.ts";
import { saveMeshState } from "../src/state.ts";

vi.mock("../src/ble/proxy.ts", () => ({ connectProxyWriter: vi.fn() }));
const connect = vi.mocked(connectProxyWriter);
const command = Domain.Cct.make({ brightness: Domain.pct(30), temperature: Domain.kelvin(4000) });
const networkKey = new Uint8Array(16).fill(0x11);
const appKey = new Uint8Array(16).fill(0x22);
const deviceKey = new Uint8Array(16).fill(0x33);
let dir: string;
let statePath: string;
type Event = { readonly message: string; readonly annotations: Readonly<Record<string, unknown>> };
const observe = (events: Event[]) =>
  Logger.layer([
    Logger.make(({ message, fiber }) => {
      events.push({
        message: String(message),
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      });
    }),
  ]);
const writer = (write: ProxyWriterConnection["write"]): ProxyWriterConnection => ({
  address: "AA:BB:CC:DD:EE:FF",
  write,
  isConnected: () => true,
  close: () => Effect.logDebug("native close"),
});

beforeEach(async () => {
  connect.mockReset();
  dir = await mkdtemp(join(tmpdir(), "godox-diagnostics-"));
  statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, {
      networkKey,
      appKey,
      deviceKey,
      nodeAddress: 2,
      provisionerAddress: 1,
      ivIndex: 0,
      sequenceNumber: 7,
      sequenceDirectory: join(dir, "sequences"),
    }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const runObserved = <A, E>(effect: Effect.Effect<A, E>, events: Event[]) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(observe(events)),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    ),
  );

const expectSafe = (events: Event[]) => {
  const serialized = JSON.stringify(events);
  for (const key of [networkKey, appKey, deviceKey]) {
    expect(serialized).not.toContain(Buffer.from(key).toString("hex"));
  }
  for (const privateField of [
    "networkKey",
    "appKey",
    "deviceKey",
    "powerConfidenceSource",
    statePath,
  ]) {
    expect(serialized).not.toContain(privateField);
  }
  for (const event of events) {
    expect(event.annotations["mesh.commandId"]).toEqual(expect.any(String));
    expect(event.annotations["mesh.address"]).toBe("AA:BB:CC:DD:EE:FF");
    expect(event.annotations["mesh.mode"]).toBe("Cct");
  }
};

test("successful commands correlate queue, send, connect, write and idle cleanup without state secrets", async () => {
  const events: Event[] = [];
  connect.mockReturnValue(Effect.succeed(writer(() => Effect.logDebug("native write"))));
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    connectionIdleMs: 5,
  });
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  await runObserved(
    controller.send(command).pipe(Effect.provideService(Tracer.Tracer, tracer)),
    events,
  );
  // Idle cleanup deliberately runs after the caller's Effect has completed.
  await Effect.runPromise(Effect.sleep("30 millis"));
  const firstId = events[0]!.annotations["mesh.commandId"];
  const commandSpan = spans.find((span) => span.name === "mesh.command");
  expect(commandSpan?.attributes.get("mesh.commandId")).toBe(firstId);
  expect(
    new Set(spans.filter((span) => span.name.startsWith("mesh.")).map((span) => span.traceId)),
  ).toEqual(new Set([commandSpan?.traceId]));
  expect(spans.filter((span) => span.name.startsWith("mesh.")).map((span) => span.name)).toEqual(
    expect.arrayContaining([
      "mesh.command",
      "mesh.queue",
      "mesh.send",
      "mesh.connect",
      "mesh.write",
      "mesh.cleanup",
    ]),
  );
  expect(new Set(events.map((event) => event.annotations["mesh.commandId"]))).toEqual(
    new Set([firstId]),
  );
  expect(new Set(events.map((event) => event.annotations["mesh.phase"]))).toEqual(
    new Set(["queue", "send", "connect", "write", "cleanup"]),
  );
  expect(
    events.some(
      (event) => event.message === "native close" && event.annotations["mesh.phase"] === "cleanup",
    ),
  ).toBe(true);
  const completed = events.filter((event) => event.annotations["mesh.durationMs"] !== undefined);
  expect(completed.length).toBeGreaterThanOrEqual(4);
  for (const event of completed)
    expect(event.annotations["mesh.durationMs"]).toBeGreaterThanOrEqual(0);
  expectSafe(events);

  const nextEvents: Event[] = [];
  await runObserved(controller.send(command), nextEvents);
  await Effect.runPromise(Effect.sleep("30 millis"));
  expect(nextEvents[0]!.annotations["mesh.commandId"]).not.toBe(firstId);
  expectSafe(nextEvents);
});

test("one BLE retry keeps the command id and marks the fresh connection and writes as attempt two", async () => {
  const events: Event[] = [];
  connect
    .mockReturnValueOnce(
      Effect.succeed(writer(() => Effect.fail(new BleError({ message: "link dropped" })))),
    )
    .mockReturnValueOnce(Effect.succeed(writer(() => Effect.logDebug("recovered write"))));
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    connectionIdleMs: 5,
  });
  await runObserved(controller.send(command), events);
  await Effect.runPromise(Effect.sleep("30 millis"));
  expect(connect).toHaveBeenCalledTimes(2);
  expect(new Set(events.map((event) => event.annotations["mesh.commandId"])).size).toBe(1);
  const retry = events.find((event) => String(event.message).includes("retrying Cct"));
  expect(retry?.annotations).toMatchObject({ "mesh.phase": "retry", "mesh.attempt": 2 });
  const connects = events.filter((event) => event.message === "[mesh] connect started");
  expect(connects.map((event) => event.annotations["mesh.attempt"])).toEqual([1, 2]);
  const writes = events.filter((event) => event.message === "recovered write");
  expect(writes).toHaveLength(3);
  for (const event of writes)
    expect(event.annotations).toMatchObject({ "mesh.phase": "write", "mesh.attempt": 2 });
  expect(events.some((event) => event.annotations["mesh.outcome"] === "failure")).toBe(true);
  expectSafe(events);
});

test("coalesced execution keeps the newest caller's correlation context", async () => {
  const firstEvents: Event[] = [];
  const supersededEvents: Event[] = [];
  const newestEvents: Event[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let writes = 0;
  connect.mockReturnValue(
    Effect.succeed(
      writer(() =>
        Effect.gen(function* () {
          if (writes++ === 0) {
            entered();
            yield* Effect.promise(() => blocked);
          }
          yield* Effect.logDebug("native write");
        }),
      ),
    ),
  );
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    connectionIdleMs: 5,
  });
  const first = runObserved(controller.send(command), firstEvents);
  await started;
  const superseded = runObserved(controller.send(command), supersededEvents);
  const newest = runObserved(controller.send(command), newestEvents);
  release();
  await Promise.all([first, superseded, newest]);
  await Effect.runPromise(Effect.sleep("30 millis"));
  expect(supersededEvents.map((event) => event.annotations["mesh.phase"])).toEqual(["queue"]);
  expect(
    new Set([
      firstEvents[0]!.annotations["mesh.commandId"],
      supersededEvents[0]!.annotations["mesh.commandId"],
      newestEvents[0]!.annotations["mesh.commandId"],
    ]).size,
  ).toBe(3);
  for (const events of [firstEvents, newestEvents]) {
    expect(new Set(events.map((event) => event.annotations["mesh.commandId"])).size).toBe(1);
    expect(events.some((event) => event.annotations["mesh.phase"] === "write")).toBe(true);
    expectSafe(events);
  }
  expect(newestEvents.some((event) => event.annotations["mesh.phase"] === "cleanup")).toBe(true);
});
