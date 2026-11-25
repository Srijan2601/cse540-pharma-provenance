# docs/schemas/: the off-chain documents

The registry contract stores only a pointer to each large file: `DocumentRef { string cid; bytes32 contentHash }`. The files themselves are JSON documents on IPFS. This folder defines them (design decisions **O1**, **O2**, **O5** in [`../design-decisions.md`](../design-decisions.md)).

The schema files are the single source of truth. The validators and builders in [`oracle/src/documents/`](../../oracle/src/documents/) are driven by them, and the tests in [`oracle/test/documents.test.js`](../../oracle/test/documents.test.js) check every example here against its schema.

## Files

| Schema (JSON Schema draft 2020-12) | Document | Uploaded by | When | Referenced on-chain by |
|---|---|---|---|---|
| [`lot-metadata.schema.json`](lot-metadata.schema.json) | Lot metadata v1 | Manufacturer | before `registerBatch` | `Batch.metadata`, `BatchRegistered.metadataCid` |
| [`regulator-certificate.schema.json`](regulator-certificate.schema.json) | Regulator certificate v1 | Regulator | before `issueCertificate` | `Batch.certificate`, `CertificateIssued` |
| [`sensor-log.schema.json`](sensor-log.schema.json) | Sensor log v1 | IoT oracle | before `anchorSensorLog` or `reportExcursion` | `Batch.latestSensorLog`, `SensorLogAnchored`, `ExcursionReported` |
| [`common.schema.json`](common.schema.json) | Shared definitions (address, CID, temperature, time, attachment) | | | |

The `$id` of each schema is an identifier under the reserved `.example` domain. Nothing is fetched from it; `$ref`s between the files are resolved locally.

## Rules that apply to every document

1. **Numbers mirror the contract.** Temperatures are integers in tenths of a degree Celsius (`54` is 5.4 °C, the contract's `int16`). Times are integers in Unix seconds (the contract's `uint64`). There are no floating-point numbers and no date strings.
2. **Every document says where it belongs.** `chainId` and `registry` bind it to one deployment of the registry, and `lotId` (or, for lot metadata, `productCode` + `lotNumber`) binds it to one lot. A genuine document for lot 1 cannot be passed off as a document for lot 2, or for a registry on another chain.
3. **No unknown properties.** Every object sets `additionalProperties: false`, so a misspelled field is an error instead of being silently ignored.
4. **`schemaVersion` and `type` come first.** A reader uses them to pick the schema. A future incompatible format gets a new `schemaVersion` and a new schema file; the version 1 files never change meaning.
5. **Public by design.** These three documents are plaintext because a patient must be able to read and check them. Confidential material goes into encrypted *attachments* (see below). Personal data is never uploaded.

## The serialization rule

The on-chain `contentHash` is `keccak256` of the **exact bytes that were uploaded**. JSON has many equivalent spellings, so a document is turned into bytes exactly once:

```
bytes = UTF-8( JSON.stringify(document, null, 2) + "\n" )
```

Those bytes are hashed, uploaded and anchored as they are. **Never parse a document and serialize it again to check a hash**: hash the bytes you downloaded. Key order is fixed by the builders (the order in which each schema lists its `properties`), so the same fields always give the same bytes, CID and hash.

## Lot metadata v1

Describes the lot for people: what it is, who made it, how it must be stored.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion`, `type` | `1`, `"lot-metadata"` | format version and discriminator |
| `chainId`, `registry` | integer, address | the deployment the lot is registered in |
| `productCode`, `lotNumber` | string | inputs of the on-chain `productHash = keccak256(abi.encode(string productCode, string lotNumber))` |
| `productName`, `manufacturerName`, `site` | string | labels shown on the verify page |
| `manufactureDate`, `expiryDate` | Unix seconds | `manufactureDate` is the value passed to `registerBatch` |
| `storage` | `{ minTenthsC, maxTenthsC }` | the range passed to `registerBatch` (2.0 °C to 8.0 °C is `20` and `80`) |
| `attachments` | array, may be empty | supporting files, for example the manufacturer's certificate of analysis (decision **C6**) |

Example: [`examples/lot-metadata.example.json`](examples/lot-metadata.example.json).

## Regulator certificate v1

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion`, `type` | `1`, `"regulator-certificate"` | |
| `chainId`, `registry`, `lotId` | integer, address, integer | the lot being certified |
| `productHash` | bytes32 hex | the lot's on-chain `productHash`; ties the certificate to the product as well as to the lot id |
| `certificateNumber`, `issuerName`, `scope`, `statement` | string | the certificate itself |
| `issuedAt` | Unix seconds | |
| `validUntil` | Unix seconds, optional | must be later than `issuedAt` |
| `attachments` | array, optional | for example an inspection report |

Example: [`examples/regulator-certificate.example.json`](examples/regulator-certificate.example.json).

## Sensor log v1

