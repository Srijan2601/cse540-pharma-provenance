/**
 * Tests for the command-line tool (src/cli). Most run the commands in-process
 * through runCli() with captured output and an explicit environment, so they
 * are fast and touch only temporary directories. Two tests start the real
 * executable as a child process, to cover what only a process has: exit
 * codes and shutdown on a signal.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCli, serviceWarnings } from "../src/cli/commands.js";
import { loadConfig } from "../src/config.js";
import { decrypt, encodeKey, generateKey, inspectEnvelope } from "../src/crypto/envelope.js";
import { DEFAULT_SCHEMAS_DIR } from "../src/documents/index.js";
import { computeContentHash, computeRawCid } from "../src/ipfs/index.js";
import { temporaryDirectory } from "./helpers/harness.js";

const MAIN = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const EXAMPLES = path.join(DEFAULT_SCHEMAS_DIR, "examples");
const utf8 = (text) => new TextEncoder().encode(text);

/**
 * A scratch workspace: a store directory, a working directory for input and
 * output files, and a run() that executes one command with captured output.
 */
async function workspace(t, extraEnv = {}) {
  const root = await temporaryDirectory(t);
  const store = path.join(root, "store");
  // INIT_CWD is what "npm run" sets; relative file arguments resolve against it.
  const env = { IPFS_LOCAL_DIR: store, INIT_CWD: root, ...extraEnv };
  const run = async (args, options = {}) => {
    const out = [];
    const err = [];
    const chunks = [];
    const code = await runCli(args, {
      env: { ...env, ...options.env },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      outBytes: (bytes) => chunks.push(Buffer.from(bytes)),
      signal: options.signal,
    });
    return { code, out: out.join("\n"), err: err.join("\n"), bytes: Buffer.concat(chunks), json: () => JSON.parse(out.join("\n")) };
  };
  const write = async (name, content) => {
    await writeFile(path.join(root, name), content);
    return name;
  };
  return { root, store, run, write };
}

