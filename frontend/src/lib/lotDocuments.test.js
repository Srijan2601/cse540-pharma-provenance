/**
 * Tests of how the verify page lists a lot's files and what it concludes from
 * each: content is used only from a file that matches its fingerprint AND is a
 * valid document for the lot, and attachments are listed only from such files.
 */

import { describe, expect, it } from "vitest";

import lotMetadataExample from "@schemas/examples/lot-metadata.example.json";
import sensorLogExample from "@schemas/examples/sensor-log.example.json";

import { computeProductHash } from "./documents.js";
import { fileKey, interpretDocument, listAttachments, listRecordedDocuments } from "./lotDocuments.js";

const HASH = `0x${"ab".repeat(32)}`;
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

/** What the chain says about the example lot of docs/schemas/examples/. */
const LOT_CONTEXT = {
  chainId: lotMetadataExample.chainId,
  registry: lotMetadataExample.registry,
  lotId: 1,
  productHash: computeProductHash(lotMetadataExample.productCode, lotMetadataExample.lotNumber),
};

const METADATA_ENTRY = { id: "metadata", kind: "lot-metadata", title: "Lot metadata", label: "the lot metadata", ref: { cid: "bafk-meta", contentHash: HASH } };

describe("listRecordedDocuments", () => {
  const history = {
    sensorLogs: [
      { index: 1, cid: "bafk-log-1", contentHash: HASH, isExcursion: false },
      { index: 2, cid: "bafk-log-2", contentHash: HASH, isExcursion: true },
    ],
  };

  it("lists the metadata, the certificate and every sensor log from the events", () => {
    const lot = { metadata: { cid: "bafk-meta", contentHash: HASH }, certificate: { cid: "bafk-cert", contentHash: HASH } };
    const documents = listRecordedDocuments(lot, history);
    expect(documents.map((document) => document.id)).toEqual(["metadata", "certificate", "sensor-log-1", "sensor-log-2"]);
    expect(documents.map((document) => document.label)).toEqual(["the lot metadata", "the regulator certificate", "sensor log 1", "sensor log 2"]);
    expect(documents[3]).toMatchObject({ kind: "sensor-log", logIndex: 2, isExcursion: true, ref: { cid: "bafk-log-2", contentHash: HASH } });
  });

  it("leaves the certificate out of an uncertified lot", () => {
    const documents = listRecordedDocuments({ metadata: { cid: "bafk-meta", contentHash: HASH }, certificate: null }, { sensorLogs: [] });
    expect(documents.map((document) => document.id)).toEqual(["metadata"]);
  });
});

describe("interpretDocument", () => {
  it("is pending while the check is running", () => {
    expect(interpretDocument(METADATA_ENTRY, undefined, LOT_CONTEXT)).toMatchObject({ status: "pending", document: null, bytes: null });
  });

  it("never reads the content of a file that does not match", () => {
    const checked = interpretDocument(METADATA_ENTRY, { status: "mismatch", reason: "changed" }, LOT_CONTEXT);
    expect(checked).toMatchObject({ status: "mismatch", reason: "changed", document: null, bytes: null, contentInvalid: false });
  });

  it("hands on the content of a matching, valid document of this lot", () => {
    const bytes = encode(lotMetadataExample);
    const checked = interpretDocument(METADATA_ENTRY, { status: "match", bytes }, LOT_CONTEXT);
    expect(checked.document).toEqual(lotMetadataExample);
    expect(checked.bytes).toBe(bytes);
    expect(checked.contentInvalid).toBe(false);
  });

  it("withholds matching bytes that are not a valid document", () => {
    const checked = interpretDocument(METADATA_ENTRY, { status: "match", bytes: encode({ type: "lot-metadata" }) }, LOT_CONTEXT);
    expect(checked.document).toBeNull();
    expect(checked.contentInvalid).toBe(true);
    expect(checked.contentProblem).toContain("not a valid lot-metadata document");
  });

  it("withholds a valid document that belongs to another lot", () => {
    const entry = { id: "sensor-log-1", kind: "sensor-log", title: "Temperature log 1", label: "sensor log 1", ref: METADATA_ENTRY.ref, logIndex: 1 };
    const checked = interpretDocument(entry, { status: "match", bytes: encode(sensorLogExample) }, { ...LOT_CONTEXT, lotId: 2 });
    expect(checked.document).toBeNull();
    expect(checked.contentProblem).toBe("The file was written for a different lot.");
  });

  it("does not try to parse an attachment", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const entry = { id: "metadata-attachment-0", kind: "attachment", title: "a.bin", label: 'the attachment "a.bin"', ref: METADATA_ENTRY.ref, attachment: {} };
    expect(interpretDocument(entry, { status: "match", bytes }, LOT_CONTEXT)).toMatchObject({ status: "match", bytes, document: null, contentInvalid: false });
  });
});

describe("listAttachments", () => {
  it("lists the attachments of a verified document", () => {
    const metadata = interpretDocument(METADATA_ENTRY, { status: "match", bytes: encode(lotMetadataExample) }, LOT_CONTEXT);
    const attachments = listAttachments([metadata]);
    expect(attachments.map((attachment) => attachment.title)).toEqual(["storage-instructions.txt", "certificate-of-analysis.txt"]);
    expect(attachments[1]).toMatchObject({
      id: "metadata-attachment-1",
      kind: "attachment",
      label: 'the attachment "certificate-of-analysis.txt"',
      ref: { cid: lotMetadataExample.attachments[1].cid, contentHash: lotMetadataExample.attachments[1].contentHash },
    });
    expect(attachments[1].attachment.encryption).toEqual({ scheme: "AES-256-GCM", envelope: 1 });
  });

  it("lists nothing from a document that did not pass its checks", () => {
    const mismatched = interpretDocument(METADATA_ENTRY, { status: "mismatch", reason: "changed" }, LOT_CONTEXT);
    const pending = interpretDocument(METADATA_ENTRY, undefined, LOT_CONTEXT);
    expect(listAttachments([mismatched, pending])).toEqual([]);
  });
});

describe("fileKey", () => {
  it("identifies a file by its address and its fingerprint together", () => {
    expect(fileKey({ cid: "bafk-a", contentHash: HASH })).toBe(`bafk-a|${HASH}`);
  });
});
