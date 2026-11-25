// Demo data for `npm start -- --seed` (scripts/stack.js): five lots, one in
// each state a presenter wants to show, so the web app has something on every
// page the moment it opens.
//
//   Lot 1  Delivered    the happy path, factory to pharmacy: certified, three
//                       sensor logs, a plaintext and an encrypted attachment
//   Lot 2  InTransit    shipped by the manufacturer, not yet accepted
//   Lot 3  Compromised  a temperature excursion was reported at the distributor
//   Lot 4  Recalled     certified, then recalled by the regulator
//   Lot 5  Stored       at the pharmacy, not certified; its history has a
//                       cancelled hand-off and a second distributor
//
// Together the five histories contain every event the contract declares.
//
// How it differs from scripts/demo.js: that script is a contract-level demo
// and keeps its documents in memory. Here every document is real. It is built
// by the builders in oracle/src/documents (the ones the web app and the
// oracle use), uploaded through the running file service, and referenced
// on-chain by the { cid, contentHash } the service returned. A verify page
// can therefore download each file and check it against the chain.
//
// No private key is involved: every transaction is signed by the local
// Hardhat node through its unlocked test accounts (eth_sendTransaction).
//
// Everything below is synthetic: invented products, organizations and
// readings.
import { encodeKey, encrypt, generateKey } from "../../oracle/src/crypto/envelope.js";
import { buildAttachment, computeProductHash, createDocuments } from "../../oracle/src/documents/index.js";
import { UploadServiceClient } from "../../oracle/src/service/client.js";

/**
 * Position of each demo organization among the node's test accounts. #0 to #4
 * are the accounts scripts/grant-roles.js onboards on a local chain. #6 is a
 * second distributor that only this seed needs, so it is onboarded here. It is
 * the account scripts/demo.js uses as its "Distributor B"; #5 is left without
 * a role because demo.js uses it as the outsider that must hold none, so
 * `npm run demo:local` still passes on a seeded chain.
 */
const ACCOUNT_INDEX = { regulator: 0, manufacturer: 1, distributor: 2, pharmacy: 3, oracle: 4, secondDistributor: 6 };

/** Names of the contract's Status enum, in declaration order (index = on-chain value). */
const STATUS = ["Created", "InTransit", "Stored", "Delivered", "Compromised", "Recalled"];

const DAY = 86400;
/** The storage range of every seeded lot: 2.0 C to 8.0 C, in tenths of a degree. */
const RANGE = { minTenthsC: 20, maxTenthsC: 80 };
/** Seconds between two readings of a sensor log; twelve readings make one log, as in the oracle's defaults. */
const SAMPLE_SECONDS = 60;
/** Twelve readings of a refrigerator working normally, around 5 C. */
const NORMAL_READINGS = [51, 52, 50, 49, 51, 53, 54, 52, 51, 50, 52, 53];
/** A refrigeration failure: the temperature climbs past 8.0 C and stays there. */
const EXCURSION_READINGS = [52, 55, 61, 68, 74, 79, 83, 86, 90, 93, 95, 96];
/**
 * Index of the reading that is reported on-chain: 9.0 C, the third
 * consecutive reading above 8.0 C. Three in a row is the oracle's default
 * rule (EXCURSION_RUN_LENGTH in oracle/README.md), so the seeded excursion
 * looks exactly like one the oracle would report.
 */
const EXCURSION_INDEX = 8;
const EXCURSION_RULE = "3 consecutive readings outside 2.0 C to 8.0 C";

/** File name of lot 1's encrypted attachment, also shown in the start-up summary next to its key. */
const ENCRYPTED_ATTACHMENT_NAME = "certificate-of-analysis.txt";

const STORAGE_INSTRUCTIONS = `STORAGE AND HANDLING INSTRUCTIONS (synthetic sample, not a real product)

Product: Examplamab 100 mg/mL solution for injection
Lot:     SEED-0001

Store in a refrigerator at 2.0 C to 8.0 C. Do not freeze.
Keep the vials in the outer carton to protect them from light.
A lot that has been outside this range must not be dispensed.
`;