describe("usage", () => {
  test("help prints the command list; no command or an unknown one is a usage error", async (t) => {
    const { run } = await workspace(t);
    const help = await run(["help"]);
    assert.equal(help.code, 0);
    for (const command of ["serve", "add <file>", "get <cid>", "verify <cid> <contentHash>", "hash <file>", "validate <file>", "config"]) {
      assert.ok(help.out.includes(command), command);
    }
    assert.equal((await run(["--help"])).code, 0);
    assert.equal((await run([])).code, 2);

    const unknown = await run(["upload-everything"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /^error: Unknown command "upload-everything"\./);
    assert.match(unknown.err, /Usage:/);
  });

  test("wrong arguments are usage errors (exit code 2)", async (t) => {
    const { run, write } = await workspace(t);
    const file = await write("a.txt", "a");
    const cases = [
      [["add"], /Expected 1 argument/],
      [["add", file, "extra"], /Expected 1 argument/],
      [["add", file, "--bogus"], /Unknown option '--bogus'/],
      [["add", "no-such-file.txt"], /Cannot read .*no-such-file\.txt: ENOENT/],
      [["add", file, "--key", encodeKey(generateKey())], /only make sense together with --encrypt/],
      [["add", file, "--encrypt", "--key", "a", "--key-file", "b"], /either --key or --key-file/],
      [["get"], /Expected 1 argument/],
      [["get", computeRawCid(utf8("a")), "--decrypt"], /--decrypt needs --key/],
      [["get", computeRawCid(utf8("a")), "--key", encodeKey(generateKey())], /only make sense together with --decrypt/],
      [["get", computeRawCid(utf8("a")), "--gateway", "not a url"], /--gateway: A gateway must be an http\(s\) URL/],
      [["verify", computeRawCid(utf8("a"))], /Expected 2 argument/],
      [["hash"], /Expected 1 argument/],
      [["validate"], /Expected 1 argument/],
      [["config", "extra"], /Expected 0 argument/],
    ];
    for (const [args, expected] of cases) {
      const result = await run(args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.err, expected);
      assert.equal(result.out, "");
    }
  });

  test("an invalid configuration is explained and exits with 1", async (t) => {
    const { run, write } = await workspace(t);
    const result = await run(["hash", await write("a.txt", "a")], { env: { IPFS_BACKEND: "floppy-disk" } });
    assert.equal(result.code, 1);
    assert.match(result.err, /^error: Invalid configuration:\n {2}- IPFS_BACKEND must be one of/);
  });
});

describe("add, get, hash", () => {
  test("add stores the file and prints its CID, content hash and size", async (t) => {
    const { run, write, store } = await workspace(t);
    const content = '{\n  "a": 1\n}\n';
    const result = await run(["add", await write("doc.json", content)]);

    assert.equal(result.code, 0);
    assert.match(result.out, /^cid {10}bafkreic6g23fmbitlbwo2zpmudulajp6rdw3zk4cxiwlm6s7zmwxwibdqm$/m);
    assert.match(result.out, new RegExp(`^contentHash {2}${computeContentHash(utf8(content))}$`, "m"));
    assert.match(result.out, /^size {9}13 bytes$/m);
    assert.match(result.out, /^stored via {3}local backend$/m);
    assert.deepEqual(await readdir(store), ["bafkreic6g23fmbitlbwo2zpmudulajp6rdw3zk4cxiwlm6s7zmwxwibdqm"]);
  });

  test("--json gives one machine-readable line", async (t) => {
    const { run, write } = await workspace(t);
    const result = await run(["add", await write("a.txt", "hello world\n"), "--json"]);
    assert.deepEqual(result.json(), {
      cid: "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4",
      contentHash: computeContentHash(utf8("hello world\n")),
      size: 12,
      encryption: null,
    });
  });

  test("hash prints what add would return, without storing anything", async (t) => {
    const { run, write, store } = await workspace(t);
    const file = await write("a.txt", "hello world\n");
    const hashed = (await run(["hash", file, "--json"])).json();
    assert.deepEqual(hashed, { cid: computeRawCid(utf8("hello world\n")), contentHash: computeContentHash(utf8("hello world\n")), size: 12 });
    assert.deepEqual(await readdir(store).catch(() => []), []);

    const { encryption: _encryption, ...added } = (await run(["add", file, "--json"])).json();
    assert.deepEqual(added, hashed);
  });

  test("hash warns when a file is too large to keep the same CID on real IPFS", async (t) => {
    const { run, write } = await workspace(t);
    const small = await run(["hash", await write("small.bin", new Uint8Array(262144))]);
    assert.equal(small.err, "");
    const chunked = await run(["hash", await write("chunked.bin", new Uint8Array(262145))]);
    assert.match(chunked.err, /larger than 262144 bytes.*different \("bafybei\.\.\."\) CID/);
    const tooBig = await run(["hash", await write("big.bin", new Uint8Array(1048577))]);
    assert.match(tooBig.err, /local backend would refuse/);
  });

  test("get writes the bytes to stdout or to --out", async (t) => {
    const { run, write, root } = await workspace(t);
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
    const { cid } = (await run(["add", await write("data.bin", binary), "--json"])).json();

    const toStdout = await run(["get", cid]);
    assert.equal(toStdout.code, 0);
    assert.deepEqual(new Uint8Array(toStdout.bytes), binary);
    assert.equal(toStdout.out, "", "nothing but the file goes to stdout");

    const toFile = await run(["get", cid, "--out", "copy.bin"]);
    assert.equal(toFile.code, 0);
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "copy.bin"))), binary);
    assert.match(toFile.err, /wrote 256 bytes to .*copy\.bin/);
  });

  test("get reports an unknown or malformed CID", async (t) => {
    const { run } = await workspace(t);
    const missing = await run(["get", computeRawCid(utf8("absent"))]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /^error: No content for CID bafkrei/);
    const malformed = await run(["get", "../../etc/passwd"]);
    assert.equal(malformed.code, 1);
    assert.match(malformed.err, /^error: Unsupported CID encoding/);
  });

  test("a file larger than the local backend's limit is refused with an explanation", async (t) => {
    const { run, write } = await workspace(t);
    const result = await run(["add", await write("big.bin", new Uint8Array(1048577))]);
    assert.equal(result.code, 1);
    assert.match(result.err, /larger than the 1048576-byte limit \(the local backend stores each file as one IPFS block\)/);
  });
});