One batch of temperature readings for one lot.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion`, `type` | `1`, `"sensor-log"` | |
| `chainId`, `registry`, `lotId` | integer, address, integer | the lot the readings belong to |
| `sensorId` | string | which (simulated) sensor took the readings |
| `scenario` | kebab-case string | where the data comes from; the simulator writes `normal`, `excursion`, `freeze` or `spike` |
| `range` | `{ minTenthsC, maxTenthsC }` | the lot's allowed range, copied from the chain so the log can be read on its own |
| `startedAt`, `endedAt` | Unix seconds | the period covered |
| `readings` | `[{ t, tenthsC }]`, 1 to 2000 | ordered by strictly increasing `t` |
| `excursion` | `null` or `{ t, tenthsC, rule }` | the reading the oracle reports on-chain, with the rule that triggered |

`excursion` is what links the file to the chain: when it is not `null`, `tenthsC` and `t` equal `readingTenthsC` and `observedAt` in the lot's `ExcursionReported` event, the reading is one of `readings`, and it lies outside `range`. A single out-of-range reading with `excursion: null` is valid: the off-chain rule needs several consecutive readings before it reports (K, 3 by default; see [`oracle/README.md`](../../oracle/README.md#the-excursion-rule)). The oracle counts a run across consecutive logs of a lot, so the readings that complete a run may follow out-of-range readings at the end of the lot's previous log. In that case `rule` ends with "(the run began in the previous log)", and this file alone holds fewer than K out-of-range readings before the reported one.

Examples: [`examples/sensor-log.example.json`](examples/sensor-log.example.json) (normal) and [`examples/sensor-log.excursion.example.json`](examples/sensor-log.excursion.example.json) (a refrigeration failure; the third consecutive reading above 8.0 °C is reported).

## Attachments and confidential files

An attachment entry describes a file stored on IPFS next to the document:

```json
{
  "name": "certificate-of-analysis.txt",
  "kind": "certificate-of-analysis",
  "cid": "bafkrei...",
  "contentHash": "0x...",
  "mediaType": "text/plain",
  "size": 483,
  "encryption": { "scheme": "AES-256-GCM", "envelope": 1 }
}
```

`cid`, `contentHash` and `size` always describe the **uploaded bytes**. `mediaType` describes the original file. `encryption` is `null` for a plaintext file.

| Class of data | Stored as | Examples |
|---|---|---|
| Public | plaintext on IPFS | lot metadata, regulator certificate, sensor logs, storage instructions |
| Confidential | encrypted before upload; only the ciphertext is on IPFS | full certificate of analysis, commercial paperwork |
| Personal | never uploaded | anything about a patient or an employee |

A confidential attachment is encrypted **before** upload with AES-256-GCM. The recorded hash covers the encrypted bytes, so anyone can verify that the file is the one the manufacturer referenced, while only key holders can read it. Keys are shared out of band; they are never uploaded and never put on-chain.

**Envelope version 1** (what `"envelope": 1` means; implemented in [`oracle/src/crypto/envelope.js`](../../oracle/src/crypto/envelope.js) with the WebCrypto API, so the same file runs in Node.js and in the browser):

| Bytes | Content |
|---|---|
| 0 | `0x01`, the envelope version |
| 1 to 12 | IV: 96 random bits, new for every encryption |
| 13 to end | AES-256-GCM ciphertext followed by the 16-byte authentication tag |

The key is 32 random bytes, exchanged as 43 characters of unpadded base64url. An envelope is 29 bytes longer than its plaintext.

## Rules checked in addition to the schemas

JSON Schema cannot compare one field with another. The validator applies these rules after the schema check; they are implemented in [`oracle/src/documents/validator.js`](../../oracle/src/documents/validator.js).

| Document | Rule |
|---|---|
| all | `registry` has a valid EIP-55 checksum when it mixes upper and lower case |
| lot metadata | `storage.minTenthsC < storage.maxTenthsC`; `expiryDate > manufactureDate`; every attachment `cid` parses as a CID |
| regulator certificate | `validUntil > issuedAt` when present; every attachment `cid` parses as a CID |
| sensor log | `range.minTenthsC < range.maxTenthsC`; `readings` strictly increasing in `t`; `startedAt <=` first reading and `endedAt >=` last reading; a non-null `excursion` repeats one of the readings and lies outside `range` |

## Examples

All example data is synthetic: the product, the organizations and the readings are invented. `chainId` is 31337 and `registry` is the address the local Hardhat node gives the first contract its first account deploys, so the examples match the local demo.

Each example file is exactly what its builder outputs, so its CID and content hash can be reproduced (`npm run ipfs:hash -- <file>` in `oracle/`). Kubo 0.43.2 (`ipfs add --only-hash --cid-version=1`) reports the same six CIDs:

| File | Size | CID | contentHash (keccak256) |
|---|---|---|---|
| [`examples/lot-metadata.example.json`](examples/lot-metadata.example.json) | 1281 | `bafkreifn24qape4xzzat2w7znw37pxyysyc5nu7fq55oerxvdlyo4vxfky` | `0xd6257e1c423b9329637f9fcc3ac61e05cc453f803ee67e55bc8a68d8c866aba7` |
| [`examples/regulator-certificate.example.json`](examples/regulator-certificate.example.json) | 583 | `bafkreiabs6r2eujbt6lz7rktcyvfa5ooxd4nwuhozgul6qf4yxwp3orm6u` | `0xc33a4064c2ecf68cb4ec7ebd79423b8637c41e3b94e65f5a550883959423a8a5` |
| [`examples/sensor-log.example.json`](examples/sensor-log.example.json) | 1020 | `bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi` | `0x643aee49a5cee8cda76e05dcbca98c1d25e31542a9abf73617d3d0caa55ed91a` |
| [`examples/sensor-log.excursion.example.json`](examples/sensor-log.excursion.example.json) | 1124 | `bafkreidgcnqkaf5afsyrippogw2kojub6zqn5exklyvmflvpuxwlot4sii` | `0xdace4994ce7745941d25d7d4cedc5e1073945dc6328179517d1edd0e6c49d647` |
| [`examples/attachments/storage-instructions.txt`](examples/attachments/storage-instructions.txt) | 334 | `bafkreigie2gvculpze6ztwnkazg7lns6ecwssasx2xkcv7xjxdnifwkviq` | `0xc35d0a807ea978dcf50ba2d38372aad5bcf1b86057602401b1a7d836cd1e5db9` |
| [`examples/attachments/certificate-of-analysis.txt.enc`](examples/attachments/certificate-of-analysis.txt.enc) | 483 | `bafkreiamsw6sjqwbn32dobtz7jm3tnrsgmnic46lxeqgoiyq4pzzxxbt5m` | `0x6e16d391b4c3cb32be75dfe48cb6bddf63d22098fbdb5e2ce56976a0dd177d46` |

The two attachment files are the ones listed in the lot-metadata example. `certificate-of-analysis.txt.enc` is a real envelope whose key was discarded after it was made: it shows that an encrypted attachment can be verified (CID, hash, size, envelope version) by someone who cannot read it.

The product hash of the example lot is `keccak256(abi.encode("DEMO-EXM-100", "LOT-2026-0001"))` = `0x383e0be318c9c469b8db3be596b5b30ee8c4a6a9e3e2b5f9e08a266fbcd586e2`, the value in the certificate example.

## Verifying a document by hand

The verify page does this automatically. To do it yourself for any document:

1. **Read the reference from the chain.** `verifyBatch(lotId)` returns `metadata`, `certificate` and `latestSensorLog`, each a `{ cid, contentHash }` pair. Earlier sensor logs and certificates are in the lot's `SensorLogAnchored`, `ExcursionReported` and `CertificateIssued` events.

2. **Download the exact bytes** from any gateway. Do not open and re-save the file.

   ```bash
   curl -s -o document.json http://127.0.0.1:8787/ipfs/<cid>      # the local demo gateway (npm run service)
   curl -s -o document.json https://ipfs.io/ipfs/<cid>             # a public gateway, for content pinned on public IPFS
   ```

3. **Hash the file with keccak256 and compare with `contentHash`.** From `oracle/` (which has ethers installed):

   ```bash
   node --input-type=module -e 'import { readFileSync } from "node:fs"; import { keccak256 } from "ethers"; console.log(keccak256(readFileSync(process.argv[1])));' document.json
   ```

   If the output differs from the on-chain `contentHash`, the file is not the one that was anchored.

4. **Optionally check the CID too.** A CID that starts with `bafkrei` is the SHA-256 of the file in another notation, so recomputing it from the file must give the CID you asked for:

   ```bash
   npm run ipfs:hash -- document.json                       # from oracle/: prints the CID and the content hash
   ipfs add --only-hash --cid-version=1 document.json       # the same CID from a real IPFS installation
   ```

   A CID that starts with `bafybei` or `Qm` belongs to a file that IPFS split into several blocks; it is not a plain hash of the file, and step 3 is the check.

5. **Check that the document belongs to this lot.** Its `chainId` and `registry` must be the chain and contract you read from, and its `lotId` the lot you asked about. For a sensor log with an `excursion`, `tenthsC` and `t` must equal `readingTenthsC` and `observedAt` of the lot's `ExcursionReported` event.

Steps 2 to 4 in one command, plus a schema check:

```bash
cd oracle
npm run ipfs:verify -- <cid> <contentHash> --gateway http://127.0.0.1:8787
npm run doc:validate -- document.json
```

`ipfs:verify` exits with status 0 only if the content matches. Without `--gateway` it reads the local store first.

**An encrypted attachment** is verified in the same way, without the key (steps 2 to 4 on the encrypted file). Reading it needs the key:

```bash
npm run ipfs:get -- <cid> --decrypt --key-file coa.key --out certificate-of-analysis.txt
```

Decryption fails if the key is wrong or if a single byte of the file was changed.
