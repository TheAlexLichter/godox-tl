import { Data, Match } from "effect";
import type { DmxMode, LightCommand } from "./light.ts";

export class ModeMismatchError extends Data.TaggedError("ModeMismatchError")<{
  readonly mode: DmxMode;
  readonly commandTag: LightCommand["_tag"];
}> {}

const clampByte = (n: number): number => {
  const x = Math.round(n);
  return x < 0 ? 0 : x > 255 ? 255 : x;
};

// Experimental DMX mapping retained for manual-derived/internal use. Brightness
// and saturation channels accept 0-100 directly (not stretched to 0-255). CCT
// temperature, hue/2, and RGBW channels span the full 0-255 byte range.
const percentToChannel = (p: number): number => clampByte(p);
const kelvinToChannel = (k: number): number => clampByte(((k - 2800) / (6500 - 2800)) * 255);
const hueToChannel = (h: number): number => clampByte(h / 2);

export const encode = (mode: DmxMode, cmd: LightCommand): Uint8Array | ModeMismatchError =>
  Match.value(cmd).pipe(
    Match.tagsExhaustive({
      Off: () => new Uint8Array(channelCount(mode)),
      Cct: (c) =>
        mode === "CCT"
          ? Uint8Array.of(percentToChannel(c.brightness), kelvinToChannel(c.temperature))
          : new ModeMismatchError({ mode, commandTag: "Cct" }),
      Hsi: (c) =>
        mode === "HSI"
          ? Uint8Array.of(
              percentToChannel(c.brightness),
              hueToChannel(c.hue),
              percentToChannel(c.saturation),
            )
          : new ModeMismatchError({ mode, commandTag: "Hsi" }),
      Rgbw: (c) =>
        mode === "RGBW"
          ? Uint8Array.of(percentToChannel(c.brightness), c.red, c.green, c.blue, c.white)
          : new ModeMismatchError({ mode, commandTag: "Rgbw" }),
      Fx: (c) =>
        mode === "FX"
          ? Uint8Array.of(percentToChannel(c.brightness), c.effect, c.subtype, c.filter)
          : new ModeMismatchError({ mode, commandTag: "Fx" }),
    }),
  );

export const channelCount = (mode: DmxMode): number => {
  switch (mode) {
    case "CCT":
      return 2;
    case "HSI":
      return 3;
    case "RGBW":
      return 5;
    case "FX":
      return 4;
  }
};
