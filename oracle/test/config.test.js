/**
 * Tests for src/config.js: defaults that make the local
 * demo work with no configuration, validation of every variable, and the
 * guarantee that secrets cannot be printed by accident.
 *
 * loadConfig() takes the environment as an argument, so every test passes
 * its own plain object and nothing here depends on, or changes, the real
 * process environment. All "secrets" are synthetic values made up for the
 * tests.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { format, inspect } from "node:util";

import {
  DEFAULT_CORS_ORIGINS,
  IPFS_BACKENDS,
  MAX_LOG_READINGS,
  NETWORKS,
  Secret,
  UPLOAD_HARD_MAX_BYTES,
  describeConfig,
  isLoopbackHost,
  loadConfig,
  loadEnvFile,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

const ORACLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = path.resolve(ORACLE_DIR, "..");

/**
 * Synthetic secrets, assembled at run time from obvious patterns so that no
 * key-shaped or token-shaped literal exists in the repository. They are
 * attached to no wallet, account or service.
 */
const SECRETS = {
  ORACLE_PRIVATE_KEY: `0x${"5e".repeat(8)}${"c7".repeat(8)}${"e7".repeat(8)}${"0b".repeat(8)}`,
  PINATA_JWT: ["header", "payload", "signature"].map((part) => Buffer.from(`synthetic-${part}-for-tests`).toString("base64url")).join("."),
  UPLOAD_TOKEN: "upload-token-for-tests-9f3a7c21d4",
};
const RPC_KEY = "rpc-api-key-4d1e8a77c0";

/** Assert that loadConfig rejects `env` and that some problem line matches `pattern`. */
function assertRejects(env, pattern) {
  assert.throws(
    () => loadConfig(env),
    (error) => {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
      assert.ok(error.problems.some((problem) => pattern.test(problem)), `no problem matching ${pattern} in ${JSON.stringify(error.problems)}`);
      return true;
    },
  );
}

describe("defaults", () => {
  test("an empty environment gives the zero-configuration local demo", () => {
    const config = loadConfig({});
    assert.equal(config.network, "localhost");
    assert.equal(config.expectedChainId, 31337);
    assert.equal(config.rpcUrl, "http://127.0.0.1:8545");
    assert.equal(config.registryAddress, null);
    assert.equal(config.oraclePrivateKey, null);
    assert.deepEqual(config.ipfs, {
      backend: "local",
      localDir: path.join(ORACLE_DIR, ".ipfs-store"),
      kuboApiUrl: "http://127.0.0.1:5001",
      pinataJwt: null,
      gatewayUrl: null,
    });
    assert.deepEqual(config.service, {
      host: "127.0.0.1",
      port: 8787,
      corsOrigins: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"],
      maxUploadBytes: 1048576,
      uploadToken: null,
    });
    assert.deepEqual(config.simulator, { seed: 540, sampleSeconds: 60, logSize: 12 });
    assert.deepEqual(config.excursion, { runLength: 3 });
  });

  test("paths point into this repository", () => {
    const { paths } = loadConfig({});
    assert.equal(paths.packageRoot, ORACLE_DIR);
    assert.equal(paths.repoRoot, REPO_DIR);
    assert.equal(paths.deploymentFile, path.join(REPO_DIR, "deployments", "localhost.json"));
    assert.equal(paths.abiFile, path.join(REPO_DIR, "deployments", "abi", "ProvenanceRegistry.json"));
    assert.equal(paths.schemasDir, path.join(REPO_DIR, "docs", "schemas"));
    assert.equal(loadConfig({ NETWORK: "amoy" }).paths.deploymentFile, path.join(REPO_DIR, "deployments", "amoy.json"));
  });

  test("the network selects the default RPC endpoint and the expected chain id", () => {
    const amoy = loadConfig({ NETWORK: "amoy" });
    assert.equal(amoy.expectedChainId, 80002);
    assert.equal(amoy.rpcUrl, "https://polygon-amoy-bor-rpc.publicnode.com");
    assert.deepEqual(Object.keys(NETWORKS), ["localhost", "amoy"]);
    assert.equal(loadConfig({ NETWORK: "amoy", RPC_URL: "https://rpc.example/v2/key" }).rpcUrl, "https://rpc.example/v2/key");
  });

  test("the gateway default depends on the backend", () => {
    assert.equal(loadConfig({}).ipfs.gatewayUrl, null, "local: no network access unless asked for");
    assert.equal(loadConfig({ IPFS_BACKEND: "kubo" }).ipfs.gatewayUrl, "http://127.0.0.1:8080/ipfs/");
    assert.equal(loadConfig({ IPFS_BACKEND: "pinata", PINATA_JWT: SECRETS.PINATA_JWT }).ipfs.gatewayUrl, "https://ipfs.io/ipfs/");
    assert.equal(loadConfig({ IPFS_GATEWAY_URL: "https://gw.example" }).ipfs.gatewayUrl, "https://gw.example/ipfs/");
    assert.deepEqual([...IPFS_BACKENDS], ["local", "kubo", "pinata"]);
  });

  test("an empty or blank value counts as not set, and surrounding spaces are ignored", () => {
    const config = loadConfig({ NETWORK: "", IPFS_BACKEND: "   ", UPLOAD_TOKEN: "", PINATA_JWT: "", IPFS_SERVICE_PORT: " 9000 ", SIM_SEED: "" });
    assert.equal(config.network, "localhost");
    assert.equal(config.ipfs.backend, "local");
    assert.equal(config.service.uploadToken, null);
    assert.equal(config.service.port, 9000);
    assert.equal(config.simulator.seed, 540);
  });

  test("unrelated variables in the environment are ignored", () => {
    assert.equal(loadConfig({ PATH: "/usr/bin", HOME: "/home/someone", UNRELATED: "1" }).network, "localhost");
  });
});

