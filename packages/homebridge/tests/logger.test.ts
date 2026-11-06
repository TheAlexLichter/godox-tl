import { Effect, Logger, References } from "effect";
import type { Logger as HomebridgeLogger } from "homebridge";
import { expect, test, vi } from "vite-plus/test";
import { homebridgeLoggerLayer } from "../src/logger.ts";

test("Homebridge forwards v4 warning/debug levels and preserves existing loggers", async () => {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const observed: string[] = [];
  const observer = Logger.make(({ message }) => {
    observed.push(String(message));
  });
  await Effect.gen(function* () {
    yield* Effect.logWarning("BLE retry");
    yield* Effect.logDebug("BLE ready");
  }).pipe(
    Effect.provide(homebridgeLoggerLayer(log as unknown as HomebridgeLogger)),
    Effect.provide(Logger.layer([observer, Logger.tracerLogger])),
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.runPromise,
  );
  expect(log.warn).toHaveBeenCalledWith("BLE retry");
  expect(log.debug).toHaveBeenCalledWith("BLE ready");
  expect(observed).toEqual(["BLE retry", "BLE ready"]);
});

test("Homebridge renders safe mesh diagnostics without changing other loggers' annotations", async () => {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const observed: Readonly<Record<string, unknown>>[] = [];
  const observer = Logger.make(({ fiber }) => {
    observed.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  const annotations = {
    "mesh.commandId": "command-123",
    "mesh.address": "AA:BB:CC:DD:EE:FF",
    "mesh.mode": "Cct",
    "mesh.attempt": 2,
    "mesh.phase": "write",
    "mesh.durationMs": 12,
    "mesh.outcome": "success",
    privateContext: { value: "do not forward" },
  };
  await Effect.logDebug("BLE ready").pipe(
    Effect.annotateLogs(annotations),
    Effect.provide(homebridgeLoggerLayer(log as unknown as HomebridgeLogger)),
    Effect.provide(Logger.layer([observer, Logger.tracerLogger])),
    Effect.runPromise,
  );
  const text = String(log.debug.mock.calls[0]?.[0]);
  expect(text).toContain('command="command-123"');
  expect(text).toContain('target="AA:BB:CC:DD:EE:FF"');
  expect(text).toContain('phase="write"');
  expect(text).toContain("attempt=2");
  expect(text).toContain("durationMs=12");
  expect(text).not.toContain("privateContext");
  expect(text).not.toContain("do not forward");
  expect(observed).toEqual([annotations]);
});
