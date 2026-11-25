/**
 * Tests of the network table: where the registry address comes from, which
 * chain is the default, and which verify links are trusted.
 */

import { describe, expect, it } from "vitest";

import { AMOY_CHAIN_ID, LOCAL_CHAIN_ID, resolveNetworks, resolveVerifyTarget } from "./networks.js";

const LOCAL_REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER_REGISTRY = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const AMOY_REGISTRY = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";

const localRecord = { chainId: LOCAL_CHAIN_ID, address: LOCAL_REGISTRY, deployBlock: 1 };
const amoyRecord = { chainId: AMOY_CHAIN_ID, address: AMOY_REGISTRY, deployBlock: 12345678 };

describe("resolveNetworks", () => {
  it("works with no settings and no deployment: the local chain is listed without a registry", () => {
    const { networks, defaultChainId } = resolveNetworks({ env: {}, records: {}, hostname: "localhost" });
    expect(defaultChainId).toBe(LOCAL_CHAIN_ID);
    expect(Object.keys(networks)).toEqual([String(LOCAL_CHAIN_ID)]);
    expect(networks[LOCAL_CHAIN_ID]).toMatchObject({ rpcUrl: "http://localhost:8545", registry: null, deployBlock: 0, isLocal: true });
  });

  it("reads the local deployment record", () => {
    const { networks } = resolveNetworks({ env: {}, records: { localhost: localRecord }, hostname: "127.0.0.1" });
    expect(networks[LOCAL_CHAIN_ID]).toMatchObject({ rpcUrl: "http://127.0.0.1:8545", registry: LOCAL_REGISTRY, deployBlock: 1 });
  });

  it("derives the node address from the host the page was loaded from", () => {
    const { networks } = resolveNetworks({ env: {}, records: {}, hostname: "192.168.1.20" });
    expect(networks[LOCAL_CHAIN_ID].rpcUrl).toBe("http://192.168.1.20:8545");
  });

  it("falls back to the loopback address when the page has no host name", () => {
    const { networks } = resolveNetworks({ env: {}, records: {}, hostname: "" });
    expect(networks[LOCAL_CHAIN_ID].rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("lets the VITE_LOCAL_* settings override the record", () => {
    const env = {
      VITE_LOCAL_RPC_URL: "http://127.0.0.1:8546",
      VITE_LOCAL_REGISTRY_ADDRESS: OTHER_REGISTRY.toLowerCase(),
      VITE_LOCAL_DEPLOY_BLOCK: "7",
    };
    const { networks } = resolveNetworks({ env, records: { localhost: localRecord }, hostname: "localhost" });
    expect(networks[LOCAL_CHAIN_ID]).toMatchObject({ rpcUrl: "http://127.0.0.1:8546", registry: OTHER_REGISTRY, deployBlock: 7 });
  });

  it("ignores blank or malformed settings", () => {
    const env = { VITE_LOCAL_RPC_URL: "  ", VITE_LOCAL_REGISTRY_ADDRESS: "not-an-address", VITE_LOCAL_DEPLOY_BLOCK: "-3" };
    const { networks } = resolveNetworks({ env, records: { localhost: localRecord }, hostname: "localhost" });
    expect(networks[LOCAL_CHAIN_ID]).toMatchObject({ rpcUrl: "http://localhost:8545", registry: LOCAL_REGISTRY, deployBlock: 1 });
  });

  it("ignores a record file whose chain id is not the one its name promises", () => {
    const { networks } = resolveNetworks({ env: {}, records: { localhost: amoyRecord, amoy: localRecord }, hostname: "localhost" });
    expect(networks[LOCAL_CHAIN_ID].registry).toBeNull();
    expect(networks[AMOY_CHAIN_ID]).toBeUndefined();
  });

  it("lists Amoy only when its record exists, with the keyless default endpoint", () => {
    const { networks, defaultChainId } = resolveNetworks({ env: {}, records: { localhost: localRecord, amoy: amoyRecord }, hostname: "localhost" });
    expect(networks[AMOY_CHAIN_ID]).toMatchObject({
      // publicnode.com, not drpc.org: the latter's free plan refuses event queries over 100 blocks (see networks.js).
      rpcUrl: "https://polygon-amoy-bor-rpc.publicnode.com",
      registry: AMOY_REGISTRY,
      deployBlock: 12345678,
      isLocal: false,
    });
    expect(defaultChainId).toBe(LOCAL_CHAIN_ID);
  });

  it("uses Amoy by default only when nothing local is configured", () => {
    const env = { VITE_AMOY_RPC_URL: "https://rpc.example/amoy" };
    const { networks, defaultChainId } = resolveNetworks({ env, records: { amoy: amoyRecord }, hostname: "example.org" });
    expect(defaultChainId).toBe(AMOY_CHAIN_ID);
    expect(networks[AMOY_CHAIN_ID].rpcUrl).toBe("https://rpc.example/amoy");
  });
});

describe("resolveVerifyTarget", () => {
  const { networks, defaultChainId } = resolveNetworks({ env: {}, records: { localhost: localRecord, amoy: amoyRecord }, hostname: "localhost" });

  it("uses the default deployment for a link that names only the lot", () => {
    const result = resolveVerifyTarget({ chainId: null, registry: null }, networks, defaultChainId);
    expect(result).toMatchObject({ trusted: true, reason: null });
    expect(result.network.chainId).toBe(LOCAL_CHAIN_ID);
  });

  it("trusts a link that names a known chain and its known registry", () => {
    const result = resolveVerifyTarget({ chainId: AMOY_CHAIN_ID, registry: AMOY_REGISTRY }, networks, defaultChainId);
    expect(result.trusted).toBe(true);
    expect(result.network.chainId).toBe(AMOY_CHAIN_ID);
  });

  it("does not trust a link whose registry is not the known deployment", () => {
    const result = resolveVerifyTarget({ chainId: LOCAL_CHAIN_ID, registry: OTHER_REGISTRY }, networks, defaultChainId);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("The link points at a registry contract that is not the one this app knows.");
  });

  it("does not trust a registry that is right for another chain", () => {
    expect(resolveVerifyTarget({ chainId: LOCAL_CHAIN_ID, registry: AMOY_REGISTRY }, networks, defaultChainId).trusted).toBe(false);
  });

  it("does not trust a link to a chain with no known deployment", () => {
    const result = resolveVerifyTarget({ chainId: 1, registry: LOCAL_REGISTRY }, networks, defaultChainId);
    expect(result).toEqual({ network: null, trusted: false, reason: "This app has no registry deployment on chain 1." });
  });
});