describe("encryption", () => {
  test("add --encrypt stores an envelope and prints a new key exactly once", async (t) => {
    const { run, write, store } = await workspace(t);
    const plaintext = "Certificate of analysis (synthetic): CONFIDENTIAL-MARKER";
    const result = await run(["add", await write("coa.txt", plaintext), "--encrypt"]);

    assert.equal(result.code, 0);
    const key = /^key {10}([A-Za-z0-9_-]{43})$/m.exec(result.out)?.[1];
    assert.ok(key, "a 43-character key is printed");
    assert.equal(result.out.split(key).length, 2, "exactly once");
    assert.match(result.out, /Shown once and stored nowhere/);
    assert.match(result.out, /AES-256-GCM, envelope v1/);
    assert.ok(!result.err.includes(key));

    const cid = /^cid {10}(\S+)$/m.exec(result.out)[1];
    const stored = new Uint8Array(await readFile(path.join(store, cid)));
    assert.equal(inspectEnvelope(stored).version, 1);
    assert.equal(stored.length, plaintext.length + 13 + 16);
    assert.ok(!Buffer.from(stored).includes("CONFIDENTIAL-MARKER"), "the plaintext is not in the store");
    assert.equal(new TextDecoder().decode(await decrypt(stored, key)), plaintext);
    assert.equal(/^contentHash {2}(\S+)$/m.exec(result.out)[1], computeContentHash(stored), "the hash covers the encrypted bytes");

    // The key exists only in the command's output: not in the store, not in any file of the workspace.
    for (const file of await readdir(store)) {
      assert.ok(!(await readFile(path.join(store, file))).includes(key));
    }
  });

  test("get --decrypt returns the original file; a wrong key or a plaintext file is an error", async (t) => {
    const { run, write, root } = await workspace(t);
    const original = Uint8Array.from({ length: 500 }, (_, i) => (i * 31) & 0xff);
    const added = (await run(["add", await write("report.bin", original), "--encrypt", "--json"])).json();
    assert.deepEqual(added.encryption, { scheme: "AES-256-GCM", envelope: 1 });
    assert.match(added.key, /^[A-Za-z0-9_-]{43}$/);

    const decrypted = await run(["get", added.cid, "--decrypt", "--key", added.key]);
    assert.equal(decrypted.code, 0);
    assert.deepEqual(new Uint8Array(decrypted.bytes), original);

    await writeFile(path.join(root, "handover.txt"), `${added.key}\n`);
    const viaFile = await run(["get", added.cid, "--decrypt", "--key-file", "handover.txt", "--out", "report.out.bin"]);
    assert.equal(viaFile.code, 0);
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "report.out.bin"))), original);

    const wrongKey = await run(["get", added.cid, "--decrypt", "--key", encodeKey(generateKey())]);
    assert.equal(wrongKey.code, 1);
    assert.match(wrongKey.err, /^error: Decryption failed: the key is wrong, or the file was modified/);
    assert.equal(wrongKey.bytes.length, 0, "nothing is written when decryption fails");

    const badKey = await run(["get", added.cid, "--decrypt", "--key", "tooshort"]);
    assert.equal(badKey.code, 1);
    assert.match(badKey.err, /43 base64url characters/);

    const plain = (await run(["add", await write("plain.txt", "this file was never encrypted, it is plain text"), "--json"])).json();
    const notEncrypted = await run(["get", plain.cid, "--decrypt", "--key", added.key]);
    assert.equal(notEncrypted.code, 1);
    assert.match(notEncrypted.err, /Unsupported envelope version/);

    const raw = await run(["get", added.cid]);
    assert.equal(raw.bytes[0], 0x01, "without --decrypt the envelope itself is returned");
  });

  test("a key that starts with a dash can be passed as --key <value>", async (t) => {
    // "-" is one of the 64 base64url characters, so one generated key in 64 starts with it. The
    // two synthetic keys below encode to "-..." and "--...".
    for (const bytes of [new Uint8Array(32).fill(0xfb), Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0xfb : 0xef))]) {
      const key = encodeKey(bytes);
      assert.ok(key.startsWith("-"), key);
      const { run, write } = await workspace(t);
      const added = await run(["add", await write("note.txt", "kept confidential"), "--encrypt", "--key", key, "--json"]);
      assert.equal(added.code, 0, added.err);
      const decrypted = await run(["get", added.json().cid, "--decrypt", "--key", key]);
      assert.equal(decrypted.code, 0, decrypted.err);
      assert.equal(decrypted.bytes.toString("utf8"), "kept confidential");
      assert.equal((await run(["get", added.json().cid, "--decrypt", `--key=${key}`])).code, 0);
    }
  });

  test("a supplied key is used and never echoed", async (t) => {
    const { run, write, root } = await workspace(t);
    const key = encodeKey(generateKey());
    await writeFile(path.join(root, "shared-key.txt"), key);
    const file = await write("invoice.txt", "synthetic commercial invoice");

    for (const keyArgs of [["--key", key], ["--key-file", "shared-key.txt"]]) {
      const human = await run(["add", file, "--encrypt", ...keyArgs]);
      assert.equal(human.code, 0);
      assert.ok(!human.out.includes(key) && !human.err.includes(key), "the caller already has the key; it is not printed");
      assert.ok(!/^key /m.test(human.out));

      const json = (await run(["add", file, "--encrypt", ...keyArgs, "--json"])).json();
      assert.ok(!("key" in json));
      const back = await run(["get", json.cid, "--decrypt", "--key", key]);
      assert.equal(back.bytes.toString(), "synthetic commercial invoice");
    }
  });

  test("encrypting the same file twice gives different CIDs, so ciphertexts cannot be matched", async (t) => {
    const { run, write } = await workspace(t);
    const file = await write("same.txt", "same plaintext");
    const first = (await run(["add", file, "--encrypt", "--json"])).json();
    const second = (await run(["add", file, "--encrypt", "--json"])).json();
    assert.notEqual(first.cid, second.cid);
    assert.notEqual(first.key, second.key);
  });
});

