import { Cause, ConfigProvider, Effect, Exit, Option } from "effect";
import { expect, test } from "vite-plus/test";
import { DmxConfig } from "../src/transports/dmx.ts";

const readConfig = (values: Record<string, string>) =>
  DmxConfig.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
  );

test("DMX config preserves defaults and optional fields", async () => {
  expect(await Effect.runPromise(readConfig({}))).toEqual({
    driver: "null",
    mode: "CCT",
    startChannel: 1,
    host: Option.none(),
    serialPath: Option.none(),
    universeName: "godox",
  });
});

test("DMX config parses environment strings and accepts the last channel", async () => {
  const config = await Effect.runPromise(
    readConfig({
      GODOX_DMX_DRIVER: "artnet",
      GODOX_DMX_MODE: "RGBW",
      GODOX_DMX_START: "512",
      GODOX_DMX_HOST: "127.0.0.1",
    }),
  );
  expect(config).toMatchObject({ driver: "artnet", mode: "RGBW", startChannel: 512 });
  expect(config.host).toEqual(Option.some("127.0.0.1"));
});

test.each(["0", "513", "1.5", "oops"])("DMX config rejects invalid channel %s", async (value) => {
  const exit = await Effect.runPromiseExit(readConfig({ GODOX_DMX_START: value }));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(failure._tag === "Some" ? failure.value._tag : undefined).toBe("ConfigError");
  }
});
