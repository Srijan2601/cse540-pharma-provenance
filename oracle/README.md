# oracle/: off-chain storage, upload service, document formats, IoT oracle

The off-chain half of the project ("Off-Chain and IoT" workstream). It is its own Node.js 22 npm project, independent of the root Hardhat project.

| Part | Where | State |
|---|---|---|
| IPFS storage library: CIDs, content hashes, three storage backends | `src/ipfs/` | built, tested |
| Upload + gateway HTTP service for the dApp and the verify page | `src/service/` | built, tested |
| Encryption of confidential documents (AES-256-GCM envelope) | `src/crypto/` | built, tested |
| Document schemas, builders and validators | `src/documents/`, [`../docs/schemas/`](../docs/schemas/) | built, tested |
| Command-line tool for storage and documents | `src/cli/` | built, tested |
| Sensor simulator: seeded, four scenarios | `src/simulator/` | built, tested |
| IoT oracle: excursion rule, registry client, runner | `src/oracle/` | built, tested; also run against the real contract on a Hardhat node (`npm run test:e2e`, see [Tests](#tests)) |
| Configuration (the only code that reads environment variables) | `src/config.js` | built, tested |

Real sensors are out of scope (proposal section 6); readings are simulated.

## How it fits the system

```
 manufacturer / regulator                IoT oracle (Node.js)
 dApp in the browser                     simulated readings -> excursion rule -> sensor-log JSON
        |                                        |
        |  POST /upload (file bytes)             |  storage.add(bytes)
        v                                        v
 +-----------------------------------------------------------+
 | upload + gateway service        storage library           |
 |   holds the pinning credential    local | kubo | pinata   |
 +-----------------------------------------------------------+
        |  { cid, contentHash }                  |  { cid, contentHash }
        v                                        v
 registerBatch / issueCertificate        anchorSensorLog / reportExcursion   (signed with the ORACLE key)
        \_______________ ProvenanceRegistry ________________/
                               |
                               |  verifyBatch(lotId) -> DocumentRef { cid, contentHash }
                               v
 patient verify page:  GET <gateway>/ipfs/<cid>  ->  keccak256(bytes) == contentHash ?
```

Two values describe every off-chain file, and both go on-chain in a `DocumentRef`:

* `cid`: where the file is on IPFS.
* `contentHash`: `keccak256` of the exact uploaded bytes. This is what a verifier recomputes (design decision **O1**).

Design decisions from [`../docs/design-decisions.md`](../docs/design-decisions.md) that this package settles:

| ID | Decision |
|---|---|
| **O2** | The three documents have JSON Schemas with synthetic examples in [`../docs/schemas/`](../docs/schemas/). |
| **O3** | The dApp uploads through a small service that holds the pinning credential; the browser never sees it. |
| **O5** | Lot metadata, certificates and sensor logs are public plaintext. Confidential attachments are encrypted before upload; the hash covers the ciphertext. Personal data is never uploaded. |
| **C7** (off-chain part) | The contract checks that a reported reading is outside the lot's range. *When* to report is decided here: K consecutive out-of-range readings (see [The excursion rule](#the-excursion-rule)). |

## Quick start (local, zero configuration)

Needs Node.js 22.13 or newer. No account, API key, IPFS node or `.env` file is required: files are stored in `oracle/.ipfs-store/` (gitignored).

```bash
cd oracle
npm ci
npm test              # about 520 tests, about 10 seconds
npm run service       # upload + gateway service on http://127.0.0.1:8787, Ctrl+C to stop
```

In a second terminal:

```bash
cd oracle

# store a document; prints the two values that go on-chain
npm run ipfs:add -- ../docs/schemas/examples/sensor-log.example.json
#   cid          bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi
#   contentHash  0x643aee49a5cee8cda76e05dcbca98c1d25e31542a9abf73617d3d0caa55ed91a
#   size         1020 bytes
#   stored via   local backend

# fetch it the way the verify page does
curl -s http://127.0.0.1:8787/ipfs/bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi

# check it against the on-chain hash (exit status 0 only if it matches)
npm run ipfs:verify -- bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi \
  0x643aee49a5cee8cda76e05dcbca98c1d25e31542a9abf73617d3d0caa55ed91a --gateway http://127.0.0.1:8787
#   content hash  MATCH    keccak256(bytes) = 0x643aee49...
#   CID digest    MATCH    sha2-256 of the bytes equals the digest in the CID
#   document      sensor-log v1, valid against its schema
#   result        VERIFIED: content hash and CID digest both match

# upload like the dApp does
curl -s -X POST --data-binary @../docs/schemas/examples/lot-metadata.example.json \
  'http://127.0.0.1:8787/upload?name=lot-metadata.json'
#   {"cid":"bafkreifn24qape4xzzat2w7znw37pxyysyc5nu7fq55oerxvdlyo4vxfky","contentHash":"0xd6257e1c...","size":1281}

# encrypt a confidential attachment before upload; the key is printed once
npm run ipfs:add -- ../docs/schemas/examples/attachments/storage-instructions.txt --encrypt

# look at simulated sensor readings and what the excursion rule makes of them (no chain needed)
npm run simulate -- --scenario excursion
```

The oracle itself needs a deployed registry. With the local Hardhat node of the root project running and the contract deployed (`npm run node`, `npm run deploy:local`, `npm run roles:local` in the repository root):

```bash
npm run oracle:check                                   # pre-flight checks only
npm run oracle:once -- --lot 1                         # anchor one sensor log for lot 1 now
npm run oracle:once -- --lot 1 --scenario excursion    # report an excursion: lot 1 becomes Compromised
SIM_SAMPLE_SECONDS=5 npm run oracle                    # watch every active lot until Ctrl+C
```

The service, the CLI and the oracle share one store directory, so a file added by any of them is served by the gateway.

## npm scripts

| Script | Does |
|---|---|
| `npm test` | Runs the test suite with the built-in `node --test` runner. |
| `npm run test:e2e` | Runs the oracle against the real contract on its own Hardhat node (see [Tests](#tests)). Needs the root project installed and compiled. |
| `npm run service` | Starts the upload + gateway service. |
| `npm run ipfs -- <command> ...` | Runs any storage CLI command (see [Command-line tool](#command-line-tool)). |
| `npm run ipfs:add -- <file>` | Stores a file (`--encrypt` to encrypt it first). |
| `npm run ipfs:get -- <cid>` | Fetches a file (`--decrypt` to decrypt it). |
| `npm run ipfs:verify -- <cid> <contentHash>` | Checks content against an on-chain reference. |
| `npm run ipfs:hash -- <file>` | Prints the CID and content hash of a file without storing it. |
| `npm run doc:validate -- <file>` | Validates a JSON document against its schema. |
| `npm run config` | Prints the effective configuration with secrets hidden. |
| `npm run simulate -- [options]` | Prints simulated readings for a scenario and the rule's verdict. Touches neither chain nor IPFS. |
| `npm run oracle -- [options]` | Runs the oracle in monitor mode until Ctrl+C. |
| `npm run oracle:once -- --lot <id> [options]` | Anchors one sensor log for one lot, with a chosen scenario. |
| `npm run oracle:check` | Runs the oracle's pre-flight checks and exits. |

Every command prints its options with `--help`, for example `npm run oracle -- --help`.

File arguments are resolved against the directory you ran `npm` from, so `npm --prefix oracle run ipfs:add -- docs/x.json` works from the repository root.

## Configuration

Everything is configured with environment variables, read and validated in one module ([`src/config.js`](src/config.js)). **All of them are optional**; the defaults are the local demo. Invalid values are reported together, with the variable name and what a valid value looks like.

There is no `.env.example` in this folder; this table is the reference. If you want a file, create `oracle/.env` yourself with `NAME=value` lines: the command-line tools load it when it exists (variables already set in your shell win), and the root `.gitignore` keeps it out of git.

| Variable | Default | Secret? | Meaning |
|---|---|---|---|
| `NETWORK` | `localhost` | no | `localhost` (chain id 31337) or `amoy` (80002). Selects `../deployments/<NETWORK>.json`. |
| `RPC_URL` | `http://127.0.0.1:8545` for `localhost`, `https://polygon-amoy-bor-rpc.publicnode.com` for `amoy` | **yes, if it contains an API key** | JSON-RPC endpoint. Only its host is ever printed. |
| `REGISTRY_ADDRESS` | from the deployment record | no | Overrides the registry address. With it, the deployment record is optional. |
| `ORACLE_PRIVATE_KEY` | not set | **yes** | Key of the wallet that holds `ORACLE_ROLE` (64 hex digits). Use a dedicated testnet wallet that holds nothing else. Not needed on the local node, which signs with its unlocked account #4. |
| `IPFS_BACKEND` | `local` | no | `local`, `kubo` or `pinata` (see [Storage backends](#storage-backends)). |
| `IPFS_LOCAL_DIR` | `oracle/.ipfs-store` | no | Directory of the local store / cache. A relative path is resolved against `oracle/`. |
| `KUBO_API_URL` | `http://127.0.0.1:5001` | no | Kubo RPC API, used when `IPFS_BACKEND=kubo`. |
| `PINATA_JWT` | not set | **yes** | Pinata JWT with the `org:files:write` scope; required when `IPFS_BACKEND=pinata`. Sent only to Pinata's upload endpoint. |
| `IPFS_GATEWAY_URL` | none for `local`; `http://127.0.0.1:8080/ipfs/` for `kubo`; `https://ipfs.io/ipfs/` for `pinata` | no | Read-only gateway tried after the local directory. A bare host gets `/ipfs/` appended. |
| `IPFS_SERVICE_HOST` | `127.0.0.1` | no | Address the service binds to. |
| `IPFS_SERVICE_PORT` | `8787` | no | Port of the service. |
| `IPFS_SERVICE_CORS_ORIGINS` | `http://localhost:5173, http://127.0.0.1:5173, http://localhost:4173, http://127.0.0.1:4173` | no | Comma-separated browser origins allowed to `POST /upload`. Wildcards are rejected. |
| `UPLOAD_MAX_BYTES` | `1048576` | no | Largest upload the service accepts. At most 1 MiB with the `local` backend, 32 MiB otherwise. |
| `UPLOAD_TOKEN` | not set | **yes** | When set (16 or more characters), `POST /upload` requires `Authorization: Bearer <token>`. |
| `SIM_SEED` | `540` | no | Seed of the simulator's random generator (0 to 4294967295). The same seed gives the same readings. |
| `SIM_SAMPLE_SECONDS` | `60` | no | Seconds between two simulated readings. For a live demo, `5` gives a log per minute. |
| `SIM_LOG_SIZE` | `12` | no | Readings per sensor log (1 to 2000). |
| `EXCURSION_RUN_LENGTH` | `3` | no | K: consecutive out-of-range readings that trigger an excursion report. It may be larger than `SIM_LOG_SIZE`, because a run is counted across consecutive logs. |

The Amoy default, `https://polygon-amoy-bor-rpc.publicnode.com`, is the keyless endpoint that the root README gives for `AMOY_RPC_URL` and that the web app uses. Polygon's own `rpc-amoy.polygon.technology` has been shut down (on 2026-11-25 its host name did not resolve). `https://polygon-amoy.drpc.org` also answers, but in tests on 2026-11-25 its free plan failed some requests and refused every event query over 100 blocks. To use another endpoint, set `RPC_URL`.

Secrets are wrapped in a `Secret` object as soon as they are read. `console.log(config)`, `JSON.stringify(config)`, `util.inspect` and string interpolation print `[hidden]`; the value is only available through an explicit `.reveal()` at the place it is used. Error messages for a malformed secret state its length, never its value. `npm run config` shows what is in effect:

```json
{
  "network": "localhost",
  "rpcUrl": "http://127.0.0.1:8545",
  "oraclePrivateKey": "not set",
  "ipfs": { "backend": "local", "pinataJwt": "not set", "gatewayUrl": "none (local store only)" },
  "service": { "host": "127.0.0.1", "port": 8787, "maxUploadBytes": 1048576, "uploadToken": "not set" }
}
```

(abridged)

## Storage backends

One interface, three implementations ([`src/ipfs/`](src/ipfs/)):

```js
add(bytes, { name })  ->  { cid, contentHash, size }
get(cid)              ->  Uint8Array
has(cid)              ->  boolean
```

| `IPFS_BACKEND` | Stores files in | Needs |
|---|---|---|
| `local` (default) | the local directory only | nothing |
| `kubo` | a Kubo node (IPFS Desktop or `ipfs daemon`), via `POST /api/v0/add?cid-version=1&raw-leaves=true&pin=true` | a running node |
| `pinata` | the Pinata pinning service, via `POST https://uploads.pinata.cloud/v3/files` (`network=public`, `cid_version=v1`) | `PINATA_JWT` |

**Write-through cache.** With `kubo` or `pinata`, every upload is also written to the local directory. Reads try the local directory first and then `IPFS_GATEWAY_URL`. If the pinning service or the network goes down during a demo, everything uploaded from this machine is still served. New uploads then fail with a message that says how to switch to `IPFS_BACKEND=local`; they are not silently kept local, because a file that was never pinned must not look pinned.

**Integrity.** For a `bafkrei...` CID the SHA-256 of the file is inside the CID, so the library re-hashes on every read: a file edited in the store directory, or a gateway returning other bytes, is rejected instead of returned. A remote backend that answers with a CID that does not match the uploaded bytes is rejected too.

### CIDs on real IPFS

The local backend stores each file as one raw block: CIDv1, codec `raw`, multihash `sha2-256`, base32 (`bafkrei...`). That is what `ipfs add --cid-version=1` produces for any file that fits in one chunk (256 KiB by default), so small files have the same CID locally and on public IPFS, and can be pinned later without their on-chain reference changing. The local backend refuses files above 1 MiB (the largest block IPFS nodes exchange).

This was checked against a real node (Kubo 0.43.2, offline daemon, isolated repository), uploading through this package's `kubo` backend and with the `ipfs add --cid-version=1` command:

| File | Size (bytes) | Local backend | Kubo | Same CID? |
|---|---|---|---|---|
| `"hello world\n"` | 12 | `bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4` | `bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4` | yes |
| `docs/schemas/examples/sensor-log.example.json` | 1020 | `bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi` | `bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi` | yes |
| pseudo-random file, exactly 256 KiB | 262144 | `bafkrei...` (raw) | identical | yes |
| pseudo-random file, 256 KiB + 1 byte | 262145 | `bafkrei...` (raw) | `bafybei...` (dag-pb) | **no** |
| pseudo-random file, 300 KiB | 307200 | `bafkrei...` (raw) | `bafybei...` (dag-pb) | **no** |
| pseudo-random file, 1 MiB | 1048576 | `bafkrei...` (raw) | `bafybei...` (dag-pb) | **no** |

So the CIDs agree up to and including 262144 bytes and diverge from 262145 bytes on, where Kubo splits the file into chunks and the CID names a DAG node instead of the file. `contentHash` was identical in every case, and it is the value the verify page checks. Every document this project produces is far below the limit: a sensor log with the maximum of 2000 readings is under 256 KiB (a test enforces it).

The Pinata backend follows the request format in Pinata's API reference as read on 2026-11-24. It is tested against a local mock that asserts the request; it has **not** been run against the live service, since that needs an account.

## Upload + gateway service

`npm run service` starts it. Built on `node:http`, no web framework ([`src/service/server.js`](src/service/server.js)).

| Request | Answer |
|---|---|
| `GET /health` | `200 { "ok": true, "backend": "local", "maxUploadBytes": 1048576 }` |
| `POST /upload` | Body: the raw file bytes (any `Content-Type`). Optional `?name=<filename>`. `201 { "cid", "contentHash", "size" }` |
| `GET /ipfs/<cid>` | `200` with the bytes. `Content-Type` is `application/json` when the bytes parse as JSON, otherwise `application/octet-stream`. |
| `HEAD /ipfs/<cid>` | The headers of `GET`, no body. |
| `OPTIONS` on any of them | CORS preflight. |

Errors are always JSON `{ "error": "<message>" }`:

| Status | When |
|---|---|
| `400` | Malformed CID in the path; empty upload body. |
| `401` | `UPLOAD_TOKEN` is set and the request has no valid `Authorization: Bearer` header. |
| `403` | `POST /upload` from a browser origin that is not in `IPFS_SERVICE_CORS_ORIGINS`. |
| `404` | Well-formed CID that is not stored; unknown path. |
| `405` | Wrong method; the `Allow` header lists the right ones. |
| `413` | Body larger than `UPLOAD_MAX_BYTES`. Enforced while the body is streaming in, not after buffering it. |
| `500` | A stored file failed its integrity check (it is not served); unexpected failure. |
| `502` | The `kubo` or `pinata` backend is unreachable. |

Response headers of `GET /ipfs/<cid>`: `Cache-Control: public, max-age=31536000, immutable` (a CID never changes meaning), `ETag: "<cid>"` (conditional requests get `304`), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Access-Control-Allow-Origin: *`.

**CORS.** `/health` and `/ipfs/*` answer any origin: the content is public. `POST /upload` is accepted from the origins in `IPFS_SERVICE_CORS_ORIGINS` (echoed in `Access-Control-Allow-Origin`, with `Vary: Origin`) and from clients that send no `Origin` header (curl, Node.js, the oracle). Any other origin gets `403` from the server itself, and its preflight is refused.

**Using it from the dApp.** With the service on its default address, the frontend settings are `VITE_UPLOAD_SERVICE_URL=http://127.0.0.1:8787` and `VITE_IPFS_GATEWAY_URL=http://127.0.0.1:8787/ipfs/`.

```js
const response = await fetch(`${uploadServiceUrl}/upload?name=lot-metadata.json`, { method: "POST", body: bytes });
if (!response.ok) throw new Error((await response.json()).error);
const { cid, contentHash } = await response.json();     // pass both to registerBatch as the DocumentRef
```

`bytes` must be the output of a builder (see [Documents](#documents)), sent unchanged. Check `file.size` against `maxUploadBytes` from `/health` before uploading a user's file.

**From Node.js.** [`src/service/client.js`](src/service/client.js) exports `UploadServiceClient` with `health()`, `add()`, `get()`, `has()` and `urlFor()`. It has the same `add/get/has` methods as a storage backend, and it re-checks every answer (hash and size after an upload, CID digest after a download).

**Shutdown.** On `SIGINT` or `SIGTERM` the service stops accepting connections, lets requests in progress finish, and exits with status 0.

## Command-line tool

`npm run ipfs -- <command>`, or `node src/cli/main.js <command>`. Every command accepts `--json`. Exit status: 0 success, 1 the check failed or the operation could not be completed, 2 wrong usage. (The simulator and the oracle have their own commands, described in their sections below.)

| Command | Does |
|---|---|
| `serve` | Starts the service (`npm run service`). |
| `add <file> [--name <label>] [--service <url>]` | Stores a file and prints `cid`, `contentHash`, `size`. `--service` uploads through a running service instead of writing the store directly. |
| `add <file> --encrypt [--key <k> \| --key-file <path>]` | Encrypts first. Without a key option a new key is generated and printed once. |
| `get <cid> [--out <path>] [--gateway <url>]` | Fetches a file to stdout or to a file. |
| `get <cid> --decrypt (--key <k> \| --key-file <path>)` | Fetches and decrypts. |
| `verify <cid> <contentHash> [--file <path>] [--gateway <url>]` | Verifies content against an on-chain reference and reports each check. |
| `hash <file>` | Prints the CID and content hash a file would get. |
| `validate <file> [--type <type>]` | Validates a document against its schema and the cross-field rules; lists every problem. |
| `config` | Prints the effective configuration with secrets hidden. |

A generated key is shown once and stored nowhere. Save it outside the repository, or in a file ending in `.key` (ignored by the root `.gitignore`). Prefer `--key-file` to `--key`, which leaves the key in the shell history.

## Documents

Three JSON documents are stored on IPFS. Their schemas, field tables, examples and the procedure to verify one by hand are in **[`../docs/schemas/README.md`](../docs/schemas/README.md)**.

| Document | Builder | Uploaded before |
|---|---|---|
| lot metadata v1 | `buildLotMetadata(fields)` | `registerBatch` |
| regulator certificate v1 | `buildRegulatorCertificate(fields)` | `issueCertificate` |
| sensor log v1 | `buildSensorLog(fields)` | `anchorSensorLog` / `reportExcursion` |

A builder validates its input against the schema file and returns `{ document, bytes, contentHash }`. `bytes` is the single serialization of the document, `JSON.stringify(document, null, 2) + "\n"` in UTF-8; upload exactly those bytes and never re-serialize them.

```js
import { createDocuments } from "./src/documents/index.js";
import { createStorage } from "./src/ipfs/index.js";
import { loadConfig } from "./src/config.js";

const config = loadConfig();
const documents = createDocuments();
const storage = createStorage(config);

const { bytes, contentHash } = documents.buildSensorLog({
  chainId: 31337,
  registry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  lotId: 1,
  sensorId: "sim-lot-1",
  scenario: "normal",
  range: { minTenthsC: 20, maxTenthsC: 80 },
  readings: [{ t: 1794301200, tenthsC: 51 }, { t: 1794301260, tenthsC: 53 }],
});
const { cid } = await storage.add(bytes, { name: "sensor-log.json" });
// registry.anchorSensorLog(1, { cid, contentHash })
```

The oracle does exactly this for every sensor log it anchors.

## Encryption of confidential documents

[`src/crypto/envelope.js`](src/crypto/envelope.js) implements envelope version 1 with the WebCrypto API. The file has no imports, so the same source runs in Node.js and in the browser.

| Bytes | Content |
|---|---|
| 0 | `0x01`, the envelope version |
| 1 to 12 | IV: 96 random bits, new for every encryption |
| 13 to end | AES-256-GCM ciphertext followed by the 16-byte authentication tag |

* Key: 32 random bytes, exchanged as 43 characters of unpadded base64url, out of band. Keys are never uploaded and never put on-chain.
* The file is encrypted **before** upload. `cid`, `contentHash` and `size` describe the encrypted bytes, so anyone can verify integrity and only key holders can read the content.
* Decryption fails if the key is wrong or any byte was changed.
* The attachment entry in the lot metadata records `"encryption": { "scheme": "AES-256-GCM", "envelope": 1 }`.

```js
import { encrypt, decrypt, generateKey, encodeKey } from "./src/crypto/envelope.js";

const key = generateKey();
const envelope = await encrypt(pdfBytes, key);          // upload `envelope`
console.log("hand this to the recipient:", encodeKey(key));
const original = await decrypt(envelope, key);
```

## Sensor simulator

The proposal leaves real sensors out of scope, so [`src/simulator/`](src/simulator/) plays the data logger that travels with a lot. It produces readings in the contract's units: `{ t, tenthsC }`, a Unix time in seconds and a temperature in tenths of a degree Celsius.

**Deterministic.** A reading is a pure function of four numbers:

```
reading = scenario( seed of the lot's sensor, the lot's range, reading index, onset )
```

There is no `Math.random` and no clock in that function. The random numbers come from the package's own small generator ([`src/simulator/prng.js`](src/simulator/prng.js)): each value is a hash of (seed, stream, index), so reading number 500 can be computed without the 499 before it, and nothing has to be stored for a series to continue after a restart. Every lot derives its own seed from `SIM_SEED` and its lot id, so two lots show different curves, and the same `SIM_SEED` always reproduces the same demo.

**Scenarios** ([`src/simulator/scenarios.js`](src/simulator/scenarios.js)):

| Scenario | What the sensor sees | What the rule does (K = 3) |
|---|---|---|
| `normal` | Stays inside the lot's range: a setpoint near the middle, a slow drift (two sine waves with periods of 90 and 23 readings) and a little noise. | Nothing to report; the log is anchored. |
| `excursion` | A refrigeration failure. Two more normal readings, then the temperature climbs towards a level above the maximum and stays there. From the 7th reading on, every reading is out of range. | Triggers no later than the 9th reading. |
| `freeze` | The mirror image: the temperature falls below the minimum and stays there. | Triggers no later than the 9th reading. |
| `spike` | Normal, except one isolated out-of-range reading every 10 readings (the 7th, 17th, ...), as when a door is opened briefly. The next reading is normal again. | Never triggers; the log is anchored with the spike in it. |

The shapes scale with the lot's range, so a frozen product (-25 °C to -15 °C) gets as plausible a curve as a refrigerated one (2 °C to 8 °C). Every reading is an integer that fits the contract's `int16`. A scenario that would have to leave the range where `int16` has no room left (an `excursion` for a lot whose maximum is 3276.7 °C) is refused with an explanation.

**Two clock modes** ([`src/simulator/source.js`](src/simulator/source.js)). Time is always handed in by the caller, so tests control every timestamp.

| Mode | Call | Timestamps | Used by |
|---|---|---|---|
| live | `source.take()` | the injected clock at the moment the reading is taken | `npm run oracle` (monitor): one reading every `SIM_SAMPLE_SECONDS` |
| backfill | `source.backfill(count, now)` | `count` readings `SIM_SAMPLE_SECONDS` apart, the last one at `now - 1` | `npm run oracle:once`, tests, `npm run simulate` |

### `npm run simulate`

Prints the readings of a scenario and what the excursion rule decides. It touches neither the chain nor IPFS, so it works on a fresh clone.

```bash
npm run simulate -- --scenario excursion
```

```
scenario excursion   lot 1   range 2.0 C to 8.0 C   seed 540   12 readings, 60 s apart
    #  time (UTC)            temp
    0  2026-11-25T07:43:59Z      3.9 C
    1  2026-11-25T07:44:59Z      4.0 C
    2  2026-11-25T07:45:59Z      5.7 C
    3  2026-11-25T07:46:59Z      7.0 C
    4  2026-11-25T07:47:59Z      7.8 C
    5  2026-11-25T07:48:59Z      8.4 C  OUT OF RANGE (run 1)
    6  2026-11-25T07:49:59Z      8.6 C  OUT OF RANGE (run 2)
    7  2026-11-25T07:50:59Z      9.1 C  OUT OF RANGE (run 3)  <- rule triggers: 3 consecutive readings outside 2.0 C to 8.0 C
    8  2026-11-25T07:51:59Z      9.4 C  OUT OF RANGE (run 4)
    9  2026-11-25T07:52:59Z      9.5 C  OUT OF RANGE (run 5)
   10  2026-11-25T07:53:59Z      9.6 C  OUT OF RANGE (run 6)
   11  2026-11-25T07:54:59Z      9.8 C  OUT OF RANGE (run 7)
min 3.9 C   max 9.8 C   out of range 7 of 12
EXCURSION: the oracle would call reportExcursion with 9.1 C observed at 2026-11-25T07:50:59Z
```

The temperatures are the same on every machine (seed 540, lot 1); only the times follow the clock.

| Option | Default | Meaning |
|---|---|---|
| `--scenario <name>` | `normal` | `normal`, `excursion`, `freeze` or `spike` |
| `--min <tenths>`, `--max <tenths>` | `20`, `80` | the lot's range in tenths of a degree; a frozen product is `--min -250 --max -150` |
| `--count <n>` | `SIM_LOG_SIZE` | number of readings |
| `--lot <id>` | `1` | lot id; every lot has its own random stream |
| `--index <n>` | `0` | index of the first reading in the lot's series |
| `--end <unix time>` | now | the readings end just before this time |
| `--json` | | one JSON object with the readings and the rule's evaluation |

`SIM_SEED`, `SIM_SAMPLE_SECONDS`, `SIM_LOG_SIZE` and `EXCURSION_RUN_LENGTH` apply, for example `SIM_SEED=7 EXCURSION_RUN_LENGTH=5 npm run simulate -- --scenario spike`.

## Oracle runner

The oracle is the only off-chain program that writes to the registry. It holds `ORACLE_ROLE` and does one thing per lot, over and over:

```
take readings -> apply the excursion rule -> build the sensor-log document -> upload it to IPFS
              -> anchorSensorLog(lotId, { cid, contentHash })                       rule not triggered
              -> reportExcursion(lotId, reading, observedAt, { cid, contentHash })  rule triggered: the lot becomes Compromised
```

Only the CID and the hash of a log go on-chain; the readings stay on IPFS. That is the proposal's "keep sensor logs off-chain with on-chain hashes to limit gas": one transaction per log, whatever the number of readings.

| Module | Role |
|---|---|
| [`src/oracle/rule.js`](src/oracle/rule.js) | The excursion rule, a pure function. |
| [`src/oracle/registryClient.js`](src/oracle/registryClient.js) | The only module that talks to the chain: deployment record and ABI ([`deployment.js`](src/oracle/deployment.js)), signer, pre-flight checks, reads, the two transactions, decoding of custom errors ([`revert.js`](src/oracle/revert.js)), and telling a transient RPC failure from a permanent one ([`rpcErrors.js`](src/oracle/rpcErrors.js)). |
| [`src/oracle/runner.js`](src/oracle/runner.js) | The two modes, built on a registry client, a storage backend and the document builder that are handed in. |
| [`src/oracle/retry.js`](src/oracle/retry.js) | Bounded retry with backoff for transient failures. |
| [`src/oracle/cli.js`](src/oracle/cli.js), [`format.js`](src/oracle/format.js), [`main.js`](src/oracle/main.js) | Command line, console lines, executable. |

### Starting it

On the local Hardhat node (the proposal's contingency demo; no key, no account):

```bash
# repository root, terminal 1
npm run node
# repository root, terminal 2
npm run deploy:local        # writes deployments/localhost.json
npm run roles:local         # grants ORACLE_ROLE to the node's account #4

# oracle/, terminal 3
npm run oracle:check
```

```
2026-11-25T07:54:11Z oracle  READY     network=localhost chainId=31337 registry=0x5FbD…0aa3 signer=0x15d3…6A65 via="local account #4" lots=4 storage=local
```

(In the examples of this section, addresses, CIDs and transaction hashes are shortened with `…`; the tool prints them in full. Your values will differ.)

Before anything else, every command runs these **pre-flight checks** and stops with an instruction if one fails:

1. the deployment record and the ABI can be loaded (`../deployments/<NETWORK>.json`, `../deployments/abi/ProvenanceRegistry.json`);
2. the RPC endpoint answers;
3. it is on the chain id that `NETWORK` names;
4. the registry address holds contract code;
5. a signer is available: `ORACLE_PRIVATE_KEY`, or, on chain id 31337 only, the node's unlocked account #4;
6. that signer holds `ORACLE_ROLE`.

On Polygon Amoy, set `NETWORK=amoy` and `ORACLE_PRIVATE_KEY` (and `RPC_URL` if you use your own endpoint), in your shell or in `oracle/.env`. The key is read into a `Secret`, handed to the signer, and never printed.

### `npm run oracle:once`: one log now

```bash
npm run oracle:once -- --lot 1
```

```
2026-11-25T07:54:11Z oracle  READY     network=localhost chainId=31337 registry=0x5FbD…0aa3 signer=0x15d3…6A65 via="local account #4" lots=4 storage=local
2026-11-25T07:54:11Z lot 1   ANCHOR    log=1 readings=12 min=3.9C max=5.2C cid=bafkreidttt…e5iq tx=0xb10e…0cf6 block=12
```

It reads the lot, produces `SIM_LOG_SIZE` readings at once (backfill: `SIM_SAMPLE_SECONDS` apart, ending just before the chain's latest block time), uploads the log and anchors it. With a failure scenario it reports the excursion instead:

```bash
npm run oracle:once -- --lot 2 --scenario excursion
```

```
2026-11-25T07:54:11Z lot 2   EXCURSION log=1 readings=12 min=3.8C max=9.6C reading=9.2C observedAt=2026-11-25T07:50:12Z rule="3 consecutive readings outside 2.0 C to 8.0 C" cid=bafkreieioz…5efq tx=0xc257…f85b block=14 status=Compromised
```

A spike is recorded but not reported, and the line says why:

```
2026-11-25T07:54:11Z lot 1   ANCHOR    log=2 readings=12 min=4.6C max=9.5C outOfRange=1 longestRun=1/3 cid=bafkreif6zn…yjtu tx=0x4057…5ace block=13
```

A lot that is not active is left alone, because the contract accepts sensor data only for active lots:

```
2026-11-25T07:54:11Z lot 2   SKIP      status=Compromised reason="the lot is Compromised, and the contract accepts sensor data only for active lots (Created, InTransit, Stored)"
```

| Option | Meaning |
|---|---|
| `--lot <id>` | the lot to log (required) |
| `--scenario <name>` | `normal` (default), `excursion`, `freeze` or `spike` |
| `--json` | print the result as one JSON object on stdout (`outcome`, `cid`, `contentHash`, `txHash`, `logIndex`, `excursion`, ...); progress lines go to stderr. For seed scripts. |

Repeated runs for one lot continue its series (the first reading's index is the number of logs already anchored times `SIM_LOG_SIZE`), so seeded history does not show the same curve twice. The scenario's event always starts with the new log. Every run dates its readings backwards from the chain's time at that moment, so two runs for the same lot less than `SIM_LOG_SIZE` × `SIM_SAMPLE_SECONDS` seconds apart (12 minutes by default) produce logs whose time windows overlap; that is fine for a demo.

### `npm run oracle`: monitor

```bash
SIM_SAMPLE_SECONDS=1 SIM_LOG_SIZE=6 npm run oracle
```

```
2026-11-25T07:54:24Z oracle  READY     network=localhost chainId=31337 registry=0x5FbD…0aa3 signer=0x15d3…6A65 via="local account #4" lots=4 storage=local
2026-11-25T07:54:24Z oracle  MONITOR   lots=all-active scenario=normal sampleSeconds=1 logSize=6 runLength=3
2026-11-25T07:54:24Z lot 1   WATCH     status=Stored range=2.0..8.0C scenario=normal logs=2
2026-11-25T07:54:24Z lot 2   SKIP      status=Compromised reason="the lot is Compromised"
2026-11-25T07:54:24Z lot 3   SKIP      status=Compromised reason="the lot is Compromised"
2026-11-25T07:54:24Z lot 4   SKIP      status=Delivered reason="the lot is Delivered"
2026-11-25T07:54:29Z lot 1   ANCHOR    log=3 readings=6 min=4.6C max=5.0C cid=bafkreifldq…cqbm tx=0x036b…3db0 block=17
2026-11-25T07:54:35Z lot 1   ANCHOR    log=4 readings=6 min=4.7C max=5.1C cid=bafkreihu6x…ey7e tx=0xf652…0d3f block=19
^C
2026-11-25T07:54:37Z oracle  STOPPED   reason=signal ticks=14 anchored=2 excursions=0 failures=0 discardedReadings=2
```

How it works:

* **Which lots.** By default every active lot (Created, InTransit, Stored). The lot count is polled each round (`totalBatches()`), so a lot registered while the monitor runs is picked up in the next round. `--lots 1,3` watches exactly those lots instead.
* **Sampling.** Every `SIM_SAMPLE_SECONDS` it takes one reading per watched lot (live mode: stamped when taken).
* **Closing a log.** When a lot has `SIM_LOG_SIZE` readings, they become one log: uploaded, then `anchorSensorLog`. If the excursion rule triggers earlier, the log is closed **at once** and sent with `reportExcursion`, so an excursion is reported K readings after it begins, not at the end of the period.
* **Dropping a lot.** Before every transaction the lot is read again. If it is no longer active (delivered, recalled, or Compromised by this oracle's own report), it is removed from the watch list and no transaction is sent. A lot never becomes active again.
* **Stopping.** On Ctrl+C (`SIGINT`) or `SIGTERM` the step in progress finishes, nothing new is started, a summary line is printed and the exit status is 0. Readings of a log that was not yet full are discarded; the count is in the summary. A second Ctrl+C ends the process immediately. (Under `npm run`, one Ctrl+C reaches the oracle twice within milliseconds, from the terminal and forwarded by npm; a repeat within half a second counts as the same Ctrl+C.)

| Option | Meaning |
|---|---|
| `--lots <ids>` | watch exactly these lots, e.g. `--lots 1,3` (default: all active lots, with discovery) |
| `--scenario <name>` | scenario of every watched lot (default `normal`) |
| `--scenario <lot>=<name>` | scenario of one lot; repeatable, e.g. `--scenario 2=excursion` |
| `--cycles <n>` | stop after n log periods (n × `SIM_LOG_SIZE` rounds); default: run until stopped |
| `--json` | one JSON object per line instead of text |

With the defaults (`SIM_SAMPLE_SECONDS=60`, `SIM_LOG_SIZE=12`) a log is anchored every 12 minutes. For a demo use `SIM_SAMPLE_SECONDS=5`: a log per minute, and a failing lot is reported after about 40 seconds.

### Console output

One line per action: `<time> <subject> <ACTION> key=value ...`. Values that contain spaces are quoted. With `--json` each line is the same event as a JSON object.

| Action | Printed when | Stream |
|---|---|---|
| `READY`, `WARNING` | the pre-flight checks passed; a non-fatal finding, such as an oracle account without funds | stdout |
| `MONITOR`, `STOPPED` | the monitor starts and ends (with totals) | stdout |
| `WATCH`, `SKIP`, `UNWATCH` | a lot is added to the watch list, ignored because it is not active, or dropped | stdout |
| `ANCHOR` | a log was anchored: log number, number of readings, minimum and maximum temperature, CID, transaction hash, block | stdout |
| `EXCURSION` | an excursion was reported: the same, plus the reported reading, its time and the rule | stdout |
| `RETRY` | a transient failure is being retried | stderr |
| `WAIT` | a log is held back because the chain's latest block is older than its newest reading | stderr |
| `FAILED` | a step failed for good; `readingsKept` says whether the readings will be tried again | stderr |

Exit status: `0` done; `1` configuration or pre-flight error; `2` wrong command line. The monitor does not exit because of a failing lot. `oracle:once` additionally exits with `1` when its one log was not anchored (inactive or unknown lot, failed upload or transaction), so a seed script can tell.

### The excursion rule

> A lot has an excursion when **K consecutive readings** are outside its registered range. K is `EXCURSION_RUN_LENGTH`, 3 by default.

* A reading equal to the minimum or the maximum is in range, exactly as in the contract (`ReadingWithinRange` reverts for `min <= reading <= max`).
* The oracle reports the reading that **completes** the run (the K-th), with that reading's timestamp as `observedAt`. It is out of range by definition, so the contract accepts it.
* The log records it in its `excursion` field together with the rule in words, for example `"3 consecutive readings outside 2.0 C to 8.0 C"`, and the event `ExcursionReported` carries the same reading, time, CID and hash. Anyone can download the log and count the run.
* **Runs cross file boundaries.** The stream of readings is cut into logs, so a run can begin at the end of one log and complete in the next. The run length is carried from each log of a lot to the next; the log then says `(the run began in the previous log)`. This is also why K may exceed `SIM_LOG_SIZE`.
* An isolated out-of-range reading (the `spike` scenario) is recorded in the log and never reported. With K = 1 every out-of-range reading is an excursion, including a spike.

**Why the rule is off-chain and the range check is on-chain** (design decision C7):

| | On-chain: `reportExcursion` | Off-chain: this rule |
|---|---|---|
| Question answered | Is the reported reading outside the range that was registered for this lot? | Is a report justified yet? |
| Why it belongs there | One comparison against stored values: cheap, objective, and it cannot be bypassed. Even the oracle cannot flag a lot with a reading that is in range, or with a time in the future. | It needs the history of readings. On-chain that would mean storing or processing every reading (gas per reading), which is what anchoring logs by hash avoids. K is also a policy that should be tunable without redeploying the contract. |
| What it protects against | A wrong or malicious report that contradicts the lot's own registered range. | A good lot being destroyed by one odd sample: Compromised cannot be undone. |
| Evidence left behind | `ExcursionReported(batchId, logIndex, reading, observedAt, logCid, logContentHash)` | The sensor log on IPFS, tamper-evident through its on-chain hash. |

### The chain's clock

`reportExcursion` reverts with `InvalidTimestamp` when `observedAt` is later than `block.timestamp`. Block timestamps never decrease, so the oracle uses a simple sufficient condition: **no reading it submits is later than the chain's latest block time.**

* `oracle:once` asks for the latest block time first and ends the log one second before it.
* The monitor stamps readings with this machine's clock and, before closing a log, asks for the latest block time. Only the readings the chain's clock has reached go into the log; newer ones stay buffered for the lot's next log. A log is closed once enough such readings exist (a full log, or a completed run); until then the round prints `WAIT`. A clock that runs ahead of the chain's therefore delays a log by the difference, and never blocks it or loses a reading.
* A public chain produces a block every few seconds, so the chain's clock is at most a few seconds behind; the registry client waits up to 6 seconds for the next block before it answers. A local Hardhat node mines only when it receives a transaction, so its latest block can be minutes old. On chain id 31337, and only there, the registry client then asks the node to mine one empty block (`evm_mine`), after which the latest block carries the current time or later. If the node does not offer that method, the logs stay in `WAIT` until some transaction produces a block.
* On a Hardhat node the chain's clock usually runs *ahead* of this machine's. The node stamps every block at least one second after the previous one and keeps the lead this creates. Idle time does not use the lead up, so during one session of the node it only grows; restarting the node resets it. Every transaction mined in the same second as the one before adds a second (deploying, granting roles, seeding lots, a monitor anchoring several lots per round), so the lead can exceed a minute: on a fresh node, 90 transactions sent back to back left the chain about 85 seconds ahead, and 20 idle seconds did not reduce that (measured on 2026-11-25). The monitor is never held up by that, but `oracle:once` ends its log at the chain's time, so its readings, and the `observedAt` of an excursion, can be dated up to that lead after the wall-clock time at which the command ran.

### Failures, retries, and never anchoring twice

* **One lot never stops the others.** Each lot is handled inside its own error boundary and the lots are processed one after the other. A failure is printed (`FAILED`) and the next lot is served.
* **Transient failures are retried, briefly.** An unreachable RPC endpoint or storage service, a timeout or an overload answer is tried up to 4 times in all (3 retries, after waits of 0.5 s, 1 s and 2 s), then reported. A rejection by the contract is not retried: it would fail the same way.
* **The contract is not sent what it would reject.** The lot is read first and must be active; the transaction is simulated (`eth_estimateGas`) before it is broadcast. If the contract rejects a call anyway, because the lot changed in between, the custom error is decoded and printed by name, for example `InvalidStatus(batchId=2, current=Recalled)`.
* **A log is never anchored twice.** The risk is a transaction that is mined while its confirmation is lost, followed by a blind retry. Two safeguards prevent that:
  1. *One document, one nonce.* The account nonce is reserved once per log, and every attempt for that log uses it. A chain mines at most one transaction per account and nonce, so at most one attempt can take effect. A second nonce is never used for the same log.
  2. *Look before sending again.* Before any attempt after the first, the lot is read back; if its latest sensor log already is this document (same CID and hash), the cycle is complete and nothing is sent. The line then shows `tx=confirmed-by-reading-the-lot` when the hash is unknown.
* **What happens to the readings of a failed log.** If nothing was sent (the upload failed), the readings stay buffered and are tried again in the next round (`readingsKept=true`). If a transaction may have been broadcast, they are dropped (`readingsKept=false`) rather than merged into the next log, because the earlier transaction could still be mined and the same readings would then sit in two logs. The run length of the excursion rule continues either way, so a report that could not be delivered is attempted again with the next out-of-range reading.

### Trust assumption: the ORACLE key speaks for the sensors

The contract can check that a reported reading is outside the range. It cannot check that the reading was ever measured. **Whoever holds the ORACLE key is trusted for sensor truth.**

* A stolen or faulty key can mark any active lot Compromised with an invented out-of-range reading, and Compromised cannot be reversed (the only later status is Recalled). It can also anchor invented logs that show a good cold chain.
* What limits the damage: the on-chain range check (no report with an in-range reading or a future time); every claim is published as a log whose hash is on-chain, so the oracle cannot later change what it claimed and anyone can audit it; documents name the chain, the registry and the lot they belong to; the regulator can revoke `ORACLE_ROLE` at any time.
* What would reduce the trust needed, and is out of scope here: readings signed by tamper-resistant sensor hardware, or several independent oracles that must agree.
* Operationally: use a dedicated wallet that holds only gas money, keep `ORACLE_PRIVATE_KEY` out of files that are committed, and run **one** oracle process per key. Two processes sending from one account at the same moment can collide on a nonce; the affected cycle is then reported as failed (never anchored twice), and the next one proceeds.

### Triggering an excursion during a live demo

1. Repository root: `npm run node`, then `npm run deploy:local` and `npm run roles:local`. Register at least two lots (through the dApp or a script), so that one can fail while the other stays healthy. The steps below call them lot 1 and lot 2.
2. `oracle/`, one terminal: `npm run service`, so the verify page can fetch the logs from `http://127.0.0.1:8787/ipfs/<cid>`.
3. `oracle/`, another terminal: `SIM_SAMPLE_SECONDS=5 npm run oracle`. After a minute every active lot shows an `ANCHOR` line, and the verify page shows the lot's log.
4. `oracle/`, a third terminal, at the moment you want the failure:

   ```bash
   npm run oracle:once -- --lot 2 --scenario excursion
   ```

   The `EXCURSION` line appears immediately; the lot is Compromised on-chain, and the verify page shows the status, the reported reading and the log with the warming curve.
5. The monitor notices at lot 2's next log: `UNWATCH status=Compromised`. The other lots carry on.

Alternative with one terminal: start the monitor with `--scenario 2=excursion`. Lot 2 then warms up from the first reading and is reported after 8 or 9 readings.

To demonstrate the rule itself, run `npm run oracle:once -- --lot 1 --scenario spike`: a reading above the limit is recorded (`outOfRange=1 longestRun=1/3`) and the lot stays healthy.

### Troubleshooting

| You see | Meaning | Do |
|---|---|---|
| `error: No deployment record at deployments/localhost.json` | The contract has not been deployed to this network from this checkout. | Repository root: `npm run node`, `npm run deploy:local`, `npm run roles:local`. Or set `REGISTRY_ADDRESS`. |
| `error: Cannot reach the JSON-RPC endpoint ...` | Nothing answers at `RPC_URL` (`ECONNREFUSED`), or what answers is not a JSON-RPC node (`server response 404 Not Found`, for example when `RPC_URL` points at the upload service). | Start the node (`npm run node`), or correct `RPC_URL`. |
| `error: The JSON-RPC endpoint ... is on chain id X, but NETWORK=... means chain id Y` | `NETWORK` and `RPC_URL` point at different networks. | Fix one of them. |
| `error: No contract at 0x... on chain id 31337` | The local node was restarted and is empty; the saved address is stale. With `(address from REGISTRY_ADDRESS)`: that variable names an address without a contract. | `npm run deploy:local` and `npm run roles:local` again, or correct `REGISTRY_ADDRESS`. |
| `error: ... does not hold ORACLE_ROLE` | The signer has not been granted the role on this deployment. | `npm run roles:local` (grants it to account #4), or `npm run roles:amoy` with `ORACLE_ADDRESS` set to the address in the message. |
| `FAILED step=anchor error="The contract rejected the call: AccessControlUnauthorizedAccount(account=0x..., neededRole=ORACLE_ROLE) ..."` | The role was revoked after the oracle started; the pre-flight checks it only at start-up. | Grant it again. Until then every log fails this way. |
| `lot 9 FAILED step=read-lot error="Lot 9 does not exist in the registry."` | `oracle:once --lot` names an id that was never registered. | Use an existing lot; `oracle:check` prints the number of lots (`lots=N`). |
| `error: ORACLE_PRIVATE_KEY is not set` | `NETWORK=amoy` has no unlocked account. | Set `ORACLE_PRIVATE_KEY`. |
| `WARNING ... zero balance` | The oracle account cannot pay for gas. | Fund it from an Amoy faucet. |
| `SKIP status=...` | The lot is Delivered, Compromised or Recalled; the contract takes no more sensor data for it. | Use an active lot. |
| Nothing after `WATCH` for minutes | A log needs `SIM_LOG_SIZE` × `SIM_SAMPLE_SECONDS` seconds: 12 minutes by default. | Set `SIM_SAMPLE_SECONDS=5`, or use `oracle:once`. |
| `oracle:once --scenario excursion` printed `ANCHOR`, not `EXCURSION` | The log is too short for the run to complete: the scenario is out of range from the 7th reading, so K = 3 needs `SIM_LOG_SIZE` of at least 9. | Use the default `SIM_LOG_SIZE`, or a smaller `EXCURSION_RUN_LENGTH`. |
| `WAIT ... the chain's latest block is older than the newest reading` | The chain's clock is behind this machine's, so the newest readings cannot be submitted yet. | Usually nothing: the log is closed a round or two later. If logs are always late on a public network, this machine's clock runs ahead; if nothing is ever anchored, the chain produces no blocks. |
| `FAILED step=upload ... readingsKept=true` | The storage backend (Kubo, Pinata) is unreachable, or the local store directory cannot be written (`Cannot write to the local store at ...: EACCES` or `ENOTDIR`, or `EEXIST` when `IPFS_LOCAL_DIR` names an existing file). Nothing was sent to the chain. | It is retried every round. To carry on without a remote backend: `IPFS_BACKEND=local`. For the local store: make `IPFS_LOCAL_DIR` writable, or point it at another directory. |
| `RETRY step=read-lot ... ECONNREFUSED`, then `FAILED step=read-lot ... readingsKept=true` for every lot, every round | The node stopped while the monitor was running. | A restarted local node is a new, empty chain: stop the monitor, run `npm run deploy:local` and `npm run roles:local` again, and restart it. |
| `FAILED step=anchor error="The contract rejected the call: InvalidStatus(...)"` | The lot changed between the read and the transaction. If the change landed between the simulation and the broadcast, the local node still mines the reverted transaction (it uses one nonce), so `readingsKept=false`. | Nothing; the lot is dropped at its next log. |
| `FAILED ... Account nonce N has already been used` | Another process sent from the oracle account at the same moment. | Run one oracle per key; the next cycle proceeds normally. |
| The verify page cannot load a log | The gateway is not running, or uses another store directory. | `npm run service` with the same `IPFS_LOCAL_DIR`. |

### Using the runner from a script

```js
import { loadConfig, createStorage, createDocuments, connectRegistry, createOracleRunner } from "./src/index.js";

const config = loadConfig();
const registry = await connectRegistry({ config });                 // loads the deployment, runs the pre-flight checks
const runner = createOracleRunner({
  registry,
  storage: createStorage(config),
  documents: createDocuments(),
  settings: { ...config.simulator, ...config.excursion },
  emit: (event) => console.log(event),
});
const result = await runner.runOnce({ lotId: 1, scenario: "normal" });   // { outcome: "anchored", cid, contentHash, txHash, logIndex, ... }
await registry.close();
```

`registry` can be any object with the client's methods (`chainId`, `address`, `totalLots`, `readLot`, `chainTime`, `reserveNonce`, `anchorSensorLog`, `reportExcursion`), which is how the tests run the runner without a chain.

## Library reference

Node code imports from [`src/index.js`](src/index.js), or from the modules below.

| Module | Exports |
|---|---|
| `src/config.js` | `loadConfig(env?)`, `describeConfig(config)`, `loadEnvFile(file?)`, `isLoopbackHost(host)`, `Secret`, `NETWORKS`, `IPFS_BACKENDS`, `DEFAULT_CORS_ORIGINS`, `MAX_LOG_READINGS`, `UPLOAD_HARD_MAX_BYTES` |
| `src/ipfs/index.js` | `createStorage(config, { fetch }?)`, `LocalBackend`, `KuboBackend`, `PinataBackend`, `StorageBackend`, `LocalStore`, `GatewayClient`, `sanitizeFileName`, and everything from `cid.js` |
| `src/ipfs/cid.js` (browser-safe) | `computeRawCid(bytes)`, `computeContentHash(bytes)`, `parseCid(text)`, `isCid(text)`, `cidMatchesBytes(cid, bytes)`, `verifyContent(bytes, { cid, contentHash })`, `sha256Digest(bytes)`, `toBytes(value)`, constants |
| `src/crypto/envelope.js` (browser-safe, no imports) | `encrypt`, `decrypt`, `generateKey`, `encodeKey`, `decodeKey`, `inspectEnvelope`, `EnvelopeError`, `ENCRYPTION_DESCRIPTOR`, constants |
| `src/documents/index.js` | `createDocuments({ schemasDir }?)` returning `{ types, validate, assertValid, parse, buildLotMetadata, buildRegulatorCertificate, buildSensorLog }`; `loadSchemaFiles(dir?)`, `computeProductHash(productCode, lotNumber)`, `buildAttachment(file)`, `serializeDocument`, `decodeDocument` |
| `src/documents/validator.js`, `builders.js`, `serialize.js` (browser-safe) | `createDocumentValidator(schemas)`, `createDocumentBuilders(validator)`: the dApp passes the schema files it bundles |
| `src/service/server.js` | `createUploadService({ storage, host, port, corsOrigins, maxUploadBytes, uploadToken, log })` returning `{ server, listen(), close() }` |
| `src/service/client.js` (browser-safe) | `UploadServiceClient` |
| `src/units.js` (browser-safe) | `formatTenths(tenthsC)`, `formatRange(range)`, `isoTime(unixSeconds)`, `isInt16(value)`, `INT16_MIN`, `INT16_MAX` |
| `src/simulator/prng.js` (browser-safe) | `randomUnit(seed, stream, index?)`, `randomNoise(seed, stream, index?)`, `deriveSeed(seed, ...words)`, `hashWords(...words)`, `mix32(value)` |
| `src/simulator/scenarios.js` (browser-safe) | `simulateReading(scenario, seed, range, index, onset?)`, `SCENARIOS`, `SCENARIO_NAMES`, `getScenario(name)`, `assertRange(range)`, `assertScenarioFits(scenario, range)` |
| `src/simulator/source.js` (browser-safe) | `createReadingSource({ seed, lotId, range, scenario?, sampleSeconds, clock?, startIndex?, onset? })` returning `{ scenario, sensorId, nextIndex, take(), backfill(count, now) }`; `sensorSeed(seed, lotId)` |
| `src/oracle/rule.js` (browser-safe) | `evaluateRule(readings, range, { runLength, carriedRun? })` returning `{ triggered, excursion, rule, runAtEnd, longestRun, outOfRangeCount }`; `isOutOfRange(tenthsC, range)`, `describeRule(runLength, range, { startedEarlier }?)` |
| `src/oracle/registryClient.js` | `connectRegistry({ config, deployment?, provider?, sleep?, receiptTimeoutMs? })` returning a `RegistryClient`; `loadDeployment(config)`, `createProvider(config)`, `decodeRevert(error, interface)`, `extractRevertData(error)`, `statusName(status)`, `isActiveStatus(status)`, `STATUS_NAMES`, `LOCAL_CHAIN_ID`, `LOCAL_ORACLE_ACCOUNT_INDEX`, `REQUIRED_FUNCTIONS` |
| `src/oracle/runner.js` | `createOracleRunner({ registry, storage, documents, settings, clock?, sleep?, emit?, retry? })` returning `{ runOnce({ lotId, scenario?, signal? }), monitor({ lots?, scenarios?, defaultScenario?, signal?, maxTicks? }) }`; `systemClock()` |
| `src/oracle/retry.js` | `withRetry(operation, options?)`, `isTransientError(error)`, `abortableSleep(ms, signal?)`, `DEFAULT_RETRY_POLICY` |
| `src/oracle/format.js` | `formatEvent(event)`, `formatEventJson(event)`, `isDiagnostic(event)` |
| `src/errors.js` | `OracleError` and its subclasses: `ConfigError`, `InvalidCidError`, `NotFoundError`, `IntegrityError`, `ContentTooLargeError`, `InvalidContentError`, `StorageError`, `DocumentValidationError`, `ServiceRequestError`, `UsageError`, `SimulationError`, `DeploymentError`, `PreflightError`, `ChainError`, `TransientChainError`, `ContractRevertError`, `NonceConsumedError`, `LotNotFoundError` |

`verifyContent` reports each check separately:

```js
verifyContent(bytes, { cid, contentHash })
// { ok, size,
//   contentHash: { expected, actual, valid, matches },
//   cid: { value, valid, checked, matches, codec, hash, detail },   // checked only for raw + sha2-256 CIDs
//   summary }
```

A `RegistryClient` offers `chainId`, `address`, `signerAddress`, `info`, and the methods `totalLots()`, `readLot(lotId)`, `chainTime({ atLeast }?)`, `reserveNonce()`, `anchorSensorLog(lotId, ref, { nonce })`, `reportExcursion(lotId, { tenthsC, t }, ref, { nonce })` and `close()`. Each makes one attempt and throws a typed error: `TransientChainError` (a retry may help), `ContractRevertError` (`errorName`, `args`, `detail`), `LotNotFoundError`, `NonceConsumedError` or `ChainError`.

## Security notes

* **No secret in the browser.** The pinning credential lives only in this process. The dApp talks to the upload service.
* **Secrets cannot be printed by accident** (see [Configuration](#configuration)). The service keeps only a hash of `UPLOAD_TOKEN` and compares tokens in constant time. The Pinata JWT is sent to Pinata's upload endpoint only, never to a gateway, never across a redirect, and never over plain http except to a loopback address.
* **The ORACLE key.** It is revealed in one place, to construct the signer, and never logged. Error messages of the registry client are built without the RPC URL, which may carry an API key. An unlocked node account is used only on chain id 31337. Fee data comes from the configured RPC endpoint; no third-party gas service is contacted. What the key is trusted with is described in [Trust assumption](#trust-assumption-the-oracle-key-speaks-for-the-sensors).
* **The service binds to 127.0.0.1.** If you set `IPFS_SERVICE_HOST` to another address (for example to let a phone on the same network reach the gateway), also set `UPLOAD_TOKEN`; the service prints a warning if you do not.
* **Uploads are checked on the server.** The origin allow-list is enforced by the service, not left to the browser, because a simple cross-origin `POST` is sent without a preflight.
* **Paths are never built from request text.** The `<cid>` segment is parsed as a CID first; the file name is the canonical re-encoding of the parsed CID (`[a-z2-7]` only). `../`, encoded separators, NUL bytes and non-CID names are answered with `400`.
* **Stored content is treated as untrusted.** It is served as JSON or as an opaque download with `nosniff` and a sandboxing CSP, so an uploaded HTML file is never rendered.
* **Tamper evidence at every hop.** The local store, the gateway client and the service client re-hash raw-CID content; the content hash is recomputed by whoever verifies.
* **Public IPFS is public and permanent.** Encrypt anything confidential before upload, and never upload personal data. All sample data in this repository is synthetic.
* **Root `.gitignore` reminders.** `oracle/.ipfs-store/`, `.env*`, `*.key` and `*.pem` are ignored. So are `*.log` files and folders named `logs`: keep sample data as `.json`, and do not name a folder `logs`.

## Tests

```bash
cd oracle
npm test
```

About 520 tests in 13 files, using only `node:test` and `node:assert` (no test dependencies). They need no network and no blockchain node: remote services are replaced by local mock HTTP servers on ephemeral ports, the chain by in-memory stand-ins, and every test works in its own temporary directory. Time is injected, so a monitor run of many sample intervals takes milliseconds.

| File | Covers |
|---|---|
| `test/cid.test.js` | CID computation against vectors from the independent `multiformats` implementation; CID parsing and rejection of malformed input; content-hash verification including tampered bytes; base32, base58 and varint primitives |
| `test/storage.test.js` | The local store and the three backends; exact request shape of the Kubo and Pinata uploads (mock servers); the JWT reaching only the Pinata endpoint; write-through cache; gateway fallback, verification and limits |
| `test/service.test.js` | The HTTP service end to end: upload then fetch, HEAD, 304, 400/401/403/404/405/413/500/502, the streaming size limit, CORS and preflight, bearer token, path-traversal attempts, graceful shutdown; the client helper |
| `test/envelope.test.js` | Round trips, envelope layout, wrong key, tampered envelope, key encoding, interoperability with a second AES-GCM implementation, browser compatibility of the module |
| `test/documents.test.js` | Every schema with its examples; missing, unknown, mistyped and out-of-range fields; cross-field rules; builders (deterministic bytes, hash and CID verify); the tables in `docs/schemas/README.md` |
| `test/config.test.js` | Defaults, every variable, invalid values, secrets absent from every printable form |
| `test/cli.test.js` | Every storage command, exit codes, encryption round trip, shutdown on `SIGTERM` |
| `test/simulator.test.js` | The random generator (range, uniformity, independence of seeds and streams); determinism of every scenario; each scenario's shape against refrigerated, frozen, ultra-cold, room-temperature and one-tenth-wide ranges and at the `int16` limits; both clock modes; the `simulate` command |
| `test/rule.test.js` | K - 1 does not trigger and K does, for K from 1 to 10; readings exactly at the minimum and maximum are in range; runs across log boundaries, including K larger than a log; the spike scenario never triggers however the readings are cut into logs |
| `test/runner.test.js` | The runner against a fake registry client and the real local IPFS backend: anchored logs are fetched back by CID and checked (hash, CID, schema); exactly one `reportExcursion` with the right reading and time, then the lot is dropped; inactive lots skipped; a new lot discovered; a reverting call reported while the other lots continue; no reading later than the chain time; storage outages; retries that do not anchor twice; shutdown |
| `test/registry-client.test.js` | Deployment loading from fixture files (missing file, wrong chain id, address override, ABI fallback); every pre-flight check; the real client against an in-memory JSON-RPC endpoint behind a real ethers provider: struct and event decoding, the simulation that stops rejected calls, lost confirmations with both signer types, `evm_mine` only on chain id 31337; decoding of every custom error the oracle can meet; telling transient RPC failures from permanent ones; no RPC URL in any message |
| `test/oracle-cli.test.js` | `--help` of every command, wrong usage, exit codes, the console lines of `check`, `once` and `monitor`, `--json` |
| `test/oracle-process.test.js` | The real executable as a child process, talking JSON-RPC over HTTP to the in-memory stand-in: pre-flight failures, `once`, `monitor` stopped by `SIGINT`, including one Ctrl+C delivered twice (terminal and npm) and a later second Ctrl+C |

The stand-ins implement the contract's rules from its interface and use the committed ABI, so the encoding of calls, events and custom errors is the real one. What only the real contract on a real node can show is checked separately.

### End-to-end test against a real Hardhat node

```bash
# repository root, once: install and compile the contract
npm ci && npx hardhat compile

cd oracle
npm run test:e2e          # about 13 seconds
```

[`test/e2e/real-chain.e2e.js`](test/e2e/real-chain.e2e.js) is not part of `npm test`. It starts its own Hardhat node from the repository root on a free port (never 8545), deploys `ProvenanceRegistry` from the compiled artifact in `../artifacts`, grants `ORACLE_ROLE` to account #4 and `MANUFACTURER_ROLE` to account #1, registers two lots and runs `oracle:once` in-process: a normal log for one lot, an excursion for the other. It checks `verifyBatch`, the `SensorLogAnchored` and `ExcursionReported` events and the keccak256 of each stored file, that the lot became Compromised with `logIndex` equal to `sensorLogCount`, that a call the contract rejects is decoded as `InvalidStatus(batchId=2, current=Compromised)` without a transaction being sent, and that on an idle node `evm_mine` brings the head up to the wall clock. The node is stopped and the temporary store removed at the end, also on failure, on Ctrl+C, and when `SIGINT` or `SIGTERM` reaches only the test runner process. No key is used: the node's unlocked accounts sign. If the artifact or the root `node_modules` is missing, it fails at once and says to run `npm ci && npx hardhat compile` in the repository root.

A manual run against a local Hardhat node with the registry deployed and demo lots seeded (`check`, `once` and `monitor`, every stored log checked with `ipfs:verify`, the monitor with a lot registered and another recalled while it ran, Ctrl+C, a revoked `ORACLE_ROLE`, a wrong registry address and RPC URL, an unwritable store, the node stopped mid-run, a nonce taken by a second sender) also confirmed: the node accepts `eth_sendTransaction` from unlocked account #4 with the oracle's explicit `nonce` and `gas`; revert data arrives in a form the decoder finds from `eth_estimateGas`, `eth_call` and `eth_sendTransaction` (`InvalidStatus`, `ReadingWithinRange`, `InvalidTimestamp`, `BatchNotFound`, `AccessControlUnauthorizedAccount`); and a `deployments/localhost.json` written by `npm run deploy:local` loads.

**Not shown by any test here:** fee estimation and signing with `ORACLE_PRIVATE_KEY` on Amoy, the live Pinata service, and the recovery of a transaction whose confirmation was lost on a real node (it is covered only against the stand-in).

## Source layout

```
oracle/
├── package.json, package-lock.json     dependencies: ethers (v6), ajv (JSON Schema)
├── src/
│   ├── config.js                       environment variables -> validated, frozen config
│   ├── errors.js                       typed errors
│   ├── units.js                        formatting of tenths of a degree and Unix seconds
│   ├── index.js                        public entry point for Node callers
│   ├── ipfs/                           cid.js, multibase.js, local-store.js, gateway.js,
│   │   │                               backend.js (logic shared by the backends), index.js
│   │   └── backends/                   local.js, kubo.js, pinata.js
│   ├── crypto/envelope.js              AES-256-GCM envelope (browser-compatible)
│   ├── documents/                      serialize.js, validator.js, builders.js, index.js
│   ├── service/                        server.js (HTTP service), client.js
│   ├── cli/                            main.js (executable), commands.js: storage and document commands
│   ├── simulator/                      prng.js, scenarios.js, source.js, cli.js, main.js (npm run simulate)
│   └── oracle/                         rule.js, retry.js, deployment.js, revert.js, rpcErrors.js, registryClient.js,
│                                       runner.js, format.js, cli.js, main.js (npm run oracle, oracle:once, oracle:check)
└── test/                               *.test.js, helpers/ (harness, fake registry client, in-memory JSON-RPC chain),
                                        e2e/real-chain.e2e.js (npm run test:e2e: the real contract on a Hardhat node)
```
