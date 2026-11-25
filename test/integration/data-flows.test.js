// Integration test: one drug lot through the five data flows of the proposal.
//
//   1 Register  the manufacturer registers the lot; its metadata JSON is on
//               IPFS, and the CID and hash go on-chain
//   2 Hand off  manufacturer -> distributor A -> distributor B -> pharmacy,
//               each hand-off a signed initiate/accept pair
//   3 Monitor   the oracle anchors sensor logs during shipment and storage
//   4 Oversee   the regulator onboards the organizations, certifies the lot
//               and later replaces the certificate
//   5 Verify    a reader with no wallet checks the record, rebuilds the whole
//               timeline from event logs filtered by the batchId topic, and
//               checks every IPFS file against its on-chain hash
//
// The `it` blocks below are consecutive stages of one journey and share its
// state, so they run together and in order (mocha keeps the declaration
// order). A stage runs only if every stage before it passed in this run;
// otherwise it is reported as pending instead of failing on state an earlier
// stage never built. So one regression shows up as one failure, and to run
// the journey on its own, select it whole:
//   npx hardhat test mocha test/integration/data-flows.test.js --grep "data flows 1-5"
// Every write goes through `write`, which checks the write's single event and
// records it in `expectedTimeline`, the history the reader must find in
// stage 5.
import { expect } from "chai";
import { Contract, ZeroAddress } from "ethers";
import { artifacts, network } from "hardhat";

import {
  deployRegistry,
  documentMatches,
  FakeIpfs,
  fullView,
  latestTimestamp,
  onboardingPlan,
  PRODUCT_CODE,
  productHashOf,
  readLogs,
  rebuildableView,
  replay,
  sendWrite,
  Status,
} from "./support.js";

const { ethers, networkHelpers } = await network.create();

// loadFixture needs a named function to cache the deployment.
async function freshRegistry() {
  return deployRegistry(ethers);
}

