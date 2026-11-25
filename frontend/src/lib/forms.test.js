/**
 * Tests of the dashboard forms: what a person types must become a document
 * that validates against the JSON Schemas in docs/schemas/ (through the shared
 * builders) and the right contract arguments, and wrong input must be caught
 * with a plain-language message before anything is uploaded or sent.
 */

import { describe, expect, it } from "vitest";

import lotMetadataExample from "@schemas/examples/lot-metadata.example.json";
import certificateExample from "@schemas/examples/regulator-certificate.example.json";
import sensorLogExample from "@schemas/examples/sensor-log.example.json";

import { computeContentHash, computeRawCid, verifyContent } from "@oracle/ipfs/cid.js";

import { belongsToLot, buildAttachment, computeProductHash, documentBuilders, readDocument } from "./documents.js";
import {
  buildCertificateFields,
  buildLotRegistration,
  describeAttachment,
  EMPTY_CERTIFICATE_FORM,
  EMPTY_LOT_FORM,
  exceedsUploadLimit,
  resolveManufactureDate,
  validateCertificateForm,
  validateLotForm,
} from "./forms.js";

const CHAIN_ID = 31337;
const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TODAY = "2026-11-25";
/** A chain clock in the afternoon (UTC) of TODAY. */
const CHAIN_NOW = Date.UTC(2026, 10, 25, 15, 30) / 1000;

/** A completely filled, valid "Register a lot" form; all values are synthetic. */
const LOT_FORM = Object.freeze({
  productCode: " DEMO-EXM-100 ",
  productName: "Examplamab 100 mg/mL solution for injection (synthetic product)",
  lotNumber: "LOT-2026-0042",
  manufacturerName: "Demo Biologics Manufacturing (synthetic organization)",
  site: "Plant 1, Example City",
  manufactureDate: "2026-11-20",
  expiryDate: "2028-11-20",
  minTemp: "2.0",
  maxTemp: "8",
});

const CERTIFICATE_FORM = Object.freeze({
  certificateNumber: "DMA-2026-000777",
  issuerName: "Demo Medicines Agency (synthetic regulator)",
  scope: "Batch release",
  statement: "The batch documentation was reviewed and the lot is released for distribution.",
});

describe("validateLotForm", () => {
  it("accepts a completely filled form", () => {
    expect(validateLotForm(LOT_FORM, { today: TODAY })).toEqual({});
  });

  it("asks for every missing field of an empty form", () => {
    const errors = validateLotForm({ ...EMPTY_LOT_FORM, minTemp: "", maxTemp: "" }, { today: TODAY });
    expect(Object.keys(errors).sort()).toEqual(
      ["expiryDate", "lotNumber", "manufactureDate", "manufacturerName", "maxTemp", "minTemp", "productCode", "productName", "site"].sort(),
    );
    expect(errors.productCode).toBe("Enter the product code.");
  });

  it("refuses a range whose lowest temperature is above the highest", () => {
    const errors = validateLotForm({ ...LOT_FORM, minTemp: "8", maxTemp: "2" }, { today: TODAY });
    expect(errors).toEqual({ minTemp: "The lowest allowed temperature must be below the highest." });
  });

  it("refuses an empty range (both ends equal), as the contract does", () => {
    expect(validateLotForm({ ...LOT_FORM, minTemp: "5", maxTemp: "5.0" }, { today: TODAY })).toHaveProperty("minTemp");
  });

  it("refuses a temperature with more than one decimal", () => {
    expect(validateLotForm({ ...LOT_FORM, maxTemp: "8.25" }, { today: TODAY })).toHaveProperty("maxTemp");
  });

  it("accepts a manufacture date of today and refuses tomorrow", () => {
    expect(validateLotForm({ ...LOT_FORM, manufactureDate: TODAY }, { today: TODAY })).toEqual({});
    expect(validateLotForm({ ...LOT_FORM, manufactureDate: "2026-11-26" }, { today: TODAY })).toEqual({
      manufactureDate: "The manufacture date cannot be in the future.",
    });
  });

  it("refuses an expiry date that is not after the manufacture date", () => {
    expect(validateLotForm({ ...LOT_FORM, expiryDate: LOT_FORM.manufactureDate }, { today: TODAY })).toEqual({
      expiryDate: "The expiry date must be after the manufacture date.",
    });
  });

  it("refuses text that is longer than the schema allows", () => {
    const errors = validateLotForm({ ...LOT_FORM, productCode: "X".repeat(65), site: "S".repeat(201) }, { today: TODAY });
    expect(errors).toEqual({
      productCode: "The product code can be at most 64 characters long.",
      site: "The manufacturing site can be at most 200 characters long.",
    });
  });
});

