import {
  ArtnetDriver,
  DMX,
  DMXKingUltraDMXProDriver,
  EnttecOpenUSBDMXDriver,
  EnttecUSBDMXProDriver,
  NullDriver,
  SACNDriver,
} from "dmx-ts";
import type { IUniverseDriver } from "dmx-ts";
import { Config, ConfigError, Effect, Layer, Schema } from "effect";
import { channelCount, encode } from "../domain/encoder.ts";
import type { DmxMode } from "../domain/light.ts";
import { LightController, TransportError, TransportUnsupportedError } from "../light/controller.ts";

export const DmxDriverKind = Schema.Literal(
  "null",
  "artnet",
  "sacn",
  "enttec-usb-dmx-pro",
  "enttec-open-usb-dmx",
  "dmxking-ultra-dmx-pro",
);
export type DmxDriverKind = typeof DmxDriverKind.Type;

export interface DmxOptions {
  readonly driver: DmxDriverKind;
  readonly host?: string;
  readonly serialPath?: string;
  readonly mode: DmxMode;
  readonly startChannel: number;
  readonly universeName?: string;
}

const buildDriver = (opts: DmxOptions): IUniverseDriver => {
  switch (opts.driver) {
    case "null":
      return new NullDriver();
    case "artnet":
      return new ArtnetDriver(opts.host ?? "255.255.255.255");
    case "sacn":
      return new SACNDriver(1);
    case "enttec-usb-dmx-pro":
      return new EnttecUSBDMXProDriver(opts.serialPath ?? "/dev/tty.usbserial");
    case "enttec-open-usb-dmx":
      return new EnttecOpenUSBDMXDriver(opts.serialPath ?? "/dev/tty.usbserial");
    case "dmxking-ultra-dmx-pro":
      return new DMXKingUltraDMXProDriver(opts.serialPath ?? "/dev/tty.usbserial");
  }
};

export const DmxConfig = Config.all({
  driver: Config.literal(
    "null",
    "artnet",
    "sacn",
    "enttec-usb-dmx-pro",
    "enttec-open-usb-dmx",
    "dmxking-ultra-dmx-pro",
  )("GODOX_DMX_DRIVER").pipe(Config.withDefault("null" as const)),
  mode: Config.literal(
    "CCT",
    "HSI",
    "RGBW",
    "FX",
  )("GODOX_DMX_MODE").pipe(Config.withDefault("CCT" as const)),
  startChannel: Config.integer("GODOX_DMX_START").pipe(
    Config.withDefault(1),
    Config.validate({
      message: "startChannel must be in 1..512",
      validation: (n: number) => n >= 1 && n <= 512,
    }),
  ),
  host: Config.string("GODOX_DMX_HOST").pipe(Config.option),
  serialPath: Config.string("GODOX_DMX_SERIAL").pipe(Config.option),
  universeName: Config.string("GODOX_DMX_UNIVERSE").pipe(Config.withDefault("godox")),
});

const acquireUniverse = (opts: DmxOptions) =>
  Effect.tryPromise({
    try: async () => {
      const dmx = new DMX();
      const driver = buildDriver(opts);
      const universe = await dmx.addUniverse(opts.universeName ?? "godox", driver);
      return { dmx, universe };
    },
    catch: (cause) => new TransportError({ cause, message: "Failed to open DMX universe" }),
  });

const releaseUniverse = ({ dmx }: { dmx: DMX }) => Effect.promise(() => dmx.close());

export const makeDmxLayer = (
  options: DmxOptions,
): Layer.Layer<LightController, TransportError | TransportUnsupportedError> =>
  Layer.scoped(
    LightController,
    Effect.gen(function* () {
      const { startChannel, mode } = options;
      if (!Number.isInteger(startChannel) || startChannel < 1 || startChannel > 512) {
        return yield* new TransportUnsupportedError({
          transport: "dmx",
          reason: `startChannel must be an integer in 1..512, got ${startChannel}`,
        });
      }
      const lastChannel = startChannel + channelCount(mode) - 1;
      if (lastChannel > 512) {
        return yield* new TransportUnsupportedError({
          transport: "dmx",
          reason: `startChannel ${startChannel} with mode ${mode} (${channelCount(
            mode,
          )} ch) exceeds DMX universe size 512`,
        });
      }

      const { universe } = yield* Effect.acquireRelease(acquireUniverse(options), releaseUniverse);

      return LightController.of({
        send: (cmd) =>
          Effect.gen(function* () {
            const encoded = encode(mode, cmd);
            if (encoded instanceof Uint8Array) {
              const update: Record<number, number> = {};
              for (let i = 0; i < encoded.length; i += 1) {
                const byteValue = encoded[i];
                if (byteValue !== undefined) {
                  update[startChannel + i] = byteValue;
                }
              }
              yield* Effect.try({
                try: () => universe.update(update),
                catch: (cause) =>
                  new TransportError({
                    cause,
                    message: "DMX universe.update failed",
                  }),
              });
              return;
            }
            return yield* new TransportUnsupportedError({
              transport: "dmx",
              reason: `command ${encoded.commandTag} cannot be sent while DMX is in ${encoded.mode} mode`,
            });
          }),
      });
    }),
  );

export const DmxLayer: Layer.Layer<
  LightController,
  TransportError | TransportUnsupportedError | ConfigError.ConfigError
> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* DmxConfig;
    return makeDmxLayer({
      driver: cfg.driver,
      mode: cfg.mode,
      startChannel: cfg.startChannel,
      host: cfg.host._tag === "Some" ? cfg.host.value : undefined,
      serialPath: cfg.serialPath._tag === "Some" ? cfg.serialPath.value : undefined,
      universeName: cfg.universeName,
    });
  }),
);
