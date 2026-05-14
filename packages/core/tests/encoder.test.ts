import { Cause, Effect, Exit, Option } from "effect";
import { expect, test } from "vite-plus/test";
import { encode, ModeMismatchError } from "../src/domain/encoder.ts";
import { Cct, Fx, Hsi, Off, Rgbw, byte, hue, kelvin, pct, sat } from "../src/domain/light.ts";
import { LightController, TransportUnsupportedError } from "../src/light/controller.ts";
import { makeDmxLayer } from "../src/transports/dmx.ts";

test("CCT encodes brightness as 0..100 and temperature as 0..255 across the kelvin range", () => {
  const out = encode("CCT", Cct.make({ brightness: pct(50), temperature: kelvin(4600) }));
  expect(out).toBeInstanceOf(Uint8Array);
  if (out instanceof Uint8Array) {
    expect(out.length).toBe(2);
    expect(out[0]).toBe(50);
    expect(out[1]).toBe(Math.round(((4600 - 2800) / (6500 - 2800)) * 255));
  }
});

test("CCT minima and maxima map to channel extremes", () => {
  const low = encode("CCT", Cct.make({ brightness: pct(0), temperature: kelvin(2800) }));
  const high = encode("CCT", Cct.make({ brightness: pct(100), temperature: kelvin(6500) }));
  expect(low).toEqual(Uint8Array.of(0, 0));
  expect(high).toEqual(Uint8Array.of(100, 255));
});

test("experimental DMX HSI maps hue via /2", () => {
  const out = encode("HSI", Hsi.make({ brightness: pct(70), hue: hue(200), saturation: sat(80) }));
  expect(out).toEqual(Uint8Array.of(70, 100, 80));
});

test("RGBW emits 5 channels: brightness then RGBW bytes", () => {
  const out = encode(
    "RGBW",
    Rgbw.make({
      brightness: pct(80),
      red: byte(255),
      green: byte(128),
      blue: byte(0),
      white: byte(64),
    }),
  );
  expect(out).toEqual(Uint8Array.of(80, 255, 128, 0, 64));
});

test("FX emits 4 channels: brightness, effect, subtype, filter", () => {
  const out = encode(
    "FX",
    Fx.make({ brightness: pct(100), effect: byte(12), subtype: byte(3), filter: byte(1) }),
  );
  expect(out).toEqual(Uint8Array.of(100, 12, 3, 1));
});

test("Off zeroes every channel in the current mode", () => {
  expect(encode("CCT", Off.make({}))).toEqual(new Uint8Array(2));
  expect(encode("HSI", Off.make({}))).toEqual(new Uint8Array(3));
  expect(encode("RGBW", Off.make({}))).toEqual(new Uint8Array(5));
  expect(encode("FX", Off.make({}))).toEqual(new Uint8Array(4));
});

test("Sending an HSI command while the fixture is in CCT mode returns a typed mismatch", () => {
  const out = encode("CCT", Hsi.make({ brightness: pct(50), hue: hue(180), saturation: sat(100) }));
  expect(out).toBeInstanceOf(ModeMismatchError);
  if (out instanceof ModeMismatchError) {
    expect(out.mode).toBe("CCT");
    expect(out.commandTag).toBe("Hsi");
  }
});

test("makeDmxLayer rejects direct callers with invalid start channels", async () => {
  const layer = makeDmxLayer({
    driver: "null",
    mode: "CCT",
    startChannel: 0,
  });
  const exit = await Effect.runPromiseExit(LightController.pipe(Effect.provide(layer)));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(TransportUnsupportedError);
    }
  }
});
