/**
 * Tests of the formatting and parsing helpers: temperatures in tenths of a
 * degree, calendar dates stored as midnight UTC, short addresses.
 */

import { describe, expect, it } from "vitest";

import { ROLES, roleLabel, roleLabelFromId, statusLabel } from "./constants.js";
import {
  dateInputToUnix,
  formatBytes,
  formatDate,
  formatDateTime,
  formatShortDateTime,
  formatTemperature,
  formatTemperatureRange,
  kebabToWords,
  parseTemperature,
  shortAddress,
  todayAsDateInput,
} from "./format.js";

describe("temperatures", () => {
  it("formats tenths of a degree with one decimal", () => {
    expect(formatTemperature(54)).toBe("5.4 °C");
    expect(formatTemperature(80)).toBe("8.0 °C");
    expect(formatTemperature(0)).toBe("0.0 °C");
    expect(formatTemperature(-205)).toBe("-20.5 °C");
  });

  it("formats a range", () => {
    expect(formatTemperatureRange(20, 80)).toBe("2.0 °C to 8.0 °C");
  });

  it.each([
    ["2", 20],
    ["8.5", 85],
    ["-20", -200],
    ["-0.5", -5],
    ["+4.0", 40],
    [" 7.3 ", 73],
    ["0", 0],
    ["-0", 0],
  ])("parses %j as %i tenths", (text, tenths) => {
    expect(parseTemperature(text)).toBe(tenths);
  });

  it.each(["", "abc", "2.55", "2,5", "1e2", ".5", "5.", "--3", "99999"])("rejects %j", (text) => {
    expect(parseTemperature(text)).toBeNull();
  });

  it("rejects a temperature the contract's int16 cannot hold", () => {
    expect(parseTemperature("3276.7")).toBe(32767);
    expect(parseTemperature("3276.8")).toBeNull();
    expect(parseTemperature("-3276.8")).toBe(-32768);
    expect(parseTemperature("-3276.9")).toBeNull();
  });
});

describe("dates", () => {
  it("converts a date input to midnight UTC, the convention of the example documents", () => {
    // manufactureDate of docs/schemas/examples/lot-metadata.example.json
    expect(dateInputToUnix("2026-11-02")).toBe(1793577600);
  });

  it.each(["", "2026-13-01", "2026-02-30", "02/11/2026", "2026-1-1"])("rejects %j as a date", (text) => {
    expect(dateInputToUnix(text)).toBeNull();
  });

  it("formats a calendar date in UTC, so it reads the same in every time zone", () => {
    expect(formatDate(1793577600)).toBe("Nov 2, 2026");
  });

  it("formats a moment with date and time", () => {
    expect(formatDateTime(1793577600 + 14 * 3600 + 5 * 60, { timeZone: "UTC" })).toBe("Nov 2, 2026, 2:05 PM");
  });

  it("formats a moment without the year where room is tight", () => {
    expect(formatShortDateTime(1793577600 + 14 * 3600 + 5 * 60, { timeZone: "UTC" })).toBe("Nov 2, 2:05 PM");
  });

  it("gives today's date in the form a date input uses", () => {
    expect(todayAsDateInput(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("labels", () => {
  it("shortens an address but keeps both ends", () => {
    expect(shortAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099…79C8");
  });

  it("formats file sizes", () => {
    expect(formatBytes(483)).toBe("483 bytes");
    expect(formatBytes(12698)).toBe("12.4 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("turns a kebab-case kind into words", () => {
    expect(kebabToWords("certificate-of-analysis")).toBe("certificate of analysis");
  });

  it("names statuses and roles", () => {
    expect([0, 1, 2, 3, 4, 5].map(statusLabel)).toEqual(["Created", "In transit", "Stored", "Delivered", "Compromised", "Recalled"]);
    expect(statusLabel(9)).toBe("Unknown status");
    expect(roleLabel("RETAILER")).toBe("Pharmacy");
    expect(roleLabel(null)).toBe("Organization");
    expect(roleLabelFromId(ROLES.ORACLE.id.toUpperCase().replace("0X", "0x"))).toBe("IoT oracle");
  });

  it("uses the role identifiers of the contract (keccak256 of the constant's name)", () => {
    // DEFAULT_ADMIN_ROLE aside, RegistryBase.sol defines every role as keccak256("<NAME>_ROLE").
    // The value below is keccak256("MANUFACTURER_ROLE") as printed by `cast keccak` / ethers.id.
    expect(ROLES.MANUFACTURER.id).toBe("0xeefb95e842a3287179d933b4460be539a1d5af11aa8b325bb45c5c8dc92de4ed");
  });
});
