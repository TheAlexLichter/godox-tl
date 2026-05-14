import { Domain, getLight, LightController, makeDmxLayer } from "@godox-tl/core";
import { makeMeshController } from "@godox-tl/mesh";
import { Effect, Layer } from "effect";

const { Cct, Hsi, Off, hue, kelvin, pct, sat } = Domain;

const transport = (process.env["GODOX_TRANSPORT"] ?? "mesh").toLowerCase();
const demoMode = (process.env["GODOX_DEMO"] ?? "cct").toLowerCase();
const dryRun = process.env["GODOX_DRY_RUN"] !== "0";

const program = Effect.gen(function* () {
  const light = yield* LightController;
  yield* Effect.logInfo(`transport=${transport} demo=${demoMode} dryRun=${dryRun}`);
  if (demoMode === "hsi") {
    yield* Effect.logInfo("Sending HSI hue=200 sat=80 brightness=70");
    yield* light.send(Hsi.make({ brightness: pct(70), hue: hue(200), saturation: sat(80) }));
  } else {
    yield* Effect.logInfo("Sending CCT 50% @ 4500K");
    yield* light.send(Cct.make({ brightness: pct(50), temperature: kelvin(4500) }));
    yield* Effect.sleep("500 millis");
  }
  yield* Effect.logInfo("Sending Off");
  yield* light.send(Off.make({}));
});

const main = Effect.gen(function* () {
  let deviceAddress = process.env["GODOX_DEVICE"];
  let statePath = process.env["GODOX_STATE"];
  const lightName = process.env["GODOX_LIGHT"];
  if (lightName && transport !== "dmx") {
    const entry = yield* getLight(lightName);
    deviceAddress = entry.address;
    statePath = entry.statePath;
    yield* Effect.logInfo(`Resolved light "${entry.name}" → ${entry.address}`);
  }

  const layer =
    transport === "dmx"
      ? makeDmxLayer({
          driver:
            (process.env["GODOX_DMX_DRIVER"] as
              | "null"
              | "artnet"
              | "sacn"
              | "enttec-usb-dmx-pro"
              | "enttec-open-usb-dmx"
              | "dmxking-ultra-dmx-pro"
              | undefined) ?? "null",
          mode: demoMode === "hsi" ? "HSI" : "CCT",
          startChannel: Number(process.env["GODOX_DMX_START"] ?? "1"),
          host: process.env["GODOX_DMX_HOST"],
          serialPath: process.env["GODOX_DMX_SERIAL"],
        })
      : Layer.succeed(
          LightController,
          makeMeshController({
            address: deviceAddress ?? "",
            statePath: statePath ?? "",
            dryRun,
          }),
        );

  yield* program.pipe(Effect.provide(layer));
});

Effect.runPromise(Effect.scoped(main)).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