describe("resolveManufactureDate", () => {
  it("keeps a date that is in the past for the chain", () => {
    expect(resolveManufactureDate(1793577600, CHAIN_NOW)).toBe(1793577600);
  });

  it("uses the chain's clock when midnight UTC of the picked day is still ahead of it", () => {
    // Early morning east of Greenwich: the local date is already the 26th, but the chain is still on the 25th (UTC).
    const midnightOfTheTwentySixth = Date.UTC(2026, 10, 26) / 1000;
    expect(resolveManufactureDate(midnightOfTheTwentySixth, CHAIN_NOW)).toBe(CHAIN_NOW);
  });
});

describe("buildLotRegistration", () => {
  const registration = buildLotRegistration(LOT_FORM, { chainId: CHAIN_ID, registry: REGISTRY, chainNow: CHAIN_NOW });

  it("produces the registerBatch arguments in the contract's units", () => {
    expect(registration.productHash).toBe(computeProductHash("DEMO-EXM-100", "LOT-2026-0042"));
    expect(registration.manufactureDate).toBe(Date.UTC(2026, 10, 20) / 1000);
    expect(registration.minTempTenthsC).toBe(20);
    expect(registration.maxTempTenthsC).toBe(80);
  });

  it("produces a lot-metadata document that validates against its schema", () => {
    const built = documentBuilders.buildLotMetadata(registration.metadataFields);
    expect(built.document).toMatchObject({
      schemaVersion: 1,
      type: "lot-metadata",
      chainId: CHAIN_ID,
      registry: REGISTRY,
      productCode: "DEMO-EXM-100",
      lotNumber: "LOT-2026-0042",
      manufactureDate: registration.manufactureDate,
      expiryDate: Date.UTC(2028, 10, 20) / 1000,
      storage: { minTenthsC: 20, maxTenthsC: 80 },
      attachments: [],
    });
    // Reading the built bytes back is what the verify page does with a downloaded file.
    expect(readDocument(built.bytes, "lot-metadata")).toEqual({ document: built.document, problem: null });
    expect(built.contentHash).toBe(computeContentHash(built.bytes));
  });

  it("repeats on-chain values in the document exactly", () => {
    const { document } = documentBuilders.buildLotMetadata(registration.metadataFields);
    expect(document.manufactureDate).toBe(registration.manufactureDate);
    expect(document.storage).toEqual({ minTenthsC: registration.minTempTenthsC, maxTenthsC: registration.maxTempTenthsC });
    expect(computeProductHash(document.productCode, document.lotNumber)).toBe(registration.productHash);
  });

  it("records today's date at the chain's clock when midnight UTC has not been reached on-chain", () => {
    const earlyChain = Date.UTC(2026, 10, 24, 23, 0) / 1000;
    const today = buildLotRegistration({ ...LOT_FORM, manufactureDate: TODAY }, { chainId: CHAIN_ID, registry: REGISTRY, chainNow: earlyChain });
    expect(today.manufactureDate).toBe(earlyChain);
    expect(() => documentBuilders.buildLotMetadata(today.metadataFields)).not.toThrow();
  });

  it("includes an encrypted and a plain attachment in a valid document", () => {
    const bytes = new TextEncoder().encode("synthetic attachment");
    const stored = { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length };
    const attachments = [
      buildAttachment(describeAttachment({ fileName: "coa.pdf", fileType: "application/pdf", encrypted: true, stored })),
      buildAttachment(describeAttachment({ fileName: "notes.txt", fileType: "", encrypted: false, stored })),
    ];
    const withFiles = buildLotRegistration(LOT_FORM, { chainId: CHAIN_ID, registry: REGISTRY, chainNow: CHAIN_NOW, attachments });
    const { document } = documentBuilders.buildLotMetadata(withFiles.metadataFields);
    expect(document.attachments).toEqual([
      {
        name: "coa.pdf",
        kind: "supporting-document",
        cid: stored.cid,
        contentHash: stored.contentHash,
        mediaType: "application/pdf",
        size: bytes.length,
        encryption: { scheme: "AES-256-GCM", envelope: 1 },
      },
      {
        name: "notes.txt",
        kind: "supporting-document",
        cid: stored.cid,
        contentHash: stored.contentHash,
        mediaType: "application/octet-stream",
        size: bytes.length,
        encryption: null,
      },
    ]);
  });
});

describe("describeAttachment", () => {
  const stored = { cid: "bafkreigie2gvculpze6ztwnkazg7lns6ecwssasx2xkcv7xjxdnifwkviq", contentHash: `0x${"cd".repeat(32)}`, size: 10 };

  it("shortens an over-long file name and replaces an unusable media type", () => {
    const attachment = describeAttachment({ fileName: `${"a".repeat(200)}.pdf`, fileType: "Not A Type", encrypted: false, stored });
    expect(attachment.name).toHaveLength(128);
    expect(attachment.mediaType).toBe("application/octet-stream");
  });

  it("names a file that has no name", () => {
    expect(describeAttachment({ fileName: "  ", fileType: "text/plain", encrypted: false, stored }).name).toBe("attachment");
  });
});