const CERTIFICATE_OF_ANALYSIS = `CERTIFICATE OF ANALYSIS (synthetic sample, not a real product)

Product: Examplamab 100 mg/mL solution for injection
Lot:     SEED-0001

Appearance   clear, colourless solution   conforms
Assay        98.7 % of label claim        conforms (95.0 % to 105.0 %)
pH           6.1                          conforms (5.8 to 6.4)
Sterility    no growth                    conforms

Confidential: shared with the regulator and the next custodian only.
`;

/**
 * Create the five demo lots on a freshly deployed local registry.
 *
 * @param {object} stack
 * @param {import("ethers").JsonRpcProvider} stack.provider provider of the local Hardhat node
 * @param {import("ethers").Contract} stack.registry the deployed ProvenanceRegistry, connected to `provider`
 * @param {string} stack.fileServiceUrl base URL of the running upload + gateway service
 * @returns {Promise<{
 *   lots: { id: number, status: string, note: string }[],
 *   attachment: { lotId: number, name: string, key: string }
 * }>} the lots in id order with the status read back from the chain, and the
 *     key that decrypts lot 1's confidential attachment (43 base64url characters)
 */
export async function seedDemoLots({ provider, registry, fileServiceUrl }) {
  const documents = createDocuments();
  const files = new UploadServiceClient({ baseUrl: fileServiceUrl });
  // Every document names the deployment it belongs to, so it cannot be passed off as a document of another one.
  const deployment = { chainId: Number((await provider.getNetwork()).chainId), registry: await registry.getAddress() };
  // All times in the documents are counted back from the chain's clock, never this machine's: the
  // contract rejects a manufacture date or an excursion time that is later than the block timestamp.
  const now = (await provider.getBlock("latest")).timestamp;

  /** name -> address of the account, and name -> the registry as that account sees it. */
  const accounts = {};
  const actors = {};
  for (const [name, index] of Object.entries(ACCOUNT_INDEX)) {
    const signer = await provider.getSigner(index);
    accounts[name] = signer.address;
    actors[name] = registry.connect(signer);
  }

  /** Wait until a transaction is mined. A revert surfaces here as an error, which aborts the seed. */
  const mined = async (pending) => (await pending).wait();

  /** Upload a built document's bytes unchanged and return the reference that goes on-chain. */
  const uploadDocument = async (built, name) => {
    const { cid, contentHash } = await files.add(built.bytes, { name });
    return { cid, contentHash };
  };

  /** Upload a text file as a lot attachment. With a key it is encrypted first and only the envelope is stored. */
  const uploadAttachment = async (name, kind, text, key = null) => {
    const plaintext = new TextEncoder().encode(text);
    const stored = await files.add(key ? await encrypt(plaintext, key) : plaintext, { name });
    return buildAttachment({ name, kind, mediaType: "text/plain", ...stored, encrypted: key !== null });
  };

  /** Manufacturer: upload the lot metadata and register the lot. Returns what later documents need. */
  const register = async ({ productCode, lotNumber, productName, ageDays, attachments = [] }) => {
    const manufactureDate = now - ageDays * DAY;
    const expiryDate = manufactureDate + 730 * DAY;
    const metadata = documents.buildLotMetadata({
      ...deployment,
      productCode,
      lotNumber,
      productName,
      manufacturerName: "Demo Biologics Manufacturing (synthetic organization)",
      site: "Plant 1, Example City",
      manufactureDate,
      expiryDate,
      storage: RANGE,
      attachments,
    });
    const productHash = computeProductHash(productCode, lotNumber);
    const reference = await uploadDocument(metadata, "lot-metadata.json");
    await mined(actors.manufacturer.registerBatch(productHash, manufactureDate, RANGE.minTenthsC, RANGE.maxTenthsC, reference));
    // The contract assigns the id; it is read back instead of being assumed to count up from 1.
    return { id: Number(await registry.batchIdOf(productHash)), productHash, expiryDate };
  };

  /** Regulator: upload a certificate for the lot and attach it. */
  const certify = async (lot) => {
    const certificate = documents.buildRegulatorCertificate({
      ...deployment,
      lotId: lot.id,
      productHash: lot.productHash,
      certificateNumber: `DMA-SEED-${String(lot.id).padStart(4, "0")}`,
      issuerName: "Demo Medicines Agency (synthetic regulator)",
      scope: "Batch release",
      statement:
        "The batch documentation for this lot was reviewed and the lot is released for distribution under refrigerated storage at 2.0 C to 8.0 C.",
      issuedAt: now,
      validUntil: lot.expiryDate,
    });
    await mined(actors.regulator.issueCertificate(lot.id, await uploadDocument(certificate, "regulator-certificate.json")));
  };

  /**
   * Oracle: upload one sensor log whose last reading was taken
   * `endedMinutesAgo` minutes before `now`, and anchor it. When
   * `excursionIndex` is given, that reading is recorded in the document's
   * "excursion" entry and the log is sent with reportExcursion instead, so
   * the file and the ExcursionReported event carry the same reading and time.
   */
  const logSensor = async (lot, endedMinutesAgo, tenths, excursionIndex) => {
    const endedAt = now - endedMinutesAgo * 60;
    const readings = tenths.map((tenthsC, index) => ({ t: endedAt - (tenths.length - 1 - index) * SAMPLE_SECONDS, tenthsC }));
    const reported = excursionIndex === undefined ? null : readings[excursionIndex];
    const sensorLog = documents.buildSensorLog({
      ...deployment,
      lotId: lot.id,
      sensorId: `sim-lot-${lot.id}`,
      scenario: reported ? "excursion" : "normal",
      range: RANGE,
      readings,
      excursion: reported && { ...reported, rule: EXCURSION_RULE },
    });
    const reference = await uploadDocument(sensorLog, "sensor-log.json");
    await mined(
      reported
        ? actors.oracle.reportExcursion(lot.id, reported.tenthsC, reported.t, reference)
        : actors.oracle.anchorSensorLog(lot.id, reference),
    );
  };

  /** Normal readings, shifted by a few tenths so that no two logs show the same curve. */
  const normal = (shift) => NORMAL_READINGS.map((tenthsC) => tenthsC + shift);

  /** A complete hand-off: `from` names `to`, and `to` accepts. */
  const handOff = async (lot, from, to) => {
    await mined(actors[from].initiateTransfer(lot.id, accounts[to]));
    await mined(actors[to].acceptTransfer(lot.id));
  };

  // The role script onboards one distributor. Lot 5 travels through a second one, which the
  // regulator onboards here. The check keeps this safe to run on a chain where the regulator
  // has already granted the role by hand.
  const distributorRole = await registry.DISTRIBUTOR_ROLE();
  if (!(await registry.hasRole(distributorRole, accounts.secondDistributor))) {
    await mined(actors.regulator.grantRole(distributorRole, accounts.secondDistributor));
  }

  // Lot 1: the happy path from the factory to the pharmacy, certified, with one log per custodian.
  // The logs end 30, 18 and 6 minutes ago, twelve minutes apart, so they join without a gap.
  // The key is a throwaway key for throwaway data. It is returned so the start-up summary can
  // print it and a presenter can try decryption in the web app.
  const attachmentKey = generateKey();
  const lot1 = await register({
    productCode: "DEMO-EXM-100",
    lotNumber: "SEED-0001",
    productName: "Examplamab 100 mg/mL solution for injection (synthetic product)",
    ageDays: 21,
    attachments: [
      await uploadAttachment("storage-instructions.txt", "storage-instructions", STORAGE_INSTRUCTIONS),
      await uploadAttachment(ENCRYPTED_ATTACHMENT_NAME, "certificate-of-analysis", CERTIFICATE_OF_ANALYSIS, attachmentKey),
    ],
  });
  await certify(lot1);
  await mined(actors.manufacturer.initiateTransfer(lot1.id, accounts.distributor));
  await logSensor(lot1, 30, normal(0));
  await mined(actors.distributor.acceptTransfer(lot1.id));
  await logSensor(lot1, 18, normal(-2));
  await handOff(lot1, "distributor", "pharmacy");
  await logSensor(lot1, 6, normal(3));
  await mined(actors.pharmacy.markDelivered(lot1.id));

  // Lot 2: shipped by the manufacturer and not yet accepted, so the distributor's "accept" and the
  // manufacturer's "cancel" can be shown live. No certificate and no sensor log: the empty states
  // of the verify page, and an active lot for the oracle to log.
  const lot2 = await register({
    productCode: "DEMO-VAX-010",
    lotNumber: "SEED-0002",
    productName: "Demovax suspension for injection, 10-dose vial (synthetic product)",
    ageDays: 9,
  });
  await mined(actors.manufacturer.initiateTransfer(lot2.id, accounts.distributor));

  // Lot 3: the distributor's cold room fails; the oracle reports the excursion and the lot is Compromised.
  const lot3 = await register({
    productCode: "DEMO-SPL-020",
    lotNumber: "SEED-0003",
    productName: "Samplutide 2 mg/mL pre-filled pen (synthetic product)",
    ageDays: 14,
  });
  await certify(lot3);
  await handOff(lot3, "manufacturer", "distributor");
  await logSensor(lot3, 18, normal(1));
  await logSensor(lot3, 6, EXCURSION_READINGS, EXCURSION_INDEX);

  // Lot 4: certified and stored at the distributor, then recalled by the regulator.
  const lot4 = await register({
    productCode: "DEMO-TST-050",
    lotNumber: "SEED-0004",
    productName: "Testamab 50 mg powder for infusion (synthetic product)",
    ageDays: 30,
  });
  await certify(lot4);
  await handOff(lot4, "manufacturer", "distributor");
  await logSensor(lot4, 6, normal(-1));
  await mined(
    actors.regulator.recallBatch(
      lot4.id,
      "Synthetic recall: particles were found in retained samples of this lot during routine re-testing.",
    ),
  );

  // Lot 5: reaches the pharmacy without a certificate, so "issue a certificate" and "mark delivered"
  // can be shown live. Its history adds what lot 1 does not have: a cancelled hand-off, the
  // distributor-to-distributor route and two updateStatus moves.
  const lot5 = await register({
    productCode: "DEMO-MCK-100",
    lotNumber: "SEED-0005",
    productName: "Mockulin 100 units/mL cartridge (synthetic product)",
    ageDays: 5,
  });
  await handOff(lot5, "manufacturer", "distributor");
  await logSensor(lot5, 18, normal(2));
  await mined(actors.distributor.initiateTransfer(lot5.id, accounts.pharmacy));
  await mined(actors.distributor.cancelTransfer(lot5.id));
  await handOff(lot5, "distributor", "secondDistributor");
  await mined(actors.secondDistributor.updateStatus(lot5.id, STATUS.indexOf("InTransit")));
  await mined(actors.secondDistributor.updateStatus(lot5.id, STATUS.indexOf("Stored")));
  await handOff(lot5, "secondDistributor", "pharmacy");
  await logSensor(lot5, 6, normal(-3));

  const expected = [
    { lot: lot1, status: "Delivered", note: "certified; at the pharmacy; 3 sensor logs; 2 attachments, one of them encrypted" },
    { lot: lot2, status: "InTransit", note: "hand-off from the manufacturer to the distributor is open; not certified" },
    { lot: lot3, status: "Compromised", note: "certified; at the distributor; an excursion of 9.0 C was reported" },
    { lot: lot4, status: "Recalled", note: "certified; recalled by the regulator while at the distributor" },
    { lot: lot5, status: "Stored", note: "at the pharmacy; not certified; 2 sensor logs" },
  ];
  const lots = [];
  for (const { lot, status, note } of expected) {
    // The status is read back from the chain, so the summary never describes a seed that went wrong.
    const onChain = STATUS[Number((await registry.verifyBatch(lot.id)).status)];
    if (onChain !== status) throw new Error(`seeded lot ${lot.id} is ${onChain} on-chain, expected ${status}`);
    lots.push({ id: lot.id, status, note });
  }
  return { lots, attachment: { lotId: lot1.id, name: ENCRYPTED_ATTACHMENT_NAME, key: encodeKey(attachmentKey) } };
}
