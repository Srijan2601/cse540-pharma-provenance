/**
 * Tests for the document schemas (docs/schemas/), their examples, and the
 * validators and builders in src/documents/ (design decision O2).
 *
 * The example files in docs/schemas/examples/ are test fixtures as well as
 * documentation: each must validate, and each must be byte-for-byte what its
 * builder produces, so the README can point at them as reference documents.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import { MAX_LOG_READINGS } from "../src/config.js";
import { ENCRYPTION_DESCRIPTOR, inspectEnvelope } from "../src/crypto/envelope.js";
import {
  DEFAULT_SCHEMAS_DIR,
  SCHEMA_VERSION,
  buildAttachment,
  computeProductHash,
  createDocumentValidator,
  createDocuments,
  decodeDocument,
  loadSchemaFiles,
  serializeDocument,
} from "../src/documents/index.js";
import { DocumentValidationError, OracleError } from "../src/errors.js";
import { IPFS_SINGLE_CHUNK_BYTES, computeContentHash, computeRawCid, verifyContent } from "../src/ipfs/cid.js";

const EXAMPLES_DIR = path.join(DEFAULT_SCHEMAS_DIR, "examples");
const documents = createDocuments();
const utf8 = (text) => new TextEncoder().encode(text);

/** Read and parse an example file. A fresh copy each time, so tests can modify it freely. */
async function example(name) {
  const bytes = new Uint8Array(await readFile(path.join(EXAMPLES_DIR, name)));
  return { bytes, document: JSON.parse(new TextDecoder().decode(bytes)) };
}

/** Assert that a document is invalid and that one of the problems is at `pathPattern` with `messagePattern`. */
function assertInvalid(document, pathPattern, messagePattern) {
  const result = documents.validate(document);
  assert.equal(result.valid, false, "expected the document to be invalid");
  assert.ok(
    result.errors.some((problem) => pathPattern.test(problem.path) && messagePattern.test(problem.message)),
    `no problem matching ${pathPattern} / ${messagePattern} in ${JSON.stringify(result.errors)}`,
  );
}

const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const lotFields = () => ({
  chainId: 31337,
  registry: REGISTRY,
  productCode: "DEMO-EXM-100",
  lotNumber: "LOT-2026-0001",
  productName: "Examplamab 100 mg/mL (synthetic)",
  manufacturerName: "Demo Biologics Manufacturing (synthetic)",
  site: "Plant 1, Example City",
  manufactureDate: 1793577600,
  expiryDate: 1856649600,
  storage: { minTenthsC: 20, maxTenthsC: 80 },
});
const certificateFields = () => ({
  chainId: 31337,
  registry: REGISTRY,
  lotId: 1,
  productHash: computeProductHash("DEMO-EXM-100", "LOT-2026-0001"),
  certificateNumber: "DMA-2026-000123",
  issuerName: "Demo Medicines Agency (synthetic)",
  scope: "Batch release",
  statement: "Released for distribution under refrigerated storage.",
  issuedAt: 1793880000,
});
const logFields = () => ({
  chainId: 31337,
  registry: REGISTRY,
  lotId: 1,
  sensorId: "sim-lot-1",
  scenario: "normal",
  range: { minTenthsC: 20, maxTenthsC: 80 },
  readings: [
    { t: 1794301200, tenthsC: 51 },
    { t: 1794301260, tenthsC: 53 },
    { t: 1794301320, tenthsC: 52 },
  ],
});