describe("accepted values", () => {
  test("every variable can be set", () => {
    const config = loadConfig({
      NETWORK: "amoy",
      RPC_URL: `https://polygon-amoy.rpc.example/v2/${RPC_KEY}`,
      REGISTRY_ADDRESS: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      ORACLE_PRIVATE_KEY: SECRETS.ORACLE_PRIVATE_KEY,
      IPFS_BACKEND: "pinata",
      IPFS_LOCAL_DIR: "/var/tmp/provenance-store",
      KUBO_API_URL: "http://127.0.0.1:15001/",
      PINATA_JWT: SECRETS.PINATA_JWT,
      IPFS_GATEWAY_URL: "https://gateway.example/ipfs",
      IPFS_SERVICE_HOST: "0.0.0.0",
      IPFS_SERVICE_PORT: "9090",
      IPFS_SERVICE_CORS_ORIGINS: "https://dapp.example, http://localhost:5173,https://dapp.example",
      UPLOAD_MAX_BYTES: "2097152",
      UPLOAD_TOKEN: SECRETS.UPLOAD_TOKEN,
      SIM_SEED: "42",
      SIM_SAMPLE_SECONDS: "30",
      SIM_LOG_SIZE: "24",
      EXCURSION_RUN_LENGTH: "5",
    });
    assert.equal(config.network, "amoy");
    assert.equal(config.rpcUrl, `https://polygon-amoy.rpc.example/v2/${RPC_KEY}`);
    assert.equal(config.registryAddress, "0x5FbDB2315678afecb367f032d93F642f64180aa3", "normalized to checksum form");
    assert.equal(config.oraclePrivateKey.reveal(), SECRETS.ORACLE_PRIVATE_KEY);
    assert.equal(config.ipfs.backend, "pinata");
    assert.equal(config.ipfs.localDir, "/var/tmp/provenance-store");
    assert.equal(config.ipfs.kuboApiUrl, "http://127.0.0.1:15001", "trailing slash removed");
    assert.equal(config.ipfs.pinataJwt.reveal(), SECRETS.PINATA_JWT);
    assert.equal(config.ipfs.gatewayUrl, "https://gateway.example/ipfs/");
    assert.equal(config.service.host, "0.0.0.0");
    assert.equal(config.service.port, 9090);
    assert.deepEqual(config.service.corsOrigins, ["https://dapp.example", "http://localhost:5173"], "trimmed and de-duplicated");
    assert.equal(config.service.maxUploadBytes, 2097152);
    assert.equal(config.service.uploadToken.reveal(), SECRETS.UPLOAD_TOKEN);
    assert.deepEqual(config.simulator, { seed: 42, sampleSeconds: 30, logSize: 24 });
    assert.deepEqual(config.excursion, { runLength: 5 });
  });

  test("a private key without the 0x prefix is accepted and normalized", () => {
    const config = loadConfig({ ORACLE_PRIVATE_KEY: SECRETS.ORACLE_PRIVATE_KEY.slice(2).toUpperCase() });
    assert.equal(config.oraclePrivateKey.reveal(), `0x${SECRETS.ORACLE_PRIVATE_KEY.slice(2).toUpperCase()}`);
  });

  test("a relative IPFS_LOCAL_DIR is resolved against oracle/, not the current directory", () => {
    assert.equal(loadConfig({ IPFS_LOCAL_DIR: "data/store" }).ipfs.localDir, path.join(ORACLE_DIR, "data", "store"));
  });

  test("boundary values of the numeric settings", () => {
    assert.equal(loadConfig({ IPFS_SERVICE_PORT: "0" }).service.port, 0);
    assert.equal(loadConfig({ IPFS_SERVICE_PORT: "65535" }).service.port, 65535);
    assert.equal(loadConfig({ UPLOAD_MAX_BYTES: "1" }).service.maxUploadBytes, 1);
    assert.equal(loadConfig({ SIM_SEED: "0" }).simulator.seed, 0);
    assert.equal(loadConfig({ SIM_SEED: "4294967295" }).simulator.seed, 4294967295);
    assert.equal(loadConfig({ SIM_LOG_SIZE: String(MAX_LOG_READINGS) }).simulator.logSize, 2000);
    assert.equal(loadConfig({ EXCURSION_RUN_LENGTH: "1" }).excursion.runLength, 1);
    assert.equal(loadConfig({ IPFS_BACKEND: "kubo", UPLOAD_MAX_BYTES: String(UPLOAD_HARD_MAX_BYTES) }).service.maxUploadBytes, 33554432);
  });

  test("IPv4, IPv6 and host names are accepted as the bind address", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::", "localhost", "upload.internal.example"]) {
      assert.equal(loadConfig({ IPFS_SERVICE_HOST: host }).service.host, host);
    }
  });

  test("INIT_CWD, set by npm run, becomes the directory relative file arguments resolve against", () => {
    assert.equal(loadConfig({ INIT_CWD: "/somewhere/else" }).paths.invocationDir, "/somewhere/else");
    assert.equal(loadConfig({}).paths.invocationDir, process.cwd());
    assert.equal(loadConfig({ INIT_CWD: "relative/path" }).paths.invocationDir, process.cwd());
  });
});

