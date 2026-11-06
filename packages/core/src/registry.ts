import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Data, Effect, Schema, SchemaIssue } from "effect";

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
const UnicastAddress = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0x7fff }));
const LightEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    address: Schema.String,
    statePath: Schema.String,
    nodeAddress: Schema.optionalKey(UnicastAddress),
    provisionedAt: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const RegistryJson = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ lights: Schema.Record(Schema.String, LightEntrySchema) }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
  { space: 2 },
);
const decodeRegistry = Schema.decodeUnknownSync(RegistryJson, {
  errors: "all",
  reportInput: false,
});
const encodeRegistry = Schema.encodeUnknownSync(RegistryJson);
const decodeNodeAddress = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ node_address: Schema.optionalKey(UnicastAddress) })),
  { reportInput: false },
);

const registryError = (message: string, cause: unknown): RegistryError => {
  if (!Schema.isSchemaError(cause)) return new RegistryError({ message, cause });
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1({
    leafHook: () => "Invalid value",
    checkHook: () => "Invalid value",
  })(cause.issue);
  const fields = [...new Set(issues.map((issue) => issue.path?.map(String).join(".") || "$"))];
  const detail = `invalid persisted fields: ${fields.join(", ")}`;
  // Keep only field paths; schema/parser failures may retain secret state data.
  return new RegistryError({ message: `${message}: ${detail}`, cause: new Error(detail) });
};

export const load = (
  path: string = defaultRegistryPath(),
): Effect.Effect<Registry, RegistryError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const raw = await readFile(path, "utf8");
        return decodeRegistry(raw);
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return empty;
        throw err;
      }
    },
    catch: (cause) => registryError(`failed to read ${path}`, cause),
  });

export const save = (
  data: Registry,
  path: string = defaultRegistryPath(),
): Effect.Effect<void, RegistryError> =>
  Effect.tryPromise({
    try: async () => {
      const text = encodeRegistry(data);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, `${text}\n`, "utf8");
      await rename(tmp, path);
    },
    catch: (cause) => registryError(`failed to write ${path}`, cause),
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
      return decodeNodeAddress(raw).node_address;
    },
    catch: (cause) => registryError(`failed to read state file ${statePath}`, cause),
  });