describe("verify", () => {
  test("verifies stored content against its on-chain reference", async (t) => {
    const { run } = await workspace(t);
    const added = (await run(["add", path.join(EXAMPLES, "sensor-log.example.json"), "--json"])).json();
    const result = await run(["verify", added.cid, added.contentHash]);

    assert.equal(result.code, 0);
    assert.match(result.out, /^source {8}local backend$/m);
    assert.match(result.out, /^size {10}1020 bytes$/m);
    assert.match(result.out, new RegExp(`^content hash {2}MATCH {4}keccak256\\(bytes\\) = ${added.contentHash}$`, "m"));
    assert.match(result.out, /^CID digest {4}MATCH {4}sha2-256 of the bytes equals the digest in the CID$/m);
    assert.match(result.out, /^document {6}sensor-log v1, valid against its schema$/m);
    assert.match(result.out, /^result {8}VERIFIED: content hash and CID digest both match$/m);
  });

  test("fails with exit code 1 when the hash does not match", async (t) => {
    const { run, write } = await workspace(t);
    const added = (await run(["add", await write("a.txt", "genuine"), "--json"])).json();
    const otherHash = computeContentHash(utf8("something else"));

    const result = await run(["verify", added.cid, otherHash]);
    assert.equal(result.code, 1);
    assert.match(result.out, /^content hash {2}MISMATCH keccak256/m);
    assert.match(result.out, new RegExp(`expected ${otherHash}`));
    assert.match(result.out, /^result {8}NOT VERIFIED: the bytes do not hash to the expected content hash$/m);

    const malformed = await run(["verify", added.cid, "0x1234"]);
    assert.equal(malformed.code, 1);
    assert.match(malformed.out, /not a 32-byte hex value/);
  });

  test("--file checks a local copy, and catches a tampered one", async (t) => {
    const { run, write } = await workspace(t);
    const bytes = await readFile(path.join(EXAMPLES, "regulator-certificate.example.json"));
    const cid = computeRawCid(bytes);
    const contentHash = computeContentHash(bytes);

    const genuine = await run(["verify", cid, contentHash, "--file", path.join(EXAMPLES, "regulator-certificate.example.json"), "--json"]);
    assert.equal(genuine.code, 0);
    assert.equal(genuine.json().ok, true);
    assert.equal(genuine.json().document, "regulator-certificate v1, valid against its schema");

    const tamperedFile = await write("tampered.json", bytes.toString().replace("Batch release", "Batch reIease"));
    const tampered = await run(["verify", cid, contentHash, "--file", tamperedFile, "--json"]);
    assert.equal(tampered.code, 1);
    const report = tampered.json();
    assert.equal(report.ok, false);
    assert.equal(report.contentHash.matches, false);
    assert.equal(report.cid.matches, false);
  });

  test("a store file edited after upload is reported, not verified", async (t) => {
    const { run, write, store } = await workspace(t);
    const added = (await run(["add", await write("log.json", '{"tenthsC": 54}\n'), "--json"])).json();
    await writeFile(path.join(store, added.cid), '{"tenthsC": 94}\n');

    const result = await run(["verify", added.cid, added.contentHash]);
    assert.equal(result.code, 1);
    assert.match(result.out, /NOT VERIFIED: Content from the local store does not match the sha2-256 digest/);
    assert.equal((await run(["verify", added.cid, added.contentHash, "--json"])).json().ok, false);
  });

  test("an encrypted file verifies without its key, and is not mistaken for a document", async (t) => {
    const { run, write } = await workspace(t);
    const added = (await run(["add", await write("coa.txt", "confidential"), "--encrypt", "--json"])).json();
    const result = await run(["verify", added.cid, added.contentHash]);
    assert.equal(result.code, 0);
    assert.ok(!/^document/m.test(result.out));
  });

  test("verifies the committed example attachments against the lot-metadata example", async (t) => {
    const { run } = await workspace(t);
    const lot = JSON.parse(await readFile(path.join(EXAMPLES, "lot-metadata.example.json"), "utf8"));
    const files = ["storage-instructions.txt", "certificate-of-analysis.txt.enc"];
    for (const [index, file] of files.entries()) {
      const { cid, contentHash } = lot.attachments[index];
      assert.equal((await run(["verify", cid, contentHash, "--file", path.join(EXAMPLES, "attachments", file)])).code, 0, file);
    }
  });
});

