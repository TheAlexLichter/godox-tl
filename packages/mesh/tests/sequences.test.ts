import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  reserveMeshSequences,
  withMeshSequenceReservation,
  type SequenceReservation,
} from "../src/sequences.ts";
import { loadMeshState, saveMeshState, type MeshState } from "../src/state.ts";

const lockHooks = vi.hoisted(() => ({
  afterRead: undefined as undefined | ((path: unknown) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const result = await fs.readdir(...args);
      await lockHooks.afterRead?.(args[0]);
      return result;
    },
  };
});

let directory: string;
let sequenceDirectory: string;
const worker = join(import.meta.dirname, "fixtures", "sequence-worker.mjs");
const exec = promisify(execFile);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "godox-sequence-tests-"));
  sequenceDirectory = join(directory, "sequences");
});
afterEach(async () => {
  lockHooks.afterRead = undefined;
  await rm(directory, { recursive: true, force: true });
});

const state = (sequenceNumber = 7, nodeAddress = 2): MeshState => ({
  networkKey: new Uint8Array(16).fill(1),
  appKey: new Uint8Array(16).fill(2),
  deviceKey: new Uint8Array(16).fill(3),
  ivIndex: 0,
  provisionerAddress: 1,
  nodeAddress,
  sequenceNumber,
});

const counterPath = async (): Promise<string> => {
  const [name] = (await readdir(sequenceDirectory)).filter((name) => name.endsWith(".json"));
  if (!name) throw new Error("counter was not written");
  return join(sequenceDirectory, name);
};

test("two lights share a source counter and migrate the highest legacy value", async () => {
  const a = join(directory, "a", "state.json");
  const b = join(directory, "b", "state.json");
  await Effect.runPromise(saveMeshState(a, state()));
  await Effect.runPromise(saveMeshState(b, state(900, 3)));
  const first = await Effect.runPromise(
    reserveMeshSequences(state(), 2, {
      statePath: a,
      statePaths: [b],
      sequenceDirectory,
    }),
  );
  const second = await Effect.runPromise(
    reserveMeshSequences(state(900, 3), 1, {
      statePath: b,
      sequenceDirectory,
    }),
  );
  expect(first.sequenceNumber).toBe(900);
  expect(second.sequenceNumber).toBe(902);
  expect(second.nextSequenceNumber).toBe(903);
  expect((await Effect.runPromise(loadMeshState(a))).sequenceDirectory).toBe(sequenceDirectory);
});

test("legacy siblings are included even when only one light is selected", async () => {
  const a = join(directory, "a.json");
  const b = join(directory, "b.json");
  await Effect.runPromise(saveMeshState(a, state()));
  await Effect.runPromise(saveMeshState(b, state(500, 3)));
  const reservation = await Effect.runPromise(
    reserveMeshSequences(state(), 1, { statePath: a, sequenceDirectory }),
  );
  expect(reservation.sequenceNumber).toBe(500);
});

test("simultaneous first use with different process defaults selects one store", async () => {
  const path = join(directory, "legacy.json");
  await Effect.runPromise(saveMeshState(path, state()));
  const results = await Promise.all(
    ["cli", "homebridge"].map((name) =>
      Effect.runPromise(
        reserveMeshSequences(state(), 2, {
          statePath: path,
          sequenceDirectory: join(directory, name),
        }),
      ),
    ),
  );
  expect(results.map((result) => result.sequenceNumber).sort((a, b) => a - b)).toEqual([7, 9]);
  expect(new Set(results.map((result) => result.sequenceDirectory)).size).toBe(1);
});

