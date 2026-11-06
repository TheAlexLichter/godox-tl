import { Effect, Exit } from "effect";

/** Only operational metadata belongs here: never mesh state, keys or source identities. */
export const commandPhase = <A, E, R>(
  phase: "send" | "connect" | "write" | "retry" | "cleanup",
  effect: Effect.Effect<A, E, R>,
  annotations: Readonly<Record<string, string | number>> = {},
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const startedAt = Date.now();
    return Effect.logDebug(`[mesh] ${phase} started`).pipe(
      Effect.andThen(effect),
      Effect.onExit((exit) =>
        Effect.logDebug(`[mesh] ${phase} ${Exit.isSuccess(exit) ? "completed" : "failed"}`).pipe(
          Effect.annotateLogs({
            "mesh.durationMs": Math.max(0, Date.now() - startedAt),
            "mesh.outcome": Exit.isSuccess(exit) ? "success" : "failure",
          }),
        ),
      ),
    );
  }).pipe(
    Effect.annotateLogs({ ...annotations, "mesh.phase": phase }),
    Effect.withSpan(`mesh.${phase}`, { attributes: { ...annotations, "mesh.phase": phase } }),
  );