describe("Integration: one lot through data flows 1-5", function () {
  const LOT_NUMBER = "LOT-2026-E2E-001";
  const MIN_TEMP = 20; // 2.0 C
  const MAX_TEMP = 80; // 8.0 C

  let context, registry, actors, ipfs;
  let batchId, productHash, manufactureDate, registeredAt, metadata;
  let reader, history;
  const expectedTimeline = []; // {event, transactionHash} of every write, in order
  const sensorLogs = []; // DocumentRefs the oracle anchored, in order
  const certificates = []; // DocumentRefs the regulator issued, in order

  before(async function () {
    context = await networkHelpers.loadFixture(freshRegistry);
    ({ registry, actors } = context);
    ipfs = new FakeIpfs();
  });

  // Stage gating. `stagesPassed` counts the stages, from the first, that
  // passed without a gap. A stage whose predecessors did not all pass (one
  // failed, or --grep filtered it out) is skipped, i.e. reported as pending.
  let stagesPassed = 0;
  const stageIndex = (test) => test.parent.tests.indexOf(test);
  beforeEach(function () {
    if (stageIndex(this.currentTest) > stagesPassed) this.skip();
  });
  afterEach(function () {
    if (this.currentTest.state === "passed") stagesPassed = stageIndex(this.currentTest) + 1;
  });

  /** Send one write, check its single event against `expectedEvent`, and add it to the expected timeline. */
  async function write(txPromise, expectedEvent) {
    const { event, receipt } = await sendWrite(registry, txPromise);
    expect(event).to.deep.equal(expectedEvent);
    expectedTimeline.push({ event: expectedEvent, transactionHash: receipt.hash });
    return receipt;
  }

  async function expectRecord(expected) {
    const record = await registry.verifyBatch(batchId);
    for (const [field, value] of Object.entries(expected)) {
      expect(record[field], field).to.equal(value);
    }
  }

  /** Data flow 3: the oracle uploads a sensor log to IPFS and anchors its CID and hash. */
  async function anchorLog(sensorId, readingsTenthsC) {
    const sensorLog = ipfs.addJson({ type: "sensor-log", lotId: batchId.toString(), sensorId, readingsTenthsC });
    sensorLogs.push(sensorLog);
    await write(registry.connect(actors.oracle).anchorSensorLog(batchId, sensorLog), {
      name: "SensorLogAnchored",
      batchId,
      logIndex: BigInt(sensorLogs.length),
      cid: sensorLog.cid,
      contentHash: sensorLog.contentHash,
    });
  }

  /** Data flow 4: the regulator uploads a certificate to IPFS and attaches it to the lot. */
  async function certify(certificateNumber, statement) {
    const certificate = ipfs.addJson({ type: "regulator-certificate", lotId: batchId.toString(), certificateNumber, statement });
    certificates.push(certificate);
    await write(registry.connect(actors.regulator).issueCertificate(batchId, certificate), {
      name: "CertificateIssued",
      batchId,
      regulator: actors.regulator.address,
      cid: certificate.cid,
      contentHash: certificate.contentHash,
    });
  }

  async function initiate(from, to) {
    await write(registry.connect(from).initiateTransfer(batchId, to.address), {
      name: "TransferInitiated",
      batchId,
      from: from.address,
      to: to.address,
    });
  }

  async function accept(from, to) {
    await write(registry.connect(to).acceptTransfer(batchId), {
      name: "CustodyTransferred",
      batchId,
      from: from.address,
      to: to.address,
    });
  }

  async function updateStatus(distributor, previousStatus, newStatus) {
    await write(registry.connect(distributor).updateStatus(batchId, newStatus), {
      name: "StatusUpdated",
      batchId,
      previousStatus,
      newStatus,
      by: distributor.address,
    });
  }

  it("4 Oversee: the regulator onboards four organizations and a second distributor", async function () {
    const { regulator, manufacturer, outsider } = actors;
    for (const [role, account] of onboardingPlan(context)) {
      await expect(registry.connect(regulator).grantRole(role, account.address))
        .to.emit(registry, "RoleGranted")
        .withArgs(role, account.address, regulator.address);
      expect(await registry.hasRole(role, account.address)).to.equal(true);
    }

    // Onboarding is the regulator's alone.
    await expect(registry.connect(manufacturer).grantRole(context.roles.DISTRIBUTOR, outsider.address))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(manufacturer.address, context.roles.REGULATOR);
  });

  it("1 Register: the manufacturer registers the lot with its metadata on IPFS", async function () {
    const { manufacturer } = actors;
    productHash = productHashOf(PRODUCT_CODE, LOT_NUMBER);
    manufactureDate = (await latestTimestamp(ethers.provider)) - 2 * 86_400;
    metadata = ipfs.addJson({
      type: "lot-metadata",
      productCode: PRODUCT_CODE,
      lotNumber: LOT_NUMBER,
      productName: "Synthetic test vaccine",
      site: "Plant A",
      manufactureDate,
      expiryDate: "2027-12-31",
    });

    // The first lot gets ID 1.
    const receipt = await write(
      registry.connect(manufacturer).registerBatch(productHash, manufactureDate, MIN_TEMP, MAX_TEMP, metadata),
      { name: "BatchRegistered", batchId: 1n, manufacturer: manufacturer.address, productHash, metadataCid: metadata.cid },
    );
    batchId = 1n;
    registeredAt = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);

    expect(await registry.totalBatches()).to.equal(1n);
    expect(await registry.batchIdOf(productHash)).to.equal(batchId);
    await expectRecord({ status: Status.Created, custodian: manufacturer.address, pendingCustodian: ZeroAddress });
  });

  it("2+3 Hand off and monitor: manufacturer -> distributor A, with a sensor log from the truck", async function () {
    const { manufacturer, distributorA } = actors;
    await initiate(manufacturer, distributorA);
    // Custody does not move until the recipient accepts.
    await expectRecord({ status: Status.InTransit, custodian: manufacturer.address, pendingCustodian: distributorA.address });

    await anchorLog("TRUCK-M-A", [42, 45, 47]);
    await accept(manufacturer, distributorA);
    await expectRecord({ status: Status.Stored, custodian: distributorA.address, pendingCustodian: ZeroAddress });
  });

  it("2-4: distributor A stores the lot, the regulator certifies it, and A moves it warehouse -> truck -> hub", async function () {
    const { distributorA } = actors;
    await anchorLog("WAREHOUSE-A", [50, 51]);
    await certify("CERT-0001", "Released for distribution");

    await updateStatus(distributorA, Status.Stored, Status.InTransit);
    await anchorLog("TRUCK-A-HUB", [61, 63]);
    await updateStatus(distributorA, Status.InTransit, Status.Stored);
    await expectRecord({ status: Status.Stored, custodian: distributorA.address, sensorLogCount: 3n });
  });

  it("2: distributor B takes over and hands the lot to the pharmacy; the regulator replaces the certificate", async function () {
    const { distributorA, distributorB, pharmacy } = actors;
    await initiate(distributorA, distributorB);
    await accept(distributorA, distributorB);
    await anchorLog("WAREHOUSE-B", [44]);

    await initiate(distributorB, pharmacy);
    await accept(distributorB, pharmacy);
    await certify("CERT-0002", "Re-inspected after cross-dock transfer");

    // Only the newest certificate is stored; the first one stays in the event history (C6).
    const record = await registry.verifyBatch(batchId);
    expect(record.certificate.cid).to.equal(certificates[1].cid);
    expect(record.certificate.contentHash).to.equal(certificates[1].contentHash);
  });

  it("2: the pharmacy marks the lot delivered", async function () {
    const { pharmacy } = actors;
    await write(registry.connect(pharmacy).markDelivered(batchId), {
      name: "StatusUpdated",
      batchId,
      previousStatus: Status.Stored,
      newStatus: Status.Delivered,
      by: pharmacy.address,
    });
  });

  it("5 Verify: a reader with no wallet reads the full record with verifyBatch", async function () {
    // The verify page knows only the registry address and its ABI, and talks
    // to a read-only RPC endpoint.
    const { abi } = await artifacts.readArtifact("ProvenanceRegistry");
    reader = new Contract(await registry.getAddress(), abi, ethers.provider);

    let sendError;
    try {
      await reader.recallBatch(batchId, "a reader cannot write");
    } catch (error) {
      sendError = error;
    }
    expect(sendError?.code, "the reader has no signer").to.equal("UNSUPPORTED_OPERATION");

    const { manufacturer, pharmacy } = actors;
    const latestLog = sensorLogs.at(-1);
    expect(fullView(await reader.verifyBatch(batchId))).to.deep.equal({
      id: batchId,
      productHash,
      manufacturer: manufacturer.address,
      registeredAt,
      metadataCid: metadata.cid,
      status: Status.Delivered,
      custodian: pharmacy.address,
      pendingCustodian: ZeroAddress,
      sensorLogCount: 4n,
      certificate: { cid: certificates[1].cid, contentHash: certificates[1].contentHash },
      latestSensorLog: { cid: latestLog.cid, contentHash: latestLog.contentHash },
      manufactureDate: BigInt(manufactureDate),
      minTempTenthsC: BigInt(MIN_TEMP),
      maxTempTenthsC: BigInt(MAX_TEMP),
      metadata: { cid: metadata.cid, contentHash: metadata.contentHash },
    });
  });

  it("5 Verify: the reader rebuilds the complete timeline from logs filtered by the batchId topic", async function () {
    // A small page size makes the reader split the block range into many
    // eth_getLogs queries, as it must on public RPCs.
    history = await readLogs(ethers.provider, reader, { fromBlock: context.deployBlock, batchId, pageSize: 3 });

    expect(history.map((entry) => entry.event.name)).to.deep.equal([
      "BatchRegistered",
      "TransferInitiated",
      "SensorLogAnchored",
      "CustodyTransferred",
      "SensorLogAnchored",
      "CertificateIssued",
      "StatusUpdated",
      "SensorLogAnchored",
      "StatusUpdated",
      "TransferInitiated",
      "CustodyTransferred",
      "SensorLogAnchored",
      "TransferInitiated",
      "CustodyTransferred",
      "CertificateIssued",
      "StatusUpdated",
    ]);
    // Event by event (names, actors, values) and transaction by transaction.
    expect(history.map((entry) => entry.event)).to.deep.equal(expectedTimeline.map((entry) => entry.event));
    expect(history.map((entry) => entry.transactionHash)).to.deep.equal(
      expectedTimeline.map((entry) => entry.transactionHash),
    );
    for (let i = 1; i < history.length; i++) {
      expect(history[i].blockNumber, "chain order").to.be.greaterThan(history[i - 1].blockNumber);
    }

    // Folding the events reproduces every event-derived field of the record.
    expect(replay(history).get(batchId).record).to.deep.equal(rebuildableView(await reader.verifyBatch(batchId)));
  });

  it("5 Verify: the custody chain derived from events is a series of signed pairs ending at the on-chain custodian", async function () {
    const { manufacturer, distributorA, distributorB, pharmacy } = actors;
    let holder = history[0].event.manufacturer;
    const chain = [holder];
    let openHandOff = null;

    for (const { event, transactionHash } of history) {
      const signer = (await ethers.provider.getTransaction(transactionHash)).from;
      if (event.name === "TransferInitiated") {
        // Step 1, signed by the current holder, names the next custodian.
        expect(event.from).to.equal(holder);
        expect(signer).to.equal(holder);
        openHandOff = event;
      } else if (event.name === "CustodyTransferred") {
        // Step 2, signed by exactly the account that step 1 named.
        expect(openHandOff, "an accept without an initiate").to.not.equal(null);
        expect([event.from, event.to]).to.deep.equal([openHandOff.from, openHandOff.to]);
        expect(signer).to.equal(event.to);
        holder = event.to;
        chain.push(holder);
        openHandOff = null;
      }
    }

    expect(chain).to.deep.equal([manufacturer, distributorA, distributorB, pharmacy].map((signer) => signer.address));
    expect(holder).to.equal((await reader.verifyBatch(batchId)).custodian);
  });

  it("5 Verify: every IPFS file checks against its on-chain hash, and a tampered copy does not", async function () {
    const record = await reader.verifyBatch(batchId);
    expect(documentMatches(ipfs, record.metadata), "metadata").to.equal(true);

    // Certificate history: every certificate ever issued, from the events.
    const issued = history
      .filter((entry) => entry.event.name === "CertificateIssued")
      .map(({ event }) => ({ cid: event.cid, contentHash: event.contentHash }));
    expect(issued).to.deep.equal(certificates);
    for (const certificate of issued) expect(documentMatches(ipfs, certificate), certificate.cid).to.equal(true);
    expect(record.certificate.cid).to.equal(issued.at(-1).cid);

    // Sensor logs: numbered 1..n without gaps, each one intact, the last one in the record.
    const anchored = history.filter((entry) => entry.event.name === "SensorLogAnchored").map((entry) => entry.event);
    expect(anchored.map((event) => event.logIndex)).to.deep.equal([1n, 2n, 3n, 4n]);
    for (const event of anchored) expect(documentMatches(ipfs, event), event.cid).to.equal(true);
    expect(record.latestSensorLog.cid).to.equal(anchored.at(-1).cid);
    expect(record.sensorLogCount).to.equal(BigInt(anchored.length));

    // A gateway that serves altered bytes is caught by the on-chain hash.
    ipfs.tamper(record.certificate.cid, '{"type":"regulator-certificate","statement":"forged"}');
    expect(documentMatches(ipfs, record.certificate)).to.equal(false);
  });
});
