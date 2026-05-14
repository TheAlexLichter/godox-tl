import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";

export interface LightEntry {
  readonly name: string;
  readonly address: string;
  readonly statePath: string;
  readonly nodeAddress?: number;
  readonly provisionedAt: string;
}

export interface Registry {
  readonly lights: Record<string, LightEntry>;
}

export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class LightNotFoundError extends Data.TaggedError("LightNotFoundError")<{
  readonly name: string;
}> {}

export const configDir = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg ? join(xdg, "godox-tl") : join(homedir(), ".config", "godox-tl");
};

export const defaultRegistryPath = (): string => join(configDir(), "registry.json");
export const defaultStatesDir = (): string => join(configDir(), "states");

const empty: Registry = { lights: {} };

export const load = (
  path: string = defaultRegistryPath(),
): Effect.Effect<Registry, RegistryError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as Registry;
        if (!parsed.lights || typeof parsed.lights !== "object") {
          return empty;
        }
        return parsed;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty;
        throw err;
      }
    },
    catch: (cause) => new RegistryError({ cause, message: `failed to read ${path}` }),
  });

export const save = (
  data: Registry,
  path: string = defaultRegistryPath(),
): Effect.Effect<void, RegistryError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tmp, path);
    },
    catch: (cause) => new RegistryError({ cause, message: `failed to write ${path}` }),
  });

export interface RegisterInput {
  readonly name: string;
  readonly address: string;
  readonly statePath: string;
  readonly nodeAddress?: number;
}

export const register = (
  input: RegisterInput,
  path: string = defaultRegistryPath(),
): Effect.Effect<LightEntry, RegistryError> =>
  load(path).pipe(
    Effect.flatMap((reg) => {
      const entry: LightEntry = {
        name: input.name,
        address: input.address,
        statePath: input.statePath,
        ...(input.nodeAddress !== undefined ? { nodeAddress: input.nodeAddress } : {}),
        provisionedAt: new Date().toISOString(),
      };
      const next: Registry = { lights: { ...reg.lights, [input.name]: entry } };
      return save(next, path).pipe(Effect.as(entry));
    }),
  );

export const getLight = (
  name: string,
  path: string = defaultRegistryPath(),
): Effect.Effect<LightEntry, RegistryError | LightNotFoundError> =>
  load(path).pipe(
    Effect.flatMap((reg): Effect.Effect<LightEntry, LightNotFoundError> => {
      const entry = reg.lights[name];
      return entry ? Effect.succeed(entry) : Effect.fail(new LightNotFoundError({ name }));
    }),
  );

export const removeLight = (
  name: string,
  path: string = defaultRegistryPath(),
): Effect.Effect<void, RegistryError | LightNotFoundError> =>
  load(path).pipe(
    Effect.flatMap((reg): Effect.Effect<void, RegistryError | LightNotFoundError> => {
      if (!reg.lights[name]) return Effect.fail(new LightNotFoundError({ name }));
      const next: Record<string, LightEntry> = { ...reg.lights };
      delete next[name];
      return save({ lights: next }, path);
    }),
  );

export const listLights = (
  path: string = defaultRegistryPath(),
): Effect.Effect<ReadonlyArray<LightEntry>, RegistryError> =>
  load(path).pipe(Effect.map((reg) => Object.values(reg.lights)));

export const readNodeAddress = (
  statePath: string,
): Effect.Effect<number | undefined, RegistryError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(statePath, "utf8");
      const state = JSON.parse(raw) as { node_address?: number };
      return state.node_address;
    },
    catch: (cause) =>
      new RegistryError({ cause, message: `failed to read state file ${statePath}` }),
  });