describe("invalid values", () => {
  test("each variable is validated", () => {
    assertRejects({ NETWORK: "mainnet" }, /^NETWORK must be one of: localhost, amoy/);
    assertRejects({ RPC_URL: "localhost:8545" }, /^RPC_URL must be an http:\/\/ or https:\/\/ URL/);
    assertRejects({ RPC_URL: "ws://127.0.0.1:8545" }, /^RPC_URL/);
    assertRejects({ REGISTRY_ADDRESS: "0x1234" }, /^REGISTRY_ADDRESS is not a valid address/);
    assertRejects({ REGISTRY_ADDRESS: "0x5fbDB2315678afecb367f032d93F642f64180aa3" }, /^REGISTRY_ADDRESS/);
    assertRejects({ ORACLE_PRIVATE_KEY: "0x1234" }, /^ORACLE_PRIVATE_KEY must be 64 hex digits/);
    assertRejects({ ORACLE_PRIVATE_KEY: "this is a sentence and not a hexadecimal value at all" }, /^ORACLE_PRIVATE_KEY/);
    assertRejects({ IPFS_BACKEND: "s3" }, /^IPFS_BACKEND must be one of: local, kubo, pinata/);
    assertRejects({ KUBO_API_URL: "127.0.0.1:5001" }, /^KUBO_API_URL/);
    assertRejects({ KUBO_API_URL: "http://user:password@127.0.0.1:5001" }, /^KUBO_API_URL/);
    assertRejects({ PINATA_JWT: "just-an-api-key" }, /^PINATA_JWT does not look like a JWT/);
    assertRejects({ IPFS_BACKEND: "pinata" }, /^PINATA_JWT is required when IPFS_BACKEND=pinata/);
    assertRejects({ IPFS_GATEWAY_URL: "ipfs.io" }, /^IPFS_GATEWAY_URL/);
    assertRejects({ IPFS_GATEWAY_URL: "https://gw.example/ipfs/?token=abc" }, /^IPFS_GATEWAY_URL/);
    assertRejects({ IPFS_SERVICE_HOST: "http://127.0.0.1" }, /^IPFS_SERVICE_HOST/);
    assertRejects({ IPFS_SERVICE_HOST: "127.0.0.1:8787" }, /^IPFS_SERVICE_HOST/);
    assertRejects({ IPFS_SERVICE_PORT: "65536" }, /^IPFS_SERVICE_PORT must be a whole number from 0 to 65535/);
    assertRejects({ IPFS_SERVICE_PORT: "-1" }, /^IPFS_SERVICE_PORT/);
    assertRejects({ IPFS_SERVICE_PORT: "http" }, /^IPFS_SERVICE_PORT/);
    assertRejects({ IPFS_SERVICE_CORS_ORIGINS: "*" }, /^IPFS_SERVICE_CORS_ORIGINS entry "\*" is not an origin.*wildcards are not accepted/);
    assertRejects({ IPFS_SERVICE_CORS_ORIGINS: "http://localhost:5173/" }, /^IPFS_SERVICE_CORS_ORIGINS/);
    assertRejects({ IPFS_SERVICE_CORS_ORIGINS: "http://localhost:5173/app" }, /^IPFS_SERVICE_CORS_ORIGINS/);
    assertRejects({ IPFS_SERVICE_CORS_ORIGINS: "localhost:5173" }, /^IPFS_SERVICE_CORS_ORIGINS/);
    assertRejects({ IPFS_SERVICE_CORS_ORIGINS: "http://ok.example, null" }, /^IPFS_SERVICE_CORS_ORIGINS entry "null"/);
    assertRejects({ UPLOAD_MAX_BYTES: "0" }, /^UPLOAD_MAX_BYTES must be a whole number from 1 to 1048576/);
    assertRejects({ UPLOAD_MAX_BYTES: "1e6" }, /^UPLOAD_MAX_BYTES/);
    assertRejects({ UPLOAD_MAX_BYTES: "1048576.5" }, /^UPLOAD_MAX_BYTES/);
    assertRejects({ UPLOAD_MAX_BYTES: "0x100" }, /^UPLOAD_MAX_BYTES/);
    assertRejects({ UPLOAD_TOKEN: "short" }, /^UPLOAD_TOKEN must be at least 16 characters/);
    assertRejects({ UPLOAD_TOKEN: "contains spaces which cannot go in a header" }, /^UPLOAD_TOKEN/);
    assertRejects({ SIM_SEED: "-1" }, /^SIM_SEED/);
    assertRejects({ SIM_SEED: "4294967296" }, /^SIM_SEED must be a whole number from 0 to 4294967295/);
    assertRejects({ SIM_SEED: "demo" }, /^SIM_SEED/);
    assertRejects({ SIM_SAMPLE_SECONDS: "0" }, /^SIM_SAMPLE_SECONDS must be a whole number from 1 to 86400/);
    assertRejects({ SIM_LOG_SIZE: "0" }, /^SIM_LOG_SIZE must be a whole number from 1 to 2000/);
    assertRejects({ SIM_LOG_SIZE: "2001" }, /^SIM_LOG_SIZE/);
    assertRejects({ EXCURSION_RUN_LENGTH: "0" }, /^EXCURSION_RUN_LENGTH must be a whole number from 1 to 2000/);
    assertRejects({ EXCURSION_RUN_LENGTH: "3.5" }, /^EXCURSION_RUN_LENGTH/);
  });

  test("the local backend cannot be given an upload limit above one IPFS block", () => {
    assertRejects({ UPLOAD_MAX_BYTES: "1048577" }, /from 1 to 1048576 with IPFS_BACKEND=local/);
    assert.equal(loadConfig({ IPFS_BACKEND: "kubo", UPLOAD_MAX_BYTES: "1048577" }).service.maxUploadBytes, 1048577);
    assertRejects({ IPFS_BACKEND: "kubo", UPLOAD_MAX_BYTES: "33554433" }, /from 1 to 33554432/);
  });

  test("all problems are reported together", () => {
    assert.throws(
      () => loadConfig({ NETWORK: "mainnet", IPFS_SERVICE_PORT: "99999", SIM_LOG_SIZE: "0", UPLOAD_TOKEN: "short" }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.code, "CONFIG_INVALID");
        assert.equal(error.problems.length, 4);
        assert.match(error.message, /^Invalid configuration:\n {2}- NETWORK/);
        for (const name of ["NETWORK", "IPFS_SERVICE_PORT", "SIM_LOG_SIZE", "UPLOAD_TOKEN"]) assert.ok(error.message.includes(name));
        return true;
      },
    );
  });

  test("error messages never contain the rejected value of a secret", () => {
    const cases = {
      ORACLE_PRIVATE_KEY: "0xnot-a-key-but-still-must-not-be-echoed-0123456789",
      PINATA_JWT: "pinata-secret-that-is-not-a-jwt-0123456789",
      UPLOAD_TOKEN: "bad token with spaces 0123456789",
      // A private key pasted into the address variable by mistake.
      REGISTRY_ADDRESS: SECRETS.ORACLE_PRIVATE_KEY,
      RPC_URL: `polygon-amoy.rpc.example/v2/${RPC_KEY}`,
    };
    for (const [name, value] of Object.entries(cases)) {
      assert.throws(
        () => loadConfig({ [name]: value }),
        (error) => {
          assert.ok(error instanceof ConfigError);
          for (const rendering of [error.message, error.stack, JSON.stringify(error.problems), inspect(error)]) {
            assert.ok(!rendering.includes(value), `${name}: the value was echoed`);
            assert.ok(!rendering.includes(RPC_KEY));
          }
          return true;
        },
      );
    }
  });
});

