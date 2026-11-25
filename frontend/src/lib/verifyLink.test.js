/**
 * Tests of the verify link: what the QR code encodes, and how strictly the
 * verify page reads a link it was given.
 */

import { describe, expect, it } from "vitest";

import { buildVerifyRoute, buildVerifyUrl, parseVerifyQuery } from "./verifyLink.js";

const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

/** The query a browser would hand the verify page for a given link. */
const queryOf = (url) => new URLSearchParams(url.slice(url.indexOf("?")));

describe("buildVerifyRoute", () => {
  it("is the part of the verify link after the hash", () => {
    expect(buildVerifyRoute({ lotId: 3, chainId: 31337, registry: REGISTRY })).toBe(`/verify?lot=3&chain=31337&registry=${REGISTRY}`);
  });

  it("leaves the registry out when none is known", () => {
    expect(buildVerifyRoute({ lotId: 3, chainId: 31337, registry: null })).toBe("/verify?lot=3&chain=31337");
  });
});

describe("buildVerifyUrl", () => {
  it("puts the route in the hash and names lot, chain and registry", () => {
    expect(buildVerifyUrl({ baseUrl: "http://192.168.1.20:5173/", lotId: 3, chainId: 31337, registry: REGISTRY })).toBe(
      `http://192.168.1.20:5173/#/verify?lot=3&chain=31337&registry=${REGISTRY}`,
    );
  });

  it("works for an app hosted in a sub-folder", () => {
    expect(buildVerifyUrl({ baseUrl: "https://example.org/provenance/", lotId: 12, chainId: 80002, registry: REGISTRY })).toBe(
      `https://example.org/provenance/#/verify?lot=12&chain=80002&registry=${REGISTRY}`,
    );
  });

  it("drops a hash or query that the configured base carries", () => {
    const url = buildVerifyUrl({ baseUrl: "http://localhost:5173/?x=1#/dashboard", lotId: 1, chainId: 31337, registry: REGISTRY });
    expect(url).toBe(`http://localhost:5173/#/verify?lot=1&chain=31337&registry=${REGISTRY}`);
  });
});

describe("parseVerifyQuery", () => {
  it("reads back what buildVerifyUrl wrote", () => {
    const url = buildVerifyUrl({ baseUrl: "http://localhost:5173/", lotId: 42, chainId: 31337, registry: REGISTRY });
    expect(parseVerifyQuery(queryOf(url))).toEqual({ lotId: 42, chainId: 31337, registry: REGISTRY, problems: [] });
  });

  it("accepts a link that names only the lot", () => {
    expect(parseVerifyQuery(new URLSearchParams("lot=5"))).toEqual({ lotId: 5, chainId: null, registry: null, problems: [] });
  });

  it("writes the registry address in checksum form", () => {
    const { registry } = parseVerifyQuery(new URLSearchParams(`lot=1&registry=${REGISTRY.toLowerCase()}`));
    expect(registry).toBe(REGISTRY);
  });

  it("reports a missing lot id", () => {
    const target = parseVerifyQuery(new URLSearchParams(""));
    expect(target.lotId).toBeNull();
    expect(target.problems).toEqual(["The link does not say which lot to verify."]);
  });

  it.each(["0", "-1", "1.5", "abc", "1e3", "0x10", "<script>", "9999999999999999"])("rejects the lot id %j", (text) => {
    const target = parseVerifyQuery(new URLSearchParams({ lot: text }));
    expect(target.lotId).toBeNull();
    expect(target.problems).toEqual(["The lot id in the link is not a positive whole number."]);
  });

  it("rejects a malformed chain id and a malformed registry address", () => {
    const target = parseVerifyQuery(new URLSearchParams("lot=1&chain=main&registry=0x1234"));
    expect(target).toMatchObject({ lotId: 1, chainId: null, registry: null });
    expect(target.problems).toEqual([
      "The chain id in the link is not a positive whole number.",
      "The registry address in the link is not a valid address.",
    ]);
  });

  it("rejects an address with a wrong checksum", () => {
    const wrongChecksum = REGISTRY.replace("5FbDB", "5fbDB");
    expect(parseVerifyQuery(new URLSearchParams({ lot: "1", registry: wrongChecksum })).registry).toBeNull();
  });
});
