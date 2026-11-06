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