describe("schema files", () => {
  test("docs/schemas holds the shared definitions and one schema per document type", () => {
    const schemas = loadSchemaFiles();
    assert.deepEqual(
      schemas.map((schema) => path.posix.basename(new URL(schema.$id).pathname)),
      ["common.schema.json", "lot-metadata.schema.json", "regulator-certificate.schema.json", "sensor-log.schema.json"],
    );
    for (const schema of schemas) {
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    }
    assert.deepEqual(documents.types, ["lot-metadata", "regulator-certificate", "sensor-log"]);
  });

  test("every object in every schema forbids unknown properties", () => {
    const openObjects = [];
    const visit = (node, where) => {
      if (Array.isArray(node)) return node.forEach((child, index) => visit(child, `${where}/${index}`));
      if (node === null || typeof node !== "object") return undefined;
      const types = [node.type].flat();
      if (types.includes("object") && node.additionalProperties !== false) openObjects.push(where);
      return Object.entries(node).forEach(([key, child]) => visit(child, `${where}/${key}`));
    };
    for (const schema of loadSchemaFiles()) visit(schema, schema.$id);
    assert.deepEqual(openObjects, []);
  });

  test("the sensor-log reading limit matches the configuration limit and fits one IPFS chunk", () => {
    const sensorLog = loadSchemaFiles().find((schema) => schema.properties?.type?.const === "sensor-log");
    assert.equal(sensorLog.properties.readings.maxItems, MAX_LOG_READINGS);

    // Worst case: the most readings, each with the longest possible numbers.
    const readings = Array.from({ length: MAX_LOG_READINGS }, (_, i) => ({ t: 253402300799 - MAX_LOG_READINGS + i, tenthsC: -32768 }));
    const { bytes } = documents.buildSensorLog({ ...logFields(), readings });
    assert.ok(bytes.length <= IPFS_SINGLE_CHUNK_BYTES, `${bytes.length} bytes must fit in ${IPFS_SINGLE_CHUNK_BYTES}`);
  });

  test("a broken schema file is an error at start-up, not a silently weaker check", () => {
    const schemas = loadSchemaFiles();
    const broken = structuredClone(schemas);
    broken.find((schema) => schema.properties?.type?.const === "sensor-log").properties.lotId = { type: "integer", minimun: 1 };
    assert.throws(() => createDocumentValidator(broken), /minimun/);
    assert.throws(() => loadSchemaFiles("/nonexistent/schemas"), OracleError);
  });
});

describe("example documents", () => {
  const expected = {
    "lot-metadata.example.json": "lot-metadata",
    "regulator-certificate.example.json": "regulator-certificate",
    "sensor-log.example.json": "sensor-log",
    "sensor-log.excursion.example.json": "sensor-log",
  };

  test("there is at least one example per document type and no unexpected file", async () => {
    const files = (await readdir(EXAMPLES_DIR)).filter((file) => file.endsWith(".json")).sort();
    assert.deepEqual(files, Object.keys(expected).sort());
    assert.deepEqual([...new Set(Object.values(expected))].sort(), [...documents.types]);
  });

  for (const [file, type] of Object.entries(expected)) {
    test(`${file} is a valid ${type} document`, async () => {
      const { bytes, document } = await example(file);
      assert.deepEqual(documents.validate(document), { valid: true, type, errors: [] });
      assert.deepEqual(documents.validate(document, type).valid, true);
      assert.equal(documents.parse(bytes, type).type, type);
    });

    test(`${file} is byte-for-byte what its builder produces`, async () => {
      const { bytes, document } = await example(file);
      const { schemaVersion, type: _type, ...fields } = document;
      assert.equal(schemaVersion, SCHEMA_VERSION);
      const builder = { "lot-metadata": documents.buildLotMetadata, "regulator-certificate": documents.buildRegulatorCertificate, "sensor-log": documents.buildSensorLog }[type];
      const built = builder(fields);
      assert.deepEqual(built.bytes, bytes);
      assert.equal(built.contentHash, computeContentHash(bytes));
    });
  }

  test("the examples are consistent with each other and with their attachment files", async () => {
    const lot = (await example("lot-metadata.example.json")).document;
    const certificate = (await example("regulator-certificate.example.json")).document;
    const log = (await example("sensor-log.example.json")).document;
    const excursionLog = (await example("sensor-log.excursion.example.json")).document;

    assert.equal(certificate.productHash, computeProductHash(lot.productCode, lot.lotNumber));
    for (const other of [certificate, log, excursionLog]) {
      assert.equal(other.chainId, lot.chainId);
      assert.equal(other.registry, lot.registry);
    }
    assert.deepEqual(log.range, lot.storage);
    assert.equal(log.excursion, null);
    assert.ok(excursionLog.excursion.tenthsC > lot.storage.maxTenthsC);

    const [instructions, analysis] = lot.attachments;
    const plainFile = new Uint8Array(await readFile(path.join(EXAMPLES_DIR, "attachments", "storage-instructions.txt")));
    assert.equal(instructions.encryption, null);
    assert.equal(instructions.size, plainFile.length);
    assert.equal(verifyContent(plainFile, instructions).ok, true, "the plaintext attachment verifies against its entry");

    const sealedFile = new Uint8Array(await readFile(path.join(EXAMPLES_DIR, "attachments", "certificate-of-analysis.txt.enc")));
    assert.deepEqual(analysis.encryption, ENCRYPTION_DESCRIPTOR);
    assert.equal(analysis.size, sealedFile.length);
    assert.equal(verifyContent(sealedFile, analysis).ok, true, "the encrypted attachment verifies without its key");
    assert.equal(inspectEnvelope(sealedFile).version, 1);
  });

  test("docs/schemas/README.md quotes the real CID and content hash of every example file", async () => {
    const readme = await readFile(path.join(DEFAULT_SCHEMAS_DIR, "README.md"), "utf8");
    const files = [...Object.keys(expected), "attachments/storage-instructions.txt", "attachments/certificate-of-analysis.txt.enc"];
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(path.join(EXAMPLES_DIR, file)));
      const row = readme.split("\n").find((line) => line.includes(`(examples/${file})`) && line.includes("bafkrei"));
      assert.ok(row, `no table row for ${file}`);
      assert.ok(row.includes(`| ${bytes.length} |`), `${file}: size`);
      assert.ok(row.includes(computeRawCid(bytes)), `${file}: CID`);
      assert.ok(row.includes(computeContentHash(bytes)), `${file}: content hash`);
    }
    const lot = (await example("lot-metadata.example.json")).document;
    assert.ok(readme.includes(computeProductHash(lot.productCode, lot.lotNumber)), "product hash");
  });

  test("examples contain only synthetic markers for names of organizations and products", async () => {
    const lot = (await example("lot-metadata.example.json")).document;
    const certificate = (await example("regulator-certificate.example.json")).document;
    for (const label of [lot.productName, lot.manufacturerName, certificate.issuerName]) {
      assert.match(label, /synthetic/i);
    }
  });
});