test("symlinked state paths share bootstrap locks and keep the alias intact", async () => {
  const path = join(directory, "actual", "state.json");
  const alias = join(directory, "alias", "light.json");
  await Effect.runPromise(saveMeshState(path, state()));
  await mkdir(join(directory, "alias"));
  await symlink(path, alias);
  const results = await Promise.all(
    [path, alias].map((statePath, i) =>
      Effect.runPromise(
        reserveMeshSequences(state(), 2, {
          statePath,
          sequenceDirectory: join(directory, `store-${i}`),
        }),
      ),
    ),
  );
  expect(results.map((result) => result.sequenceNumber).sort((a, b) => a - b)).toEqual([7, 9]);
  expect(new Set(results.map((result) => result.sequenceDirectory)).size).toBe(1);
  expect(await readlink(alias)).toBe(path);
  expect((await Effect.runPromise(loadMeshState(alias))).sequenceNumber).toBe(11);
});

test("a newly registered earlier path follows the existing store", async () => {
  const b = join(directory, "b.json");
  await Effect.runPromise(saveMeshState(b, state()));
  const first = await Effect.runPromise(
    reserveMeshSequences(state(), 2, { statePath: b, sequenceDirectory }),
  );
  const a = join(directory, "a.json");
  await Effect.runPromise(saveMeshState(a, state(0, 3)));
  const next = await Effect.runPromise(
    reserveMeshSequences(state(0, 3), 1, {
      statePath: a,
      statePaths: [b],
      sequenceDirectory: join(directory, "different-default"),
    }),
  );
  expect(next.sequenceNumber).toBe(first.nextSequenceNumber);
  expect(next.sequenceDirectory).toBe(first.sequenceDirectory);
});

test("a source lease prevents a later block from transmitting before an earlier block", async () => {
  let firstEntered: (() => void) | undefined;
  let releaseFirst: (() => void) | undefined;
  const entered = new Promise<void>((done) => {
    firstEntered = done;
  });
  const barrier = new Promise<void>((done) => {
    releaseFirst = done;
  });
  const transmissions: number[] = [];
  const first = Effect.runPromise(
    withMeshSequenceReservation(state(), 2, { sequenceDirectory }, (reservation) =>
      Effect.promise(async () => {
        firstEntered?.();
        await barrier;
        transmissions.push(reservation.sequenceNumber, reservation.sequenceNumber + 1);
      }),
    ),
  );
  await entered;
  const second = Effect.runPromise(
    withMeshSequenceReservation(state(), 1, { sequenceDirectory }, (reservation) =>
      Effect.sync(() => transmissions.push(reservation.sequenceNumber)),
    ),
  );
  await new Promise((done) => setTimeout(done, 30));
  expect(transmissions).toEqual([]);
  releaseFirst?.();
  await Promise.all([first, second]);
  expect(transmissions).toEqual([7, 8, 9]);
});

test("dynamic counts observe the persisted high-water mark exactly once under the lease", async () => {
  await Effect.runPromise(reserveMeshSequences(state(100), 2, { sequenceDirectory }));
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const holding = new Promise<void>((done) => {
    entered = done;
  });
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const first = Effect.runPromise(
    withMeshSequenceReservation(state(), 2, { sequenceDirectory }, () =>
      Effect.promise(async () => {
        entered?.();
        await barrier;
      }),
    ),
  );
  await holding;
  const seen: number[] = [];
  const second = Effect.runPromise(
    reserveMeshSequences(
      state(),
      (next) => {
        seen.push(next);
        return 3;
      },
      { sequenceDirectory },
    ),
  );
  try {
    await new Promise((done) => setTimeout(done, 30));
    expect(seen).toEqual([]);
  } finally {
    release?.();
  }
  await first;
  const result = await second;
  expect(seen).toEqual([104]);
  expect(result.sequenceNumber).toBe(104);
  expect(result.nextSequenceNumber).toBe(107);
});

test("invalid dynamic counts do not advance the shared counter", async () => {
  await Effect.runPromise(reserveMeshSequences(state(), 2, { sequenceDirectory }));
  const before = await readFile(await counterPath(), "utf8");
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const seen: number[] = [];
    const result = await Effect.runPromiseExit(
      reserveMeshSequences(
        state(),
        (next) => {
          seen.push(next);
          return invalid;
        },
        { sequenceDirectory },
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(seen).toEqual([9]);
    expect(await readFile(await counterPath(), "utf8")).toBe(before);
  }
  expect(
    (await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory })))
      .sequenceNumber,
  ).toBe(9);
});

