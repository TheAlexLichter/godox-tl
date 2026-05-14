import { expect, test } from "vite-plus/test";
import { matchAddress, normalizeAddress } from "../src/ble/address.ts";
import type { PeripheralLike } from "../src/ble/noble.ts";

test("normalizeAddress strips dashes and lowercases", () => {
  expect(normalizeAddress("83E72030-EF94-6299-21DD-372408DE38C2")).toBe(
    "83e72030ef94629921dd372408de38c2",
  );
});

test("normalizeAddress strips colons (Linux MAC form)", () => {
  expect(normalizeAddress("AA:BB:CC:11:22:33")).toBe("aabbcc112233");
});

test("normalizeAddress accepts mixed punctuation and case", () => {
  expect(normalizeAddress("aa:Bb-Cc.11_22 33")).toBe("aabbcc112233");
});

test("normalizeAddress returns empty for empty / undefined / null", () => {
  expect(normalizeAddress("")).toBe("");
  expect(normalizeAddress(undefined)).toBe("");
  expect(normalizeAddress(null)).toBe("");
});

test("matchAddress matches dashed target against noble's undashed uuid", () => {
  const peripheral: PeripheralLike = {
    address: "",
    uuid: "83e72030ef94629921dd372408de38c2",
    id: "83e72030ef94629921dd372408de38c2",
    rssi: -50,
    advertisement: { localName: "GD_LED", serviceUuids: ["1828"] },
  };
  expect(matchAddress(peripheral, "83E72030-EF94-6299-21DD-372408DE38C2")).toBe(true);
});

test("matchAddress matches via Linux MAC in `address` field", () => {
  const peripheral: PeripheralLike = {
    address: "aa:bb:cc:11:22:33",
    uuid: undefined,
    id: undefined,
    rssi: -40,
    advertisement: { localName: "GD_LED", serviceUuids: ["1828"] },
  };
  expect(matchAddress(peripheral, "AA:BB:CC:11:22:33")).toBe(true);
});

test("matchAddress rejects non-matching identifiers", () => {
  const peripheral: PeripheralLike = {
    address: "aa:bb:cc:11:22:33",
    uuid: "deadbeef",
    id: "deadbeef",
    rssi: -40,
    advertisement: { localName: "x", serviceUuids: [] },
  };
  expect(matchAddress(peripheral, "11:22:33:44:55:66")).toBe(false);
});

test("matchAddress returns false for empty target (avoids matching empty fields)", () => {
  const peripheral: PeripheralLike = {
    address: "",
    uuid: "",
    id: "",
    rssi: 0,
    advertisement: { localName: "x", serviceUuids: [] },
  };
  expect(matchAddress(peripheral, "")).toBe(false);
});
