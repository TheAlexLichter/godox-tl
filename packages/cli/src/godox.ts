#!/usr/bin/env node
import { join } from "node:path";
import { Argument, Command, Flag } from "effect/cli";
import { NodeServices, NodeRuntime } from "@effect/platform-node";
import {
  defaultStatesDir,
  Domain,
  getLight,
  LightNotFoundError,
  listLights,
  loadRegistry,
  register,
  removeLight,
  saveRegistry,
} from "@godox-tl/core";
import {
  loadMeshState,
  makeMeshController,
  provisionAndRebind,
  rebindNode,
  scanDevices as meshScanDevices,
  shutdownNoble,
} from "@godox-tl/mesh";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };

const { Cct, Fx, Hsi, Off, Rgbw, byte, hue, kelvin, pct, sat } = Domain;

const controllerFor = (entry: { address: string; statePath: string }) =>
  listLights().pipe(
    Effect.map((entries) =>
      makeMeshController({
        address: entry.address,
        statePath: entry.statePath,
        statePaths: entries.map((light) => light.statePath),
      }),
    ),
  );

const scanCmd = Command.make(
  "scan",
  {
    timeout: Flag.Int("timeout").pipe(Flag.withDefault(10)),
  },
  ({ timeout }) =>
    Effect.gen(function* () {
      const devices = yield* meshScanDevices({ timeoutSeconds: timeout });
      if (devices.length === 0) {
        console.log("(no Godox-like devices found)");
        return;
      }
      for (const d of devices) {
        const flag = d.unprovisioned ? " [unprovisioned]" : "";
        console.log(`${d.address}\tname=${d.name || "(none)"}\trssi=${d.rssi}${flag}`);
      }
    }),
);

const lightsCmd = Command.make("lights", {}, () =>
  Effect.gen(function* () {
    const entries = yield* listLights();
    if (entries.length === 0) {
      console.log("(no lights registered)");
      return;
    }
    for (const e of entries) {
      const node = e.nodeAddress !== undefined ? `  node=0x${e.nodeAddress.toString(16)}` : "";
      console.log(`${e.name}\t${e.address}${node}`);
      console.log(`  state: ${e.statePath}`);
    }
  }),
);

const provisionCmd = Command.make(
  "provision",
  {
    address: Argument.String("address"),
    name: Flag.String("name"),
  },
  ({ address, name }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const statePath = join(defaultStatesDir(), `${name}.json`);
        console.log(`Provisioning ${address}...`);
        const result = yield* provisionAndRebind(address, {
          statePath,
          statePaths: (yield* listLights()).map((light) => light.statePath),
        });
        const entry = yield* register({
          name,
          address,
          statePath,
          nodeAddress: result.state.nodeAddress,
        });
        console.log(`✓ Registered "${entry.name}" → ${entry.address}`);
        console.log(`  state: ${entry.statePath}`);
      }),
    ),
);

const rebindCmd = Command.make("rebind", { name: Argument.String("light") }, ({ name }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const state = yield* loadMeshState(entry.statePath);
      yield* rebindNode(entry.address, {
        networkKey: state.networkKey,
        appKey: state.appKey,
        deviceKey: state.deviceKey,
        ivIndex: state.ivIndex,
        provisionerAddress: state.provisionerAddress,
        nodeAddress: state.nodeAddress,
        sequenceNumber: state.sequenceNumber,
        sequenceDirectory: state.sequenceDirectory,
        statePath: entry.statePath,
        statePaths: (yield* listLights()).map((light) => light.statePath),
      });
      console.log(`Rebound ${entry.name}`);
    }),
  ),
);

const setCmd = Command.make(
  "set",
  {
    name: Argument.String("light"),
    brightness: Flag.Int("brightness"),
    cct: Flag.Int("cct"),
  },
  ({ name, brightness, cct }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = yield* controllerFor(entry);
      yield* light.send(Cct.make({ brightness: pct(brightness), temperature: kelvin(cct) }));
    }),
);

const hsiCmd = Command.make(
  "hsi",
  {
    name: Argument.String("light"),
    brightness: Flag.Int("brightness"),
    hue: Flag.Int("hue"),
    saturation: Flag.Int("saturation"),
  },
  ({ name, brightness, hue: hueValue, saturation }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = yield* controllerFor(entry);
      yield* light.send(
        Hsi.make({
          brightness: pct(brightness),
          hue: hue(hueValue),
          saturation: sat(saturation),
        }),
      );
    }),
);

const rgbwCmd = Command.make(
  "rgbw",
  {
    name: Argument.String("light"),
    brightness: Flag.Int("brightness"),
    red: Flag.Int("red").pipe(Flag.withDefault(0)),
    green: Flag.Int("green").pipe(Flag.withDefault(0)),
    blue: Flag.Int("blue").pipe(Flag.withDefault(0)),
    white: Flag.Int("white").pipe(Flag.withDefault(0)),
  },
  ({ name, brightness, red, green, blue, white }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = yield* controllerFor(entry);
      yield* light.send(
        Rgbw.make({
          brightness: pct(brightness),
          red: byte(red),
          green: byte(green),
          blue: byte(blue),
          white: byte(white),
        }),
      );
    }),
);

const fxCmd = Command.make(
  "fx",
  {
    name: Argument.String("light"),
    brightness: Flag.Int("brightness"),
    effect: Flag.Int("effect"),
    level: Flag.Int("level").pipe(Flag.withDefault(0)),
    filter: Flag.Int("filter").pipe(Flag.withDefault(0)),
  },
  ({ name, brightness, effect, level, filter }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = yield* controllerFor(entry);
      yield* light.send(
        Fx.make({
          brightness: pct(brightness),
          effect: byte(effect),
          subtype: byte(level),
          filter: byte(filter),
        }),
      );
    }),
);

const offCmd = Command.make("off", { name: Argument.String("light") }, ({ name }) =>
  Effect.gen(function* () {
    const entry = yield* getLight(name);
    const light = yield* controllerFor(entry);
    yield* light.send(Off.make({}));
  }),
);

const renameCmd = Command.make(
  "rename",
  {
    oldName: Argument.String("old"),
    newName: Argument.String("new"),
  },
  ({ oldName, newName }) =>
    Effect.gen(function* () {
      const reg = yield* loadRegistry();
      const entry = reg.lights[oldName];
      if (!entry) return yield* Effect.fail(new LightNotFoundError({ name: oldName }));
      if (reg.lights[newName]) {
        console.error(`Already exists: ${newName}`);
        return yield* Effect.fail(new Error(`light "${newName}" already exists`));
      }
      const next = { ...reg.lights };
      delete next[oldName];
      next[newName] = { ...entry, name: newName };
      yield* saveRegistry({ lights: next });
      console.log(`Renamed "${oldName}" → "${newName}"`);
    }),
);

const forgetCmd = Command.make("forget", { name: Argument.String("light") }, ({ name }) =>
  Effect.gen(function* () {
    yield* removeLight(name);
    console.log(`Forgot "${name}"`);
  }),
);

const godox = Command.make("godox").pipe(
  Command.withSubcommands([
    scanCmd,
    lightsCmd,
    provisionCmd,
    rebindCmd,
    setCmd,
    hsiCmd,
    rgbwCmd,
    fxCmd,
    offCmd,
    renameCmd,
    forgetCmd,
  ]),
);

const main = Command.run(godox, { version: packageJson.version });

main.pipe(Effect.ensuring(shutdownNoble), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
