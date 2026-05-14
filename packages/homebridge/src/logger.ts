// Bridge Effect's logger to Homebridge's `Logger` so all our log lines come
// out in the standard Homebridge format (`[time] [Godox TL] message`) instead
// of Effect's default `timestamp=… level=INFO fiber=#N message=…` logfmt.

import { Effect, Layer, Logger as EffectLogger, LogLevel } from "effect";
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
    switch (logLevel._tag) {
      case "Error":
      case "Fatal":
        hbLog.error(text);
        return;
      case "Warning":
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
 * Also keeps the minimum log level at Info so Debug lines are suppressed
 * unless `LogLevel.Debug` is provided by the surrounding env. */
export const homebridgeLoggerLayer = (hbLog: HomebridgeLogger): Layer.Layer<never> =>
  Layer.merge(
    EffectLogger.replace(EffectLogger.defaultLogger, makeHomebridgeEffectLogger(hbLog)),
    EffectLogger.minimumLogLevel(LogLevel.Info),
  );

export type { HomebridgeLogger };
export { Effect };