describe("validation: lot-metadata", () => {
  const valid = () => documents.buildLotMetadata(lotFields()).document;

  test("accepts a minimal document", () => {
    assert.equal(documents.validate(valid()).valid, true);
  });

  test("rejects each missing required field", () => {
    for (const field of Object.keys(valid())) {
      const document = valid();
      delete document[field];
      const result = documents.validate(document, "lot-metadata");
      assert.equal(result.valid, false, `without ${field}`);
    }
    const document = valid();
    delete document.site;
    assertInvalid(document, /^\(document\)$/, /missing the required property "site"/);
  });

  test("rejects an unknown field, so a typo is caught", () => {
    assertInvalid({ ...valid(), expiryDat: 1856649600 }, /^\(document\)$/, /unknown property "expiryDat"/);
    const nested = valid();
    nested.storage.unit = "C";
    assertInvalid(nested, /^\/storage$/, /unknown property "unit"/);
  });

  test("rejects wrong types", () => {
    assertInvalid({ ...valid(), chainId: "31337" }, /^\/chainId$/, /integer/);
    assertInvalid({ ...valid(), manufactureDate: "2026-11-02" }, /^\/manufactureDate$/, /integer/);
    assertInvalid({ ...valid(), storage: [20, 80] }, /^\/storage$/, /object/);
    assertInvalid({ ...valid(), attachments: {} }, /^\/attachments$/, /array/);
    assertInvalid({ ...valid(), productName: 7 }, /^\/productName$/, /string/);
    assertInvalid({ ...valid(), storage: { minTenthsC: 2.5, maxTenthsC: 8 } }, /^\/storage\/minTenthsC$/, /integer/);
  });

  test("rejects out-of-range values", () => {
    assertInvalid({ ...valid(), schemaVersion: 2 }, /^\/schemaVersion$/, /must be 1/);
    assertInvalid({ ...valid(), chainId: 0 }, /^\/chainId$/, />= 1/);
    assertInvalid({ ...valid(), storage: { minTenthsC: -40000, maxTenthsC: 80 } }, /^\/storage\/minTenthsC$/, />= -32768/);
    assertInvalid({ ...valid(), storage: { minTenthsC: 20, maxTenthsC: 32768 } }, /^\/storage\/maxTenthsC$/, /<= 32767/);
    assertInvalid({ ...valid(), manufactureDate: 0 }, /^\/manufactureDate$/, />= 1/);
    assertInvalid({ ...valid(), expiryDate: 1856649600000 }, /^\/expiryDate$/, /<= 253402300799/);
    assertInvalid({ ...valid(), productCode: "" }, /^\/productCode$/, /pattern/);
    assertInvalid({ ...valid(), lotNumber: " LOT-1" }, /^\/lotNumber$/, /pattern/);
    assertInvalid({ ...valid(), productCode: "x".repeat(65) }, /^\/productCode$/, /more than 64/);
    assertInvalid({ ...valid(), registry: "0x1234" }, /^\/registry$/, /pattern/);
  });

  test("applies the cross-field rules", () => {
    assertInvalid({ ...valid(), storage: { minTenthsC: 80, maxTenthsC: 20 } }, /^\/storage\/minTenthsC$/, /lower than maxTenthsC/);
    assertInvalid({ ...valid(), storage: { minTenthsC: 50, maxTenthsC: 50 } }, /^\/storage\/minTenthsC$/, /lower than maxTenthsC/);
    assertInvalid({ ...valid(), expiryDate: 1793577600 }, /^\/expiryDate$/, /later than manufactureDate/);
    // One character of the checksummed address changed in case: the shape is right, the EIP-55 checksum is not.
    assertInvalid({ ...valid(), registry: "0x5fbDB2315678afecb367f032d93F642f64180aa3" }, /^\/registry$/, /checksum/);
  });

  test("validates attachments", () => {
    const attachment = () => buildAttachment({ name: "coa.pdf", kind: "certificate-of-analysis", mediaType: "application/pdf", cid: computeRawCid(utf8("x")), contentHash: computeContentHash(utf8("x")), size: 1, encrypted: true });
    const withAttachment = (change) => ({ ...valid(), attachments: [{ ...attachment(), ...change }] });

    assert.equal(documents.validate(withAttachment({})).valid, true);
    assert.equal(documents.validate(withAttachment({ encryption: null })).valid, true);
    assert.equal(documents.validate(withAttachment({ cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" })).valid, true, "CIDv0 is accepted");

    assertInvalid(withAttachment({ cid: "not-a-cid" }), /^\/attachments\/0\/cid$/, /pattern/);
    assertInvalid(withAttachment({ cid: `b${"a".repeat(58)}` }), /^\/attachments\/0\/cid$/, /not a well-formed CID/);
    assertInvalid(withAttachment({ contentHash: "0xABC" }), /^\/attachments\/0\/contentHash$/, /pattern/);
    assertInvalid(withAttachment({ size: 0 }), /^\/attachments\/0\/size$/, />= 1/);
    assertInvalid(withAttachment({ kind: "Certificate Of Analysis" }), /^\/attachments\/0\/kind$/, /pattern/);
    assertInvalid(withAttachment({ mediaType: "pdf" }), /^\/attachments\/0\/mediaType$/, /pattern/);
    assertInvalid(withAttachment({ encryption: { scheme: "AES-128-CBC", envelope: 1 } }), /^\/attachments\/0\/encryption\/scheme$/, /AES-256-GCM/);
    assertInvalid(withAttachment({ encryption: { scheme: "AES-256-GCM", envelope: 2 } }), /^\/attachments\/0\/encryption\/envelope$/, /must be 1/);
    assertInvalid(withAttachment({ encryption: { scheme: "AES-256-GCM", envelope: 1, key: "leaked" } }), /^\/attachments\/0\/encryption$/, /unknown property "key"/);
    assertInvalid(withAttachment({ encryption: undefined }), /^\/attachments\/0$/, /missing the required property "encryption"/);
    assertInvalid({ ...valid(), attachments: Array.from({ length: 33 }, attachment) }, /^\/attachments$/, /more than 32/);
  });
});

describe("validation: regulator-certificate", () => {
  const valid = () => documents.buildRegulatorCertificate(certificateFields()).document;

  test("accepts a document with and without the optional fields", () => {
    assert.equal(documents.validate(valid()).valid, true);
    assert.equal(documents.validate({ ...valid(), validUntil: 1856649600, attachments: [] }).valid, true);
  });

  test("rejects missing, unknown, mistyped and out-of-range fields", () => {
    for (const field of Object.keys(valid())) {
      const document = valid();
      delete document[field];
      assert.equal(documents.validate(document, "regulator-certificate").valid, false, `without ${field}`);
    }
    assertInvalid({ ...valid(), signature: "0x00" }, /^\(document\)$/, /unknown property "signature"/);
    assertInvalid({ ...valid(), lotId: "1" }, /^\/lotId$/, /integer/);
    assertInvalid({ ...valid(), lotId: 0 }, /^\/lotId$/, />= 1/);
    assertInvalid({ ...valid(), lotId: 1.5 }, /^\/lotId$/, /integer/);
    assertInvalid({ ...valid(), productHash: "0x1234" }, /^\/productHash$/, /pattern/);
    assertInvalid({ ...valid(), productHash: valid().productHash.toUpperCase().replace("0X", "0x") }, /^\/productHash$/, /pattern/);
    assertInvalid({ ...valid(), statement: "" }, /^\/statement$/, /fewer than 1/);
    assertInvalid({ ...valid(), statement: "x".repeat(2001) }, /^\/statement$/, /more than 2000/);
    assertInvalid({ ...valid(), issuedAt: -5 }, /^\/issuedAt$/, />= 1/);
  });

  test("applies the cross-field rules", () => {
    assertInvalid({ ...valid(), validUntil: valid().issuedAt }, /^\/validUntil$/, /later than issuedAt/);
    assertInvalid({ ...valid(), registry: "0x5fbDB2315678afecb367f032d93F642f64180aa3" }, /^\/registry$/, /checksum/);
  });
});

describe("validation: sensor-log", () => {
  const valid = () => documents.buildSensorLog(logFields()).document;
  const excursionLog = () => {
    const readings = [70, 78, 83, 86, 90].map((tenthsC, i) => ({ t: 1794301200 + 60 * i, tenthsC }));
    return documents.buildSensorLog({ ...logFields(), scenario: "excursion", readings, excursion: { ...readings[4], rule: "3 consecutive readings outside 2.0 C to 8.0 C" } }).document;
  };

  test("accepts a log without and with an excursion", () => {
    assert.equal(documents.validate(valid()).valid, true);
    assert.equal(documents.validate(excursionLog()).valid, true);
  });

  test("accepts an out-of-range reading without an excursion: a single spike is not reported", () => {
    const document = valid();
    document.readings[1].tenthsC = 95;
    assert.equal(documents.validate(document).valid, true);
  });

  test("rejects missing, unknown, mistyped and out-of-range fields", () => {
    for (const field of Object.keys(valid())) {
      const document = valid();
      delete document[field];
      assert.equal(documents.validate(document, "sensor-log").valid, false, `without ${field}`);
    }
    assertInvalid({ ...valid(), note: "x" }, /^\(document\)$/, /unknown property "note"/);
    assertInvalid({ ...valid(), readings: [] }, /^\/readings$/, /fewer than 1/);
    assertInvalid({ ...valid(), readings: [{ t: 1794301200 }] }, /^\/readings\/0$/, /missing the required property "tenthsC"/);
    assertInvalid({ ...valid(), readings: [{ t: 1794301200, tenthsC: 51, celsius: 5.1 }] }, /^\/readings\/0$/, /unknown property "celsius"/);
    assertInvalid({ ...valid(), readings: [{ t: 1794301200, tenthsC: 5.1 }] }, /^\/readings\/0\/tenthsC$/, /integer/);
    assertInvalid({ ...valid(), readings: [{ t: "1794301200", tenthsC: 51 }] }, /^\/readings\/0\/t$/, /integer/);
    assertInvalid({ ...valid(), readings: [{ t: 1794301200, tenthsC: 40000 }] }, /^\/readings\/0\/tenthsC$/, /<= 32767/);
    assertInvalid({ ...valid(), readings: [{ t: 1794301200000, tenthsC: 51 }] }, /^\/readings\/0\/t$/, /<= 253402300799/);
    assertInvalid({ ...valid(), scenario: "Normal Run" }, /^\/scenario$/, /pattern/);
    assertInvalid({ ...valid(), sensorId: "" }, /^\/sensorId$/, /pattern/);
    assertInvalid({ ...valid(), excursion: {} }, /^\/excursion$/, /missing the required property/);
    assertInvalid({ ...valid(), excursion: "none" }, /^\/excursion$/, /object,null/);
    assertInvalid({ ...valid(), type: "sensor-logs" }, /^\/type$/, /must be one of/);
    assertInvalid(
      { ...valid(), readings: Array.from({ length: MAX_LOG_READINGS + 1 }, (_, i) => ({ t: 1794301200 + i, tenthsC: 50 })), endedAt: 1794309999 },
      /^\/readings$/,
      /more than 2000/,
    );
  });

  test("applies the cross-field rules", () => {
    const unordered = valid();
    unordered.readings.reverse();
    assertInvalid(unordered, /^\/readings\/1\/t$/, /strictly increasing/);

    const duplicate = valid();
    duplicate.readings[1].t = duplicate.readings[0].t;
    assertInvalid(duplicate, /^\/readings\/1\/t$/, /strictly increasing/);

    assertInvalid({ ...valid(), startedAt: valid().readings[0].t + 1 }, /^\/startedAt$/, /later than the first reading/);
    assertInvalid({ ...valid(), endedAt: valid().readings.at(-1).t - 1 }, /^\/endedAt$/, /earlier than the last reading/);
    assertInvalid({ ...valid(), range: { minTenthsC: 80, maxTenthsC: 20 } }, /^\/range\/minTenthsC$/, /lower than maxTenthsC/);

    const invented = excursionLog();
    invented.excursion.tenthsC = 99;
    assertInvalid(invented, /^\/excursion$/, /must repeat one of the readings/);

    const wrongTime = excursionLog();
    wrongTime.excursion.t += 1;
    assertInvalid(wrongTime, /^\/excursion$/, /must repeat one of the readings/);

    const inRange = excursionLog();
    inRange.excursion = { ...inRange.readings[0], rule: "made up" };
    assertInvalid(inRange, /^\/excursion\/tenthsC$/, /outside range/);

    // Both boundaries are inside the allowed range, exactly as the contract treats them.
    for (const boundary of [20, 80]) {
      const atBoundary = excursionLog();
      atBoundary.readings[0].tenthsC = boundary;
      atBoundary.excursion = { ...atBoundary.readings[0], rule: "boundary" };
      assertInvalid(atBoundary, /^\/excursion\/tenthsC$/, /outside range/);
    }
  });
});

describe("validation: general", () => {
  test("reports every problem at once, not only the first", () => {
    const result = documents.validate({ ...documents.buildSensorLog(logFields()).document, chainId: "x", lotId: 0, extra: true });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 3, JSON.stringify(result.errors));
  });

  test("rejects values that are not documents, and unknown or mismatched types", () => {
    for (const value of [null, undefined, 42, "text", [], [{}]]) {
      assert.equal(documents.validate(value).valid, false);
    }
    assertInvalid({}, /^\/type$/, /must be one of: lot-metadata, regulator-certificate, sensor-log/);
    assertInvalid({ type: "invoice" }, /^\/type$/, /must be one of/);

    const log = documents.buildSensorLog(logFields()).document;
    const mismatch = documents.validate(log, "lot-metadata");
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.errors[0].message, /expected a "lot-metadata" document/);
    assert.match(documents.validate(log, "invoice").errors[0].message, /unknown document type "invoice"/);
  });

  test("assertValid and parse throw DocumentValidationError with the full list", () => {
    assert.throws(
      () => documents.assertValid({ type: "sensor-log" }),
      (error) => error instanceof DocumentValidationError && error.documentType === "sensor-log" && error.errors.length > 5 && /chainId/.test(error.message),
    );
    assert.throws(() => documents.parse(utf8("{ not json")), (error) => error instanceof DocumentValidationError && /not valid JSON/.test(error.message));
    assert.throws(() => documents.parse(Uint8Array.from([0xff, 0xfe, 0x00])), (error) => error instanceof DocumentValidationError && /not valid UTF-8/.test(error.message));
    assert.throws(() => documents.parse(utf8("[1, 2, 3]\n")), DocumentValidationError);
  });
});

describe("builders", () => {
  test("return { document, bytes, contentHash } whose hash and CID verify", async () => {
    const built = [documents.buildLotMetadata(lotFields()), documents.buildRegulatorCertificate(certificateFields()), documents.buildSensorLog(logFields())];
    for (const { document, bytes, contentHash, ...rest } of built) {
      assert.deepEqual(rest, {}, "exactly three properties");
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(contentHash, computeContentHash(bytes));
      assert.equal(verifyContent(bytes, { cid: computeRawCid(bytes), contentHash }).ok, true);
      assert.deepEqual(decodeDocument(bytes), document, "the bytes decode to the document");
      assert.equal(documents.parse(bytes).type, document.type);

      const tampered = Uint8Array.from(bytes);
      tampered[bytes.length - 3] ^= 1;
      assert.equal(verifyContent(tampered, { cid: computeRawCid(bytes), contentHash }).ok, false);
    }
  });

  test("serialize exactly once: two-space JSON, UTF-8, one trailing newline", () => {
    const { document, bytes } = documents.buildSensorLog(logFields());
    const text = new TextDecoder().decode(bytes);
    assert.equal(text, `${JSON.stringify(document, null, 2)}\n`);
    assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"));
    assert.ok(!text.includes("\r"));
    assert.deepEqual(serializeDocument(document), bytes);

    const accented = documents.buildLotMetadata({ ...lotFields(), site: "Usine n° 1, Montréal" });
    assert.ok(Buffer.from(accented.bytes).includes(Buffer.from("Montréal", "utf8")), "non-ASCII text is written as UTF-8, not as \\u escapes");
  });

  test("are deterministic: the same fields in any key order give the same bytes", () => {
    const fields = logFields();
    const shuffled = Object.fromEntries(Object.entries(fields).reverse());
    shuffled.range = { maxTenthsC: 80, minTenthsC: 20 };
    shuffled.readings = fields.readings.map(({ t, tenthsC }) => ({ tenthsC, t }));
    assert.deepEqual(documents.buildSensorLog(shuffled).bytes, documents.buildSensorLog(fields).bytes);

    const lot = lotFields();
    const attachment = buildAttachment({ name: "a.txt", kind: "note", mediaType: "text/plain", cid: computeRawCid(utf8("a")), contentHash: computeContentHash(utf8("a")), size: 1, encrypted: true });
    const reordered = { ...Object.fromEntries(Object.entries(attachment).reverse()), encryption: { envelope: 1, scheme: "AES-256-GCM" } };
    assert.deepEqual(
      documents.buildLotMetadata({ ...lot, attachments: [reordered] }).bytes,
      documents.buildLotMetadata({ ...lot, attachments: [attachment] }).bytes,
    );
  });

  test("write keys in the documented order, starting with schemaVersion and type", () => {
    assert.deepEqual(Object.keys(documents.buildLotMetadata(lotFields()).document), [
      "schemaVersion", "type", "chainId", "registry", "productCode", "lotNumber", "productName", "manufacturerName", "site", "manufactureDate", "expiryDate", "storage", "attachments",
    ]);
    assert.deepEqual(Object.keys(documents.buildRegulatorCertificate({ ...certificateFields(), attachments: [], validUntil: 1856649600 }).document), [
      "schemaVersion", "type", "chainId", "registry", "lotId", "productHash", "certificateNumber", "issuerName", "scope", "statement", "issuedAt", "validUntil", "attachments",
    ]);
    assert.deepEqual(Object.keys(documents.buildSensorLog(logFields()).document), [
      "schemaVersion", "type", "chainId", "registry", "lotId", "sensorId", "scenario", "range", "startedAt", "endedAt", "readings", "excursion",
    ]);
  });

  test("the key order is the order in which the schema files list their properties", () => {
    const schemas = loadSchemaFiles();
    const common = schemas.find((schema) => schema.$id.endsWith("/common.schema.json")).$defs;
    const propertiesOf = (type) => Object.keys(schemas.find((schema) => schema.properties?.type?.const === type).properties);
    const attachment = buildAttachment({ name: "a.txt", kind: "note", mediaType: "text/plain", cid: computeRawCid(utf8("a")), contentHash: computeContentHash(utf8("a")), size: 1, encrypted: true });

    const lot = documents.buildLotMetadata({ ...lotFields(), attachments: [attachment] }).document;
    assert.deepEqual(Object.keys(lot), propertiesOf("lot-metadata"));
    assert.deepEqual(Object.keys(lot.storage), Object.keys(common.temperatureRange.properties));
    assert.deepEqual(Object.keys(lot.attachments[0]), Object.keys(common.attachment.properties));
    assert.deepEqual(Object.keys(lot.attachments[0].encryption), Object.keys(common.encryption.properties));

    const certificate = documents.buildRegulatorCertificate({ ...certificateFields(), validUntil: 1856649600, attachments: [] }).document;
    assert.deepEqual(Object.keys(certificate), propertiesOf("regulator-certificate"));

    const sensorLogSchema = schemas.find((schema) => schema.properties?.type?.const === "sensor-log");
    const readings = logFields().readings.map((reading, i) => (i === 2 ? { ...reading, tenthsC: 90 } : reading));
    const log = documents.buildSensorLog({ ...logFields(), readings, excursion: { ...readings[2], rule: "test rule" } }).document;
    assert.deepEqual(Object.keys(log), propertiesOf("sensor-log"));
    assert.deepEqual(Object.keys(log.readings[0]), Object.keys(sensorLogSchema.properties.readings.items.properties));
    assert.deepEqual(Object.keys(log.excursion), Object.keys(sensorLogSchema.properties.excursion.properties));
  });

  test("fill in defaults: attachments, the covered period, a null excursion, optional fields left out", () => {
    assert.deepEqual(documents.buildLotMetadata(lotFields()).document.attachments, []);

    const log = documents.buildSensorLog(logFields()).document;
    assert.equal(log.startedAt, 1794301200);
    assert.equal(log.endedAt, 1794301320);
    assert.equal(log.excursion, null);
    assert.equal(documents.buildSensorLog({ ...logFields(), startedAt: 1794301000, endedAt: 1794302000 }).document.startedAt, 1794301000);

    const certificate = documents.buildRegulatorCertificate(certificateFields()).document;
    assert.ok(!("validUntil" in certificate) && !("attachments" in certificate));
  });

  test("write the registry address in checksum form whatever case was given", () => {
    const lower = documents.buildSensorLog({ ...logFields(), registry: REGISTRY.toLowerCase() });
    assert.equal(lower.document.registry, REGISTRY);
    assert.deepEqual(lower.bytes, documents.buildSensorLog(logFields()).bytes);
  });

  test("always stamp schemaVersion and type themselves", () => {
    const { document } = documents.buildSensorLog({ ...logFields(), schemaVersion: 99, type: "lot-metadata" });
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.type, "sensor-log");
  });

  test("throw for invalid input and never return bytes for it", () => {
    assert.throws(() => documents.buildSensorLog({ ...logFields(), lotid: 2 }), (error) => error instanceof DocumentValidationError && /unknown property "lotid"/.test(error.message));
    assert.throws(() => documents.buildSensorLog({ ...logFields(), readings: [] }), DocumentValidationError);
    assert.throws(() => documents.buildSensorLog({ ...logFields(), readings: undefined }), DocumentValidationError);
    assert.throws(() => documents.buildSensorLog({ ...logFields(), registry: "0xnope" }), /registry/);
    assert.throws(() => documents.buildLotMetadata({ ...lotFields(), storage: undefined }), /storage/);
    assert.throws(() => documents.buildLotMetadata({ ...lotFields(), attachments: "none" }), /attachments/);
    assert.throws(() => documents.buildRegulatorCertificate({ ...certificateFields(), validUntil: 1 }), /validUntil/);
    assert.throws(() => documents.buildLotMetadata({}), (error) => error instanceof DocumentValidationError && error.errors.length >= 10);
  });

  test("computeProductHash equals keccak256(abi.encode(string, string)), the contract's productHash", () => {
    // Reference value computed independently of AbiCoder: the ABI encoding of two short strings
    // is laid out by hand (two offsets, then length + padded UTF-8 for each) and hashed.
    const word = (value) => value.toString(16).padStart(64, "0");
    const padded = (text) => Buffer.from(text, "utf8").toString("hex").padEnd(64, "0");
    const encoded = `0x${word(0x40)}${word(0x80)}${word(12)}${padded("DEMO-EXM-100")}${word(13)}${padded("LOT-2026-0001")}`;
    assert.equal(computeProductHash("DEMO-EXM-100", "LOT-2026-0001"), computeContentHash(Buffer.from(encoded.slice(2), "hex")));
    assert.notEqual(computeProductHash("DEMO-EXM-100", "LOT-2026-0001"), computeProductHash("DEMO-EXM-10", "0LOT-2026-0001"), "abi.encode keeps the two strings apart");
  });

  test("buildAttachment maps an upload result to an attachment entry", () => {
    const stored = { cid: computeRawCid(utf8("file")), contentHash: computeContentHash(utf8("file")), size: 4 };
    assert.deepEqual(buildAttachment({ name: "f.txt", kind: "note", mediaType: "text/plain", ...stored }), {
      name: "f.txt", kind: "note", cid: stored.cid, contentHash: stored.contentHash, mediaType: "text/plain", size: 4, encryption: null,
    });
    assert.deepEqual(buildAttachment({ name: "f.txt", kind: "note", mediaType: "text/plain", ...stored, encrypted: true }).encryption, { scheme: "AES-256-GCM", envelope: 1 });
  });
});
