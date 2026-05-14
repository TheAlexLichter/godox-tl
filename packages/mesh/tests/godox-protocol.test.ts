import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  encodeHsi,
  encodeFx,
  encodeOff,
  encodeRgbw,
  encodeSet,
  VENDOR_OPCODE,
  VENDOR_OPCODE_INT,
} from "../src/godox/protocol.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

interface Fixture {
  readonly godox_v2_payload_hex: string;
  readonly vendor_opcode: number;
}

const loadFixture = (path: string): Fixture => JSON.parse(readFileSync(path, "utf8")) as Fixture;

const setDir = join(fixturesDir, "set");
const setFiles = readdirSync(setDir).filter((f) => f.endsWith(".json"));

const SET_FILENAME = /^b(\d+)-c(\d+)-seq\d+\.json$/;

for (const file of setFiles) {
  const match = SET_FILENAME.exec(file);
  if (!match) {
    throw new Error(`unexpected fixture filename: ${file}`);
  }
  const brightness = Number(match[1]);
  const kelvin = Number(match[2]);

  test(`encodeSet matches fixture ${file} (b=${brightness}, cct=${kelvin}K)`, () => {
    const fixture = loadFixture(join(setDir, file));
    const encoded = encodeSet(brightness, kelvin);
    expect(toHex(encoded)).toBe(fixture.godox_v2_payload_hex);
    expect(encoded.length).toBe(8);
    expect(fixture.vendor_opcode).toBe(VENDOR_OPCODE_INT);
  });
}

const offDir = join(fixturesDir, "off");
const offFiles = readdirSync(offDir).filter((f) => f.endsWith(".json"));

for (const file of offFiles) {
  test(`encodeOff matches fixture ${file}`, () => {
    const fixture = loadFixture(join(offDir, file));
    const encoded = encodeOff();
    expect(toHex(encoded)).toBe(fixture.godox_v2_payload_hex);
    expect(encoded.length).toBe(8);
  });
}

test("VENDOR_OPCODE encodes 0x00F011 in Telink little-endian byte order", () => {
  // 135664 = 0x021_1F0 → little-endian bytes f0 11 02.
  expect(Array.from(VENDOR_OPCODE)).toEqual([0xf0, 0x11, 0x02]);
  expect(VENDOR_OPCODE_INT).toBe(135664);
});

test("encodeHsi emits the reverse-engineered HSI payload", () => {
  expect(toHex(encodeHsi(100, 0, 100))).toBe("f16400006400005d");
  expect(toHex(encodeHsi(100, 120, 100))).toBe("f16455006400001a");
  expect(toHex(encodeHsi(100, 240, 100))).toBe("f164aa00640000d3");
});

test("encodeHsi rejects out-of-range inputs", () => {
  expect(() => encodeHsi(-1, 0, 100)).toThrow(RangeError);
  expect(() => encodeHsi(100, -1, 100)).toThrow(RangeError);
  expect(() => encodeHsi(100, 0, 101)).toThrow(RangeError);
});

test("encodeRgbw emits the reverse-engineered RGBW payload", () => {
  expect(toHex(encodeRgbw(100, 255, 0, 0, 0))).toBe("f264ff00000000e8");
  expect(toHex(encodeRgbw(100, 0, 255, 0, 0))).toBe("f26400ff000000ca");
  expect(toHex(encodeRgbw(100, 0, 0, 255, 0))).toBe("f2640000ff0000f3");
});

test("encodeRgbw rejects out-of-range inputs", () => {
  expect(() => encodeRgbw(-1, 0, 0, 0, 0)).toThrow(RangeError);
  expect(() => encodeRgbw(100, -1, 0, 0, 0)).toThrow(RangeError);
  expect(() => encodeRgbw(100, 0, 256, 0, 0)).toThrow(RangeError);
});

test("encodeFx emits the reverse-engineered FX payload", () => {
  expect(toHex(encodeFx(100, 1, 0, 0))).toBe("f3640100000000d1");
  expect(toHex(encodeFx(100, 2, 0, 0))).toBe("f36402000000009f");
  expect(toHex(encodeFx(100, 2, 1, 0))).toBe("f364020100000010");
  expect(toHex(encodeFx(100, 2, 1, 1))).toBe("f3640201010000bb");
});

test("encodeFx rejects out-of-range inputs", () => {
  expect(() => encodeFx(-1, 1, 0, 0)).toThrow(RangeError);
  expect(() => encodeFx(100, -1, 0, 0)).toThrow(RangeError);
  expect(() => encodeFx(100, 1, 256, 0)).toThrow(RangeError);
});

test("encodeSet rejects out-of-range brightness", () => {
  expect(() => encodeSet(-1, 5600)).toThrow(RangeError);
  expect(() => encodeSet(101, 5600)).toThrow(RangeError);
});

test("encodeSet rejects out-of-range kelvin", () => {
  expect(() => encodeSet(50, 2799)).toThrow(RangeError);
  expect(() => encodeSet(50, 6501)).toThrow(RangeError);
});
