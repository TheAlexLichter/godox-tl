import { Context, Data } from "effect";
import type { Effect } from "effect";
import type { LightCommand } from "../domain/light.ts";

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class TransportUnsupportedError extends Data.TaggedError("TransportUnsupportedError")<{
  readonly transport: string;
  readonly reason: string;
}> {}

export class LightController extends Context.Tag("LightController")<
  LightController,
  {
    readonly send: (
      cmd: LightCommand,
    ) => Effect.Effect<void, TransportError | TransportUnsupportedError>;
  }
>() {}