describe("exceedsUploadLimit", () => {
  it("counts the 29 bytes the encryption envelope adds", () => {
    expect(exceedsUploadLimit(1000, false, 1000)).toBe(false);
    expect(exceedsUploadLimit(1000, true, 1000)).toBe(true);
    expect(exceedsUploadLimit(971, true, 1000)).toBe(false);
  });
});

describe("the certificate form", () => {
  const lot = { id: 6, productHash: computeProductHash("DEMO-EXM-100", "LOT-2026-0042") };

  it("asks for every missing field", () => {
    expect(validateCertificateForm(EMPTY_CERTIFICATE_FORM)).toEqual({
      certificateNumber: "Enter the certificate number.",
      issuerName: "Enter the issuer name.",
      scope: "Enter the scope.",
      statement: "Enter the statement.",
    });
  });

  it("refuses a statement longer than the schema allows", () => {
    expect(validateCertificateForm({ ...CERTIFICATE_FORM, statement: "x".repeat(2001) })).toEqual({
      statement: "The statement can be at most 2000 characters long.",
    });
  });

  it("produces a regulator-certificate document that validates against its schema and belongs to the lot", () => {
    expect(validateCertificateForm(CERTIFICATE_FORM)).toEqual({});
    const fields = buildCertificateFields(CERTIFICATE_FORM, { chainId: CHAIN_ID, registry: REGISTRY, lot, issuedAt: CHAIN_NOW });
    const built = documentBuilders.buildRegulatorCertificate(fields);
    expect(built.document).toMatchObject({
      type: "regulator-certificate",
      lotId: 6,
      productHash: lot.productHash,
      certificateNumber: "DMA-2026-000777",
      issuedAt: CHAIN_NOW,
    });
    const read = readDocument(built.bytes, "regulator-certificate");
    expect(read.problem).toBeNull();
    expect(belongsToLot(read.document, { chainId: CHAIN_ID, registry: REGISTRY, lotId: 6, productHash: lot.productHash })).toBeNull();
  });
});

describe("reading documents", () => {
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const exampleLot = {
    chainId: lotMetadataExample.chainId,
    registry: lotMetadataExample.registry,
    lotId: certificateExample.lotId,
    productHash: certificateExample.productHash,
  };

  it("accepts the example documents of docs/schemas/", () => {
    expect(readDocument(encode(lotMetadataExample), "lot-metadata").problem).toBeNull();
    expect(readDocument(encode(certificateExample), "regulator-certificate").problem).toBeNull();
    expect(readDocument(encode(sensorLogExample), "sensor-log").problem).toBeNull();
  });

  it("refuses bytes that are not JSON", () => {
    expect(readDocument(new Uint8Array([0xff, 0xfe, 0x00]), "lot-metadata")).toEqual({
      document: null,
      problem: "The file is not valid JSON text.",
    });
  });

  it("refuses a document of another type", () => {
    expect(readDocument(encode(sensorLogExample), "lot-metadata").document).toBeNull();
  });

  it("refuses a document with an unknown property, naming it", () => {
    const { document, problem } = readDocument(encode({ ...lotMetadataExample, note: "<img src=x onerror=alert(1)>" }), "lot-metadata");
    expect(document).toBeNull();
    expect(problem).toContain('unknown property "note"');
  });

  it("recognises the documents of the example lot as belonging to it", () => {
    expect(belongsToLot(lotMetadataExample, exampleLot)).toBeNull();
    expect(belongsToLot(certificateExample, exampleLot)).toBeNull();
    expect(belongsToLot(sensorLogExample, exampleLot)).toBeNull();
  });

  it("notices a genuine document that was written for another lot, product or registry", () => {
    expect(belongsToLot(sensorLogExample, { ...exampleLot, lotId: 2 })).toBe("The file was written for a different lot.");
    expect(belongsToLot(lotMetadataExample, { ...exampleLot, productHash: `0x${"00".repeat(32)}` })).toBe(
      "The product code and lot number in the file do not match the lot's on-chain product hash.",
    );
    expect(belongsToLot(certificateExample, { ...exampleLot, productHash: `0x${"00".repeat(32)}` })).toBe(
      "The certificate names a different product.",
    );
    expect(belongsToLot(sensorLogExample, { ...exampleLot, chainId: 80002 })).toBe("The file was written for a different registry.");
    expect(belongsToLot(sensorLogExample, { ...exampleLot, registry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" })).toBe(
      "The file was written for a different registry.",
    );
  });

  it("verifies built bytes against their own reference and rejects edited bytes", () => {
    const fields = buildLotRegistration(LOT_FORM, { chainId: CHAIN_ID, registry: REGISTRY, chainNow: CHAIN_NOW }).metadataFields;
    const built = documentBuilders.buildLotMetadata(fields);
    const reference = { cid: computeRawCid(built.bytes), contentHash: built.contentHash };
    expect(verifyContent(built.bytes, reference).contentHash.matches).toBe(true);

    const edited = Uint8Array.from(built.bytes);
    edited[edited.length - 2] ^= 1;
    expect(verifyContent(edited, reference).contentHash.matches).toBe(false);
  });
});