test("restoring an old light file cannot roll back durable reservations", async () => {
  const path = join(directory, "state.json");
  await Effect.runPromise(saveMeshState(path, state()));
  await Effect.runPromise(reserveMeshSequences(state(), 2, { statePath: path, sequenceDirectory }));
  // Simulate losing the caller's result and restoring its old per-light hint.
  await Effect.runPromise(saveMeshState(path, state()));
  const next = await Effect.runPromise(
    reserveMeshSequences(state(), 1, { statePath: path, sequenceDirectory }),
  );
  expect(next.sequenceNumber).toBe(9);
});

test("application keys do not partition a network/source counter", async () => {
  await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory }));
  const second = await Effect.runPromise(
    reserveMeshSequences({ ...state(), appKey: new Uint8Array(16).fill(4) }, 1, {
      sequenceDirectory,
    }),
  );
  expect(second.sequenceNumber).toBe(8);
});

test("older IV states fail closed, and a new IV index has its own sequence space", async () => {
  await Effect.runPromise(
    reserveMeshSequences({ ...state(100), ivIndex: 1 }, 2, { sequenceDirectory }),
  );
  const older = await Effect.runPromiseExit(
    reserveMeshSequences(state(), 1, { sequenceDirectory }),
  );
  expect(older._tag).toBe("Failure");
  const next = await Effect.runPromise(
    reserveMeshSequences({ ...state(0), ivIndex: 2 }, 1, { sequenceDirectory }),
  );
  expect(next.sequenceNumber).toBe(0);
});

test("sequence exhaustion and corrupt counters fail instead of resetting", async () => {
  await Effect.runPromise(reserveMeshSequences(state(0xff_ffff), 1, { sequenceDirectory }));
  expect(
    (await Effect.runPromiseExit(reserveMeshSequences(state(), 1, { sequenceDirectory })))._tag,
  ).toBe("Failure");
  await writeFile(await counterPath(), "{broken");
  expect(
    (await Effect.runPromiseExit(reserveMeshSequences(state(), 1, { sequenceDirectory })))._tag,
  ).toBe("Failure");
});

test("an explicit store migration preserves the old allocator high-water mark", async () => {
  const path = join(directory, "state.json");
  await Effect.runPromise(saveMeshState(path, state()));
  await Effect.runPromise(
    reserveMeshSequences(state(), 10, { statePath: path, sequenceDirectory }),
  );
  const old = await Effect.runPromise(loadMeshState(path));
  await Effect.runPromise(saveMeshState(path, { ...old, sequenceNumber: 7 }));
  const movedDirectory = join(directory, "moved-sequences");
  const result = await Effect.runPromise(
    reserveMeshSequences({ ...old, sequenceNumber: 7 }, 1, {
      statePath: path,
      sequenceDirectory: movedDirectory,
      migrateSequenceDirectory: true,
    }),
  );
  expect(result.sequenceNumber).toBe(17);
  expect((await Effect.runPromise(loadMeshState(path))).sequenceDirectory).toBe(movedDirectory);
});

test("a chooser paused before ticket publication blocks later contenders", async () => {
  await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory }));
  const locks = `${await counterPath()}.locks`;
  let resume: (() => void) | undefined;
  let paused: (() => void) | undefined;
  const barrier = new Promise<void>((done) => {
    resume = done;
  });
  const entered = new Promise<void>((done) => {
    paused = done;
  });
  lockHooks.afterRead = async (path) => {
    if (path !== locks) return;
    lockHooks.afterRead = undefined;
    paused?.();
    await barrier;
  };
  const transmissions: number[] = [];
  const send = () =>
    Effect.runPromise(
      withMeshSequenceReservation(state(), 1, { sequenceDirectory }, (reservation) =>
        Effect.sync(() => {
          transmissions.push(reservation.sequenceNumber);
        }),
      ),
    );
  const first = send();
  await entered;
  const second = send();
  const third = send();
  try {
    await new Promise((done) => setTimeout(done, 50));
    expect(transmissions).toEqual([]);
  } finally {
    resume?.();
  }
  await Promise.all([first, second, third]);
  expect(transmissions).toEqual([8, 9, 10]);
});