describe("validate", () => {
  test("accepts every example document", async (t) => {
    const { run } = await workspace(t);
    for (const [file, type] of Object.entries({
      "lot-metadata.example.json": "lot-metadata",
      "regulator-certificate.example.json": "regulator-certificate",
      "sensor-log.example.json": "sensor-log",
      "sensor-log.excursion.example.json": "sensor-log",
    })) {
      const result = await run(["validate", path.join(EXAMPLES, file)]);
      assert.equal(result.code, 0, file);
      assert.match(result.out, new RegExp(`^valid ${type} document \\(schemaVersion 1\\)$`, "m"));
      assert.match(result.out, /^cid {10}bafkrei/m);
      assert.equal((await run(["validate", path.join(EXAMPLES, file), "--type", type])).code, 0);
    }
  });

  test("lists every problem of an invalid document and exits with 1", async (t) => {
    const { run, write } = await workspace(t);
    const document = JSON.parse(await readFile(path.join(EXAMPLES, "sensor-log.example.json"), "utf8"));
    document.lotId = "1";
    document.readings[2].tenthsC = 5.1;
    document.comment = "typo field";
    const file = await write("broken.json", JSON.stringify(document));

    const result = await run(["validate", file]);
    assert.equal(result.code, 1);
    assert.match(result.out, /^INVALID sensor-log document: .*broken\.json$/m);
    assert.match(result.out, /^ {2}\/lotId: must be integer$/m);
    assert.match(result.out, /^ {2}\/readings\/2\/tenthsC: must be integer$/m);
    assert.match(result.out, /^ {2}\(document\): has the unknown property "comment"$/m);

    const json = (await run(["validate", file, "--json"])).json();
    assert.equal(json.valid, false);
    assert.equal(json.type, "sensor-log");
    assert.equal(json.errors.length, 3);
  });

  test("--type rejects a valid document of another type; non-JSON files are reported", async (t) => {
    const { run, write } = await workspace(t);
    const mismatch = await run(["validate", path.join(EXAMPLES, "sensor-log.example.json"), "--type", "lot-metadata"]);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.out, /expected a "lot-metadata" document but "type" is "sensor-log"/);

    const notJson = await run(["validate", await write("notes.txt", "not json at all")]);
    assert.equal(notJson.code, 1);
    assert.match(notJson.out, /not valid JSON/);
  });
});

