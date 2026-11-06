import { mkdir, symlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { reserveMeshSequences } from "../../src/sequences.ts";
import { loadMeshState } from "../../src/state.ts";

if (process.argv[2] === "hold") {
  const lockPath = process.argv[3];
  await mkdir(lockPath, { recursive: true });
  await symlink(
    JSON.stringify({ pid: process.pid, host: hostname(), token: "held", ticket: 1 }),
    join(lockPath, "held"),
  );
  console.log("ready");
  setInterval(() => {}, 1000);
} else {
  const [, , statePath, sequenceDirectory, count] = process.argv;
  const reservations = [];
  for (let i = 0; i < Number(count); i++) {
    const state = await Effect.runPromise(loadMeshState(statePath));
    reservations.push(
      await Effect.runPromise(
        reserveMeshSequences(state, (i % 3) + 1, {
          statePath,
          sequenceDirectory,
        }),
      ),
    );
  }
  console.log(JSON.stringify(reservations));
}
