// Bridge Effect's logger to Homebridge's `Logger` so all our log lines come
// out in the standard Homebridge format (`[time] [Godox TL] message`) instead
// of Effect's default `timestamp=… level=INFO fiber=#N message=…` logfmt.

import { Effect, Layer, Logger as EffectLogger, References } from "effect";
import type { Logger as HomebridgeLogger } from "homebridge";

const stringify = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(stringify).join(" ");
  if (message instanceof Error) return message.message;
  if (message && typeof message === "object") {
    try {
      return JSON.stringify(message);
    } catch {
      return "[unserializable]";
    }
  }
  return String(message);
};

// An explicit allowlist keeps unrelated annotations (including caller secrets)
// out of Homebridge output without changing events seen by other loggers.
const diagnosticFields = [
  ["mesh.commandId", "command"],
  ["mesh.address", "target"],
  ["mesh.mode", "mode"],
  ["mesh.attempt", "attempt"],
  ["mesh.phase", "phase"],
  ["mesh.durationMs", "durationMs"],
  ["mesh.outcome", "outcome"],
] as const;

const diagnosticSuffix = (annotations: Readonly<Record<string, unknown>>): string => {
  const fields = diagnosticFields.flatMap(([key, label]) => {
    const value = annotations[key];
    if (typeof value !== "string" && typeof value !== "number") return [];
    return [`${label}=${typeof value === "string" ? JSON.stringify(value) : value}`];
  });
  return fields.length ? ` [${fields.join(" ")}]` : "";
};

/** Build an Effect `Logger` that forwards every `Effect.logInfo` /
 * `logWarning` / `logError` / `logDebug` call to the supplied Homebridge
 * `Logger`. Trace is dropped (Homebridge has no equivalent level). */
const makeHomebridgeEffectLogger = (hbLog: HomebridgeLogger) =>
  EffectLogger.make(({ logLevel, message, fiber }) => {
    const text =
      stringify(message) + diagnosticSuffix(fiber.getRef(References.CurrentLogAnnotations));
    switch (logLevel) {
      case "Error":
      case "Fatal":
        hbLog.error(text);
        return;
      case "Warn":
        hbLog.warn(text);
        return;
      case "Info":
        hbLog.info(text);
        return;
      case "Debug":
      case "Trace":
        hbLog.debug(text);
        return;
      default:
        hbLog.info(text);
    }
  });

/** Replaces Effect's default logger with one that hits Homebridge.
 * Keep Effect at Debug so `hbLog.debug` can decide whether debug lines are
 * printed for the current Homebridge log mode. */
export const homebridgeLoggerLayer = (hbLog: HomebridgeLogger): Layer.Layer<never> =>
  Layer.merge(
    Layer.effect(
      References.CurrentLoggers,
      Effect.gen(function* () {
        const loggers = new Set(yield* References.CurrentLoggers);
        loggers.delete(EffectLogger.defaultLogger);
        loggers.add(makeHomebridgeEffectLogger(hbLog));
        return loggers;
      }),
    ),
    Layer.succeed(References.MinimumLogLevel, "Debug"),
  );

export type { HomebridgeLogger };
export { Effect };
