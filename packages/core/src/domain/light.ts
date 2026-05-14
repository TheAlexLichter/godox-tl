import { Schema } from "effect";

export const Percent = Schema.Number.pipe(Schema.between(0, 100), Schema.brand("Percent"));
export type Percent = typeof Percent.Type;

export const Hue = Schema.Number.pipe(Schema.between(0, 360), Schema.brand("Hue"));
export type Hue = typeof Hue.Type;

export const Saturation = Schema.Number.pipe(Schema.between(0, 100), Schema.brand("Saturation"));
export type Saturation = typeof Saturation.Type;

export const Kelvin = Schema.Number.pipe(Schema.between(2800, 6500), Schema.brand("Kelvin"));
export type Kelvin = typeof Kelvin.Type;

export const Byte = Schema.Number.pipe(Schema.int(), Schema.between(0, 255), Schema.brand("Byte"));
export type Byte = typeof Byte.Type;

export const Off = Schema.TaggedStruct("Off", {});
export const Cct = Schema.TaggedStruct("Cct", {
  brightness: Percent,
  temperature: Kelvin,
});
export const Hsi = Schema.TaggedStruct("Hsi", {
  brightness: Percent,
  hue: Hue,
  saturation: Saturation,
});
export const Rgbw = Schema.TaggedStruct("Rgbw", {
  brightness: Percent,
  red: Byte,
  green: Byte,
  blue: Byte,
  white: Byte,
});
export const Fx = Schema.TaggedStruct("Fx", {
  brightness: Percent,
  effect: Byte,
  subtype: Byte,
  filter: Byte,
});

export const LightCommand = Schema.Union(Off, Cct, Hsi, Rgbw, Fx);
export type LightCommand = typeof LightCommand.Type;

export const DmxMode = Schema.Literal("CCT", "HSI", "RGBW", "FX");
export type DmxMode = typeof DmxMode.Type;

export const pct = (n: number): Percent => Percent.make(n);
export const hue = (n: number): Hue => Hue.make(n);
export const sat = (n: number): Saturation => Saturation.make(n);
export const kelvin = (n: number): Kelvin => Kelvin.make(n);
export const byte = (n: number): Byte => Byte.make(n);