describe("secrets", () => {
  const env = { ...SECRETS, RPC_URL: `https://polygon-amoy.rpc.example/v2/${RPC_KEY}?apikey=${RPC_KEY}`, IPFS_BACKEND: "pinata", NETWORK: "amoy" };
  const secretValues = [...Object.values(SECRETS), SECRETS.ORACLE_PRIVATE_KEY.slice(2), RPC_KEY];
  const assertClean = (rendering, how) => {
    for (const value of secretValues) assert.ok(!rendering.includes(value), `${how} printed a secret`);
  };

  test("a Secret reveals its value only through reveal()", () => {
    const secret = new Secret("hunter2-hunter2-hunter2");
    assert.equal(secret.reveal(), "hunter2-hunter2-hunter2");
    for (const rendering of [String(secret), `${secret}`, secret.toString(), JSON.stringify(secret), JSON.stringify({ secret }), inspect(secret), inspect({ nested: { secret } }, { depth: 9, showHidden: true }), format("%s %o %j", secret, secret, secret), `${[secret]}`]) {
      assert.ok(!rendering.includes("hunter2"), rendering);
      assert.ok(rendering.includes("[hidden]"));
    }
    assert.deepEqual(Object.keys(secret), []);
    assert.deepEqual({ ...secret }, {});
    assert.deepEqual(Object.getOwnPropertyNames(secret), []);
    assert.ok(Object.isFrozen(secret));
  });

  test("no printable form of the configuration contains a secret", () => {
    const config = loadConfig(env);
    assertClean(JSON.stringify(describeConfig(config)), "describeConfig");
    assertClean(JSON.stringify(config), "JSON.stringify(config)");
    assertClean(JSON.stringify(config, null, 2), "JSON.stringify(config, null, 2)");
    assertClean(JSON.stringify({ wrapped: [config] }), "nested JSON.stringify");
    assertClean(inspect(config), "util.inspect");
    assertClean(inspect(config, { depth: null, showHidden: true, getters: true }), "util.inspect with every option");
    assertClean(inspect({ wrapped: config }, { depth: null }), "nested util.inspect");
    assertClean(format("%o %O %j %s", config, config, config, config), "util.format (console.log)");
    assertClean(`${config.oraclePrivateKey} ${config.ipfs.pinataJwt} ${config.service.uploadToken}`, "string interpolation");
    assertClean(JSON.stringify(config.ipfs), "JSON.stringify(config.ipfs)");
    assertClean(inspect(config.service, { depth: null, showHidden: true }), "util.inspect(config.service)");
    assertClean(JSON.stringify(Object.entries(config.service)), "Object.entries");
  });

  test("the summary states whether each secret is set, and shows only the host of the RPC endpoint", () => {
    const summary = describeConfig(loadConfig(env));
    assert.equal(summary.oraclePrivateKey, "set (hidden)");
    assert.equal(summary.ipfs.pinataJwt, "set (hidden)");
    assert.equal(summary.service.uploadToken, "set (hidden)");
    assert.equal(summary.rpcUrl, "https://polygon-amoy.rpc.example/[hidden]");
    assert.equal(summary.network, "amoy");

    const defaults = describeConfig(loadConfig({}));
    assert.equal(defaults.oraclePrivateKey, "not set");
    assert.equal(defaults.ipfs.pinataJwt, "not set");
    assert.equal(defaults.service.uploadToken, "not set");
    assert.equal(defaults.rpcUrl, "http://127.0.0.1:8545", "a URL without path or query is shown in full");
    assert.equal(defaults.registryAddress, "from deployments/localhost.json");
    assert.equal(defaults.ipfs.gatewayUrl, "none (local store only)");
  });

  test("credentials embedded in a URL's user part are hidden too", () => {
    const summary = describeConfig(loadConfig({ RPC_URL: `https://user:${RPC_KEY}@rpc.example` }));
    assert.equal(summary.rpcUrl, "https://[hidden]@rpc.example");
    assertClean(JSON.stringify(summary), "describeConfig");
  });

  test("the secrets remain usable by the code that needs them", () => {
    const config = loadConfig(env);
    assert.equal(config.oraclePrivateKey.reveal(), SECRETS.ORACLE_PRIVATE_KEY);
    assert.equal(config.ipfs.pinataJwt.reveal(), SECRETS.PINATA_JWT);
    assert.equal(config.service.uploadToken.reveal(), SECRETS.UPLOAD_TOKEN);
    assert.ok(config.rpcUrl.includes(RPC_KEY), "the RPC URL itself is intact for the provider");
  });
});

