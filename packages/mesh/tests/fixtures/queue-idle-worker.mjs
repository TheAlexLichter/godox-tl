import { Domain } from "@godox-tl/core";
import { Effect } from "effect";
import { makeMeshController } from "../../dist/index.mjs";

// Deliberately omit close: the backwards-compatible synchronous factory must
// not retain an idle mailbox fiber after its last command has completed.
const controller = makeMeshController({
  address: "dry-run",
  statePath: process.argv[2],
  dryRun: true,
});
await Effect.runPromise(controller.send(Domain.Off.make({})));
console.log("worker-finished");
