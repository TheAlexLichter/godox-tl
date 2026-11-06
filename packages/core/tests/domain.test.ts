import { expect, test } from "vite-plus/test";
import { kelvin } from "../src/domain/light.ts";

test("Kelvin accepts the TL30 CCT boundaries and rejects values outside them", () => {
  expect(kelvin(2700)).toBe(2700);
  expect(kelvin(6500)).toBe(6500);
  expect(() => kelvin(2699)).toThrow();
  expect(() => kelvin(6501)).toThrow();
});