describe("immutability and helpers", () => {
  test("the configuration is deeply frozen", () => {
    const config = loadConfig({});
    assert.ok(Object.isFrozen(config) && Object.isFrozen(config.ipfs) && Object.isFrozen(config.service) && Object.isFrozen(config.service.corsOrigins) && Object.isFrozen(config.paths));
    assert.throws(() => {
      config.network = "amoy";
    }, TypeError);
    assert.throws(() => config.service.corsOrigins.push("https://evil.example"), TypeError);
    assert.deepEqual(DEFAULT_CORS_ORIGINS.length, 4, "the shared default list was not modified");
  });

  test("two configurations do not share state", () => {
    const first = loadConfig({});
    const second = loadConfig({ IPFS_SERVICE_CORS_ORIGINS: "https://dapp.example" });
    assert.notEqual(first.service.corsOrigins, second.service.corsOrigins);
    assert.equal(first.service.corsOrigins.length, 4);
  });

  test("isLoopbackHost recognises addresses that only this machine can reach", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1"]) assert.equal(isLoopbackHost(host), true, host);
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "upload.example", "1127.0.0.1"]) assert.equal(isLoopbackHost(host), false, host);
  });

  test("loadEnvFile is a no-op when the file does not exist", () => {
    assert.equal(loadEnvFile(path.join(ORACLE_DIR, "test", "no-such-directory", "no-such-env-file")), false);
  });
});
