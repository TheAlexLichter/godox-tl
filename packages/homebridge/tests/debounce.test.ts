import { expect, test } from "vite-plus/test";
import { Debouncer } from "../src/debounce.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("Debouncer fires once with the latest value", async () => {
  const seen: number[] = [];
  const d = new Debouncer<number>(20, (v) => seen.push(v));
  d.schedule(1);
  d.schedule(2);
  d.schedule(3);
  await delay(50);
  expect(seen).toEqual([3]);
});

test("Debouncer fires multiple times when scheduled after flush", async () => {
  const seen: number[] = [];
  const d = new Debouncer<number>(20, (v) => seen.push(v));
  d.schedule(1);
  await delay(50);
  d.schedule(2);
  await delay(50);
  expect(seen).toEqual([1, 2]);
});

test("Debouncer.flushNow fires immediately", async () => {
  const seen: number[] = [];
  const d = new Debouncer<number>(500, (v) => seen.push(v));
  d.schedule(42);
  d.flushNow();
  expect(seen).toEqual([42]);
});

test("Debouncer.flushNow is a no-op when nothing pending", () => {
  const seen: number[] = [];
  const d = new Debouncer<number>(20, (v) => seen.push(v));
  d.flushNow();
  expect(seen).toEqual([]);
});