describe("config", () => {
  test("prints the effective configuration without any secret", async (t) => {
    const { run, store } = await workspace(t);
    const jwt = ["header", "payload", "signature"].map((part) => Buffer.from(`cli-test-${part}`).toString("base64url")).join(".");
    const token = "cli-test-upload-token-123456";
    const key = "ab".repeat(32);
    const result = await run(["config"], { env: { IPFS_BACKEND: "pinata", PINATA_JWT: jwt, UPLOAD_TOKEN: token, ORACLE_PRIVATE_KEY: key, RPC_URL: "https://rpc.example/v2/cli-test-rpc-key" } });

    assert.equal(result.code, 0);
    for (const secret of [jwt, token, key, "cli-test-rpc-key"]) assert.ok(!result.out.includes(secret));
    const printed = result.json();
    assert.equal(printed.ipfs.backend, "pinata");
    assert.equal(printed.ipfs.localDir, store);
    assert.equal(printed.ipfs.pinataJwt, "set (hidden)");
    assert.equal(printed.service.uploadToken, "set (hidden)");
    assert.equal(printed.oraclePrivateKey, "set (hidden)");
    assert.equal(printed.rpcUrl, "https://rpc.example/[hidden]");
  });
});

describe("serve", () => {
  /** Start `serve` in-process on a free port and return its URL plus a stop() that waits for the exit code. */
  async function serve(t, env = {}) {
    const controller = new AbortController();
    const lines = [];
    const out = [];
    const finished = runCli(["serve"], {
      env,
      out: (line) => out.push(line),
      err: (line) => lines.push(line),
      signal: controller.signal,
    });
    t.after(() => controller.abort());
    // The first diagnostic line announces the address once the port is bound.
    for (let attempt = 0; attempt < 200 && !lines.some((line) => line.includes("listening on")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const url = /listening on (http:\/\/\S+)/.exec(lines.join("\n"))?.[1];
    assert.ok(url, `the service did not start: ${lines.join("\n")}`);
    const stop = async () => {
      controller.abort();
      return finished;
    };
    return { url, lines, stop };
  }

  test("serves what add stored, accepts uploads, and stops cleanly when signalled", async (t) => {
    const { run, write, store } = await workspace(t);
    const added = (await run(["add", await write("a.json", '{"from": "cli"}\n'), "--json"])).json();
    const { url, lines, stop } = await serve(t, { IPFS_LOCAL_DIR: store, IPFS_SERVICE_PORT: "0" });

    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, backend: "local", maxUploadBytes: 1048576 });
    const fetched = await fetch(`${url}/ipfs/${added.cid}`);
    assert.equal(fetched.headers.get("content-type"), "application/json");
    assert.equal(await fetched.text(), '{"from": "cli"}\n');

    const uploaded = await (await fetch(`${url}/upload`, { method: "POST", body: "from the browser" })).json();
    const verified = await run(["verify", uploaded.cid, uploaded.contentHash]);
    assert.equal(verified.code, 0, "the CLI reads what the service stored: one shared directory");
    const viaGateway = await run(["verify", added.cid, added.contentHash, "--gateway", url]);
    assert.equal(viaGateway.code, 0);
    assert.match(viaGateway.out, new RegExp(`^source {8}gateway ${url}/ipfs/$`, "m"));
    assert.equal((await run(["get", uploaded.cid, "--gateway", url])).bytes.toString(), "from the browser");

    assert.equal(await stop(), 0);
    const log = lines.join("\n");
    assert.match(log, /backend {12}local/);
    assert.match(log, /upload token {7}not required/);
    assert.match(log, /POST \/upload 201/);
    assert.match(log, /Service stopped\.$/);
    await assert.rejects(fetch(`${url}/health`));
  });

  test("add --service uploads through a running service, sending the configured token", async (t) => {
    const token = "cli-test-upload-token-abcdef";
    const { run, write, store } = await workspace(t, { UPLOAD_TOKEN: token });
    const { url, lines } = await serve(t, { IPFS_LOCAL_DIR: store, IPFS_SERVICE_PORT: "0", UPLOAD_TOKEN: token });
    assert.match(lines.join("\n"), /upload token {7}required/);

    assert.equal((await fetch(`${url}/upload`, { method: "POST", body: "no token" })).status, 401);
    const result = await run(["add", await write("b.txt", "through the service"), "--service", url]);
    assert.equal(result.code, 0);
    assert.match(result.out, new RegExp(`^stored via {3}service ${url}$`, "m"));
    assert.ok(!result.out.includes(token) && !lines.join("\n").includes(token));
    assert.deepEqual(await readdir(store), [computeRawCid(utf8("through the service"))]);

    const withoutToken = await run(["add", await write("c.txt", "rejected"), "--service", url], { env: { UPLOAD_TOKEN: "" } });
    assert.equal(withoutToken.code, 1);
    assert.match(withoutToken.err, /HTTP 401/);
  });
});

