// Tagged error for ConfigSession failures. `stage` identifies which step
// failed so callers can recover or report meaningfully; `status` carries the
// Foundation Models status code (Annex A.4.4) when the failure was an
// upstream non-zero status, not a transport or decode problem.

import { Data } from "effect";

export type ConfigStage = "appKeyAdd" | "modelAppBind" | "receive" | "decode";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly stage: ConfigStage;
  readonly status?: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}