test("non-finite lock deadlines fail instead of waiting indefinitely", async () => {
  for (const lockTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(
      (
        await Effect.runPromiseExit(
          reserveMeshSequences(state(), 1, { sequenceDirectory, lockTimeoutMs }),
        )
      )._tag,
    ).toBe("Failure");
  }
});

test("live lock contention has a deadline and does not remove another owner", async () => {
  await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory }));
  const locks = `${await counterPath()}.locks`;
  await mkdir(locks, { recursive: true });
  await symlink(
    JSON.stringify({ pid: process.pid, host: hostname(), token: "held", ticket: 1 }),
    join(locks, "held"),
  );
  const started = Date.now();
  const result = await Effect.runPromiseExit(
    reserveMeshSequences(state(), 1, { sequenceDirectory, lockTimeoutMs: 30 }),
  );
  expect(result._tag).toBe("Failure");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await readdir(locks)).toEqual(["held"]);
});

test("an Effect timeout interrupts lock acquisition and cleans the waiting ticket", async () => {
  await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory }));
  const locks = `${await counterPath()}.locks`;
  await symlink(
    JSON.stringify({ pid: process.pid, host: hostname(), token: "held", ticket: 1 }),
    join(locks, "held"),
  );
  const started = Date.now();
  const result = await Effect.runPromiseExit(
    withMeshSequenceReservation(state(), 1, { sequenceDirectory }, () => Effect.void).pipe(
      Effect.timeout("30 millis"),
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(Date.now() - started).toBeLessThan(500);
  expect(await readdir(locks)).toEqual(["held"]);
});

test("cancellation during transmission releases the lease and consumes its reservation", async () => {
  const timedOut = await Effect.runPromiseExit(
    withMeshSequenceReservation(state(), 2, { sequenceDirectory }, () => Effect.never).pipe(
      Effect.timeout("30 millis"),
    ),
  );
  expect(timedOut._tag).toBe("Failure");
  const next = await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory }));
  expect(next.sequenceNumber).toBe(9);
});

test("a killed lock owner is recovered without losing the durable counter", async () => {
  await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory }));
  const locks = `${await counterPath()}.locks`;
  const child = spawn(process.execPath, ["--experimental-strip-types", worker, "hold", locks], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((done, fail) => {
      child.stdout.once("data", () => done());
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`lock holder exited early: ${code}`)));
    });
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGKILL");
    await exited;
    const next = await Effect.runPromise(reserveMeshSequences(state(), 1, { sequenceDirectory }));
    expect(next.sequenceNumber).toBe(8);
    expect(await readdir(locks)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
  }
});

test("independent processes reserve disjoint blocks for two light files", async () => {
  const paths = [join(directory, "a.json"), join(directory, "b.json")];
  await Promise.all(
    paths.map((path, i) => Effect.runPromise(saveMeshState(path, state(7, i + 2)))),
  );
  const outputs = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      exec(process.execPath, [
        "--experimental-strip-types",
        worker,
        paths[i % 2]!,
        sequenceDirectory,
        "10",
      ]),
    ),
  );
  const reservations = outputs.flatMap(({ stdout }) => JSON.parse(stdout) as SequenceReservation[]);
  const ranges = reservations.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  expect(ranges).toHaveLength(80);
  let next = 7;
  for (const range of ranges) {
    expect(range.sequenceNumber).toBe(next);
    next = range.nextSequenceNumber;
  }
  const counter = JSON.parse(await readFile(await counterPath(), "utf8")) as {
    nextSequenceNumber: number;
  };
  expect(counter.nextSequenceNumber).toBe(next);
}, 20_000);
