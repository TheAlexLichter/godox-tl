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

/** Build an Effect `Logger` that forwards every `Effect.logInfo` /
 * `logWarning` / `logError` / `logDebug` call to the supplied Homebridge
 * `Logger`. Trace is dropped (Homebridge has no equivalent level). */
const makeHomebridgeEffectLogger = (hbLog: HomebridgeLogger) =>
  EffectLogger.make(({ logLevel, message }) => {
    const text = stringify(message);
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