describe("serviceWarnings", () => {
  test("warns when the service is reachable from other machines without an upload token", () => {
    assert.deepEqual(serviceWarnings(loadConfig({})), [], "the default binds to the loopback interface");
    assert.deepEqual(serviceWarnings(loadConfig({ IPFS_SERVICE_HOST: "::1" })), []);

    const exposed = serviceWarnings(loadConfig({ IPFS_SERVICE_HOST: "0.0.0.0" }));
    assert.equal(exposed.length, 1);
    assert.match(exposed[0], /listening on 0\.0\.0\.0 without UPLOAD_TOKEN/);

    assert.deepEqual(serviceWarnings(loadConfig({ IPFS_SERVICE_HOST: "0.0.0.0", UPLOAD_TOKEN: "a-long-enough-test-token" })), []);
  });
});

describe("the executable", () => {
  /** Run src/cli/main.js as a child process with a minimal environment. */
  function execute(args, env, { onStderr } = {}) {
    const child = spawn(process.execPath, [MAIN, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderr?.(stderr, child);
    });
    const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, exited };
  }

  test("sets the exit code: 0 for success, 1 for a failed check, 2 for wrong usage", async (t) => {
    const root = await temporaryDirectory(t);
    const env = { IPFS_LOCAL_DIR: path.join(root, "store") };
    const example = path.join(EXAMPLES, "sensor-log.example.json");

    const ok = await execute(["validate", example], env).exited;
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /^valid sensor-log document/);

    const bytes = await readFile(example);
    const failed = await execute(["verify", computeRawCid(bytes), computeContentHash(utf8("other")), "--file", example], env).exited;
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /NOT VERIFIED/);

    const usage = await execute(["frobnicate"], env).exited;
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /Unknown command "frobnicate"/);

    const misconfigured = await execute(["config"], { ...env, IPFS_SERVICE_PORT: "seventy" }).exited;
    assert.equal(misconfigured.code, 1);
    assert.match(misconfigured.stderr, /^error: Invalid configuration:/);
    assert.ok(!misconfigured.stderr.includes("    at "), "a known error is explained without a stack trace");
  });

  test("serve shuts down gracefully on SIGTERM and exits with 0", async (t) => {
    const root = await temporaryDirectory(t);
    let signalled = false;
    const { exited } = execute(["serve"], { IPFS_LOCAL_DIR: path.join(root, "store"), IPFS_SERVICE_PORT: "0" }, {
      onStderr: (stderr, child) => {
        if (!signalled && stderr.includes("Press Ctrl+C to stop.")) {
          signalled = true;
          child.kill("SIGTERM");
        }
      },
    });
    const result = await exited;
    assert.equal(result.signal, null, "the process ended by itself, it was not killed by the signal");
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Upload \+ gateway service listening on http:\/\/127\.0\.0\.1:\d+/);
    assert.match(result.stderr, /Shutting down: finishing requests in progress\.\.\.\nService stopped\.\n$/);
  });
});
