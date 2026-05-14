#!/usr/bin/env node
import { join } from "node:path";
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import {
  defaultStatesDir,
  Domain,
  getLight,
  LightController,
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
  saveMeshState,
  scanDevices as meshScanDevices,
  shutdownNoble,
} from "@godox-tl/mesh";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };

const { Cct, Fx, Hsi, Off, Rgbw, byte, hue, kelvin, pct, sat } = Domain;

const controllerFor = (entry: { address: string; statePath: string }): LightController["Type"] =>
  makeMeshController({ address: entry.address, statePath: entry.statePath });

const scanCmd = Command.make(
  "scan",
  {
    timeout: Options.integer("timeout").pipe(Options.withDefault(10)),
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
    address: Args.text({ name: "address" }),
    name: Options.text("name"),
  },
  ({ address, name }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const statePath = join(defaultStatesDir(), `${name}.json`);
        console.log(`Provisioning ${address}...`);
        const result = yield* provisionAndRebind(address, { statePath });
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

const rebindCmd = Command.make("rebind", { name: Args.text({ name: "light" }) }, ({ name }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const state = yield* loadMeshState(entry.statePath);
      const result = yield* rebindNode(entry.address, {
        networkKey: state.networkKey,
        appKey: state.appKey,
        deviceKey: state.deviceKey,
        ivIndex: state.ivIndex,
        provisionerAddress: state.provisionerAddress,
        nodeAddress: state.nodeAddress,
        sequenceNumber: state.sequenceNumber,
      });
      yield* saveMeshState(entry.statePath, {
        ...state,
        sequenceNumber: result.sequenceNumber,
      });
      console.log(`Rebound ${entry.name}`);
    }),
  ),
);

const setCmd = Command.make(
  "set",
  {
    name: Args.text({ name: "light" }),
    brightness: Options.integer("brightness"),
    cct: Options.integer("cct"),
  },
  ({ name, brightness, cct }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = controllerFor(entry);
      yield* light.send(Cct.make({ brightness: pct(brightness), temperature: kelvin(cct) }));
    }),
);

const hsiCmd = Command.make(
  "hsi",
  {
    name: Args.text({ name: "light" }),
    brightness: Options.integer("brightness"),
    hue: Options.integer("hue"),
    saturation: Options.integer("saturation"),
  },
  ({ name, brightness, hue: hueValue, saturation }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = controllerFor(entry);
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
    name: Args.text({ name: "light" }),
    brightness: Options.integer("brightness"),
    red: Options.integer("red").pipe(Options.withDefault(0)),
    green: Options.integer("green").pipe(Options.withDefault(0)),
    blue: Options.integer("blue").pipe(Options.withDefault(0)),
    white: Options.integer("white").pipe(Options.withDefault(0)),
  },
  ({ name, brightness, red, green, blue, white }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = controllerFor(entry);
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
    name: Args.text({ name: "light" }),
    brightness: Options.integer("brightness"),
    effect: Options.integer("effect"),
    level: Options.integer("level").pipe(Options.withDefault(0)),
    filter: Options.integer("filter").pipe(Options.withDefault(0)),
  },
  ({ name, brightness, effect, level, filter }) =>
    Effect.gen(function* () {
      const entry = yield* getLight(name);
      const light = controllerFor(entry);
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

const offCmd = Command.make("off", { name: Args.text({ name: "light" }) }, ({ name }) =>
  Effect.gen(function* () {
    const entry = yield* getLight(name);
    const light = controllerFor(entry);
    yield* light.send(Off.make({}));
  }),
);

const renameCmd = Command.make(
  "rename",
  {
    oldName: Args.text({ name: "old" }),
    newName: Args.text({ name: "new" }),
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

const forgetCmd = Command.make("forget", { name: Args.text({ name: "light" }) }, ({ name }) =>
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

const main = Command.run(godox, { name: "godox", version: packageJson.version });

main(process.argv).pipe(
  Effect.ensuring(shutdownNoble),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
);
