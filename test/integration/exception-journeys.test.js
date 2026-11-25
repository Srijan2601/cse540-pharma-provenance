// Integration tests: the journeys that leave the happy path.
//
//   excursion    a lot on its way to the pharmacy is reported out of range
//                (data flow 3): it becomes Compromised, its hand-off is gone,
//                and nobody can move it again; the regulator still certifies
//                (an investigation report) and then recalls it
//   recall       the regulator recalls an active lot in the middle of a
//                hand-off, and a lot already delivered (data flow 4, "recall
//                a lot at any stage", design decision C2)
//   cancel       a hand-off to the wrong distributor is cancelled and
//                re-issued to the right one (design decision C3)
//   offboarding  the regulator revokes a distributor that holds a lot; the
//                lot stays where it is, readable and recallable (C4)
//
// Each journey is one test on a fresh, fully onboarded registry, and ends by
// reading the lot's history from its batchId-filtered logs, as the verify
// page would.
import { expect } from "chai";
import { Contract, ZeroAddress } from "ethers";
import { artifacts, network } from "hardhat";

import {
  deployOnboardedRegistry,
  FakeIpfs,
  handOff,
  latestTimestamp,
  readLogs,
  registerLot,
  rejectionOf,
  sendWrite,
  Status,
} from "./support.js";

const { ethers, networkHelpers } = await network.create();

async function onboardedRegistry() {
  return deployOnboardedRegistry(ethers);
}

/** The names of a lot's events, in chain order, read from logs only. */
async function historyNames(context, batchId) {
  const entries = await readLogs(context.provider, context.registry, { fromBlock: context.deployBlock, batchId });
  return entries.map((entry) => entry.event.name);
}

/** A read-only registry instance, like the patient verify page's: address and ABI, no signer. */
async function walletlessReader(context) {
  const { abi } = await artifacts.readArtifact("ProvenanceRegistry");
  return new Contract(await context.registry.getAddress(), abi, context.provider);
}

describe("Integration: journeys off the happy path", function () {
  describe("excursion", function () {
    it("flags a lot in transit Compromised, clears its hand-off, freezes it, and still lets the regulator certify and recall it", async function () {
      const context = await networkHelpers.loadFixture(onboardedRegistry);
      const { registry, actors } = context;
      const { manufacturer, distributorA, pharmacy, oracle, regulator } = actors;
      const ipfs = new FakeIpfs();

      const { batchId } = await registerLot(context, ipfs, manufacturer, "LOT-EXCURSION");
      await handOff(registry, batchId, manufacturer, distributorA);
      await sendWrite(registry, registry.connect(distributorA).initiateTransfer(batchId, pharmacy.address));
      const routineLog = ipfs.addJson({ type: "sensor-log", sensorId: "TRUCK-A-P", readingsTenthsC: [52, 58, 71] });
      await sendWrite(registry, registry.connect(oracle).anchorSensorLog(batchId, routineLog));

      // The truck's cooling fails: 9.3 C against a 2.0-8.0 C range.
      const excursionLog = ipfs.addJson({ type: "sensor-log", sensorId: "TRUCK-A-P", readingsTenthsC: [79, 88, 93] });
      const observedAt = (await latestTimestamp(context.provider)) - 60;
      const { event } = await sendWrite(
        registry,
        registry.connect(oracle).reportExcursion(batchId, 93, observedAt, excursionLog),
      );
      expect(event).to.deep.equal({
        name: "ExcursionReported",
        batchId,
        logIndex: 2n, // numbered in the same sequence as the routine logs
        readingTenthsC: 93n,
        observedAt: BigInt(observedAt),
        logCid: excursionLog.cid,
        logContentHash: excursionLog.contentHash,
      });

      let record = await registry.verifyBatch(batchId);
      expect(record.status).to.equal(Status.Compromised);
      expect(record.pendingCustodian, "the open hand-off is gone").to.equal(ZeroAddress);
      expect(record.custodian, "the lot stays with the distributor that held it").to.equal(distributorA.address);
      expect(record.sensorLogCount).to.equal(2n);
      expect(record.latestSensorLog.cid).to.equal(excursionLog.cid);

      // Nobody can accept, deliver or move it any more.
      await expect(registry.connect(pharmacy).acceptTransfer(batchId))
        .to.be.revertedWithCustomError(registry, "NoPendingTransfer")
        .withArgs(batchId);
      // The pharmacy breaks two rules here (it does not hold the lot, and the
      // lot is Compromised). markDelivered's check order is not part of the
      // API, so either error is correct.
      const delivery = await rejectionOf(registry, registry.connect(pharmacy).markDelivered(batchId));
      expect([
        { name: "NotCustodian", args: [batchId, pharmacy.address] },
        { name: "InvalidStatus", args: [batchId, Status.Compromised] },
      ]).to.deep.include(delivery);
      await expect(registry.connect(distributorA).cancelTransfer(batchId))
        .to.be.revertedWithCustomError(registry, "NoPendingTransfer")
        .withArgs(batchId);
      await expect(registry.connect(distributorA).initiateTransfer(batchId, pharmacy.address))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Compromised);
      await expect(registry.connect(distributorA).updateStatus(batchId, Status.Stored))
        .to.be.revertedWithCustomError(registry, "InvalidStatusTransition")
        .withArgs(batchId, Status.Compromised, Status.Stored);
      // The oracle's record of the journey is closed too.
      await expect(registry.connect(oracle).anchorSensorLog(batchId, routineLog))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Compromised);
      await expect(registry.connect(oracle).reportExcursion(batchId, 95, observedAt, excursionLog))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Compromised);

      // The regulator can still attach a document; the status does not change.
      const investigation = ipfs.addJson({ type: "regulator-certificate", statement: "Excursion investigated: destroy" });
      await sendWrite(registry, registry.connect(regulator).issueCertificate(batchId, investigation));
      record = await registry.verifyBatch(batchId);
      expect(record.status).to.equal(Status.Compromised);
      expect(record.certificate.cid).to.equal(investigation.cid);

      // ... and recalls it, which is final.
      const reason = "Temperature excursion during shipment";
      const recall = await sendWrite(registry, registry.connect(regulator).recallBatch(batchId, reason));
      expect(recall.event).to.deep.equal({ name: "BatchRecalled", batchId, regulator: regulator.address, reason });
      record = await registry.verifyBatch(batchId);
      expect(record.status).to.equal(Status.Recalled);
      expect(record.custodian).to.equal(distributorA.address);
      await expect(registry.connect(regulator).issueCertificate(batchId, investigation))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Recalled);
      await expect(registry.connect(regulator).recallBatch(batchId, reason))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Recalled);

      // The history shows the open hand-off that was never completed.
      expect(await historyNames(context, batchId)).to.deep.equal([
        "BatchRegistered",
        "TransferInitiated",
        "CustodyTransferred",
        "TransferInitiated",
        "SensorLogAnchored",
        "ExcursionReported",
        "CertificateIssued",
        "BatchRecalled",
      ]);
    });
  });

  describe("recall", function () {
    it("recalls an active lot in the middle of a hand-off: the hand-off is cleared and the lot stays with its custodian", async function () {
      const context = await networkHelpers.loadFixture(onboardedRegistry);
      const { registry, actors } = context;
      const { manufacturer, distributorA, distributorB, oracle, regulator } = actors;
      const ipfs = new FakeIpfs();

      const { batchId } = await registerLot(context, ipfs, manufacturer, "LOT-RECALL-ACTIVE");
      await handOff(registry, batchId, manufacturer, distributorA);
      await sendWrite(registry, registry.connect(distributorA).initiateTransfer(batchId, distributorB.address));

      const reason = "Manufacturer reported a contaminated batch of vials";
      const { event } = await sendWrite(registry, registry.connect(regulator).recallBatch(batchId, reason));
      expect(event).to.deep.equal({ name: "BatchRecalled", batchId, regulator: regulator.address, reason });

      const record = await registry.verifyBatch(batchId);
      expect(record.status).to.equal(Status.Recalled);
      expect(record.pendingCustodian).to.equal(ZeroAddress);
      expect(record.custodian).to.equal(distributorA.address);

      // The named recipient can no longer take it, and the holder can neither
      // cancel, re-ship nor re-status it.
      await expect(registry.connect(distributorB).acceptTransfer(batchId))
        .to.be.revertedWithCustomError(registry, "NoPendingTransfer")
        .withArgs(batchId);
      await expect(registry.connect(distributorA).cancelTransfer(batchId))
        .to.be.revertedWithCustomError(registry, "NoPendingTransfer")
        .withArgs(batchId);
      await expect(registry.connect(distributorA).initiateTransfer(batchId, distributorB.address))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Recalled);
      await expect(registry.connect(distributorA).updateStatus(batchId, Status.Stored))
        .to.be.revertedWithCustomError(registry, "InvalidStatusTransition")
        .withArgs(batchId, Status.Recalled, Status.Stored);
      await expect(registry.connect(oracle).anchorSensorLog(batchId, ipfs.addJson({ type: "sensor-log" })))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Recalled);

      expect(await historyNames(context, batchId)).to.deep.equal([
        "BatchRegistered",
        "TransferInitiated",
        "CustodyTransferred",
        "TransferInitiated",
        "BatchRecalled",
      ]);
    });

    it("recalls a lot that the pharmacy already delivered, and a reader with no wallet sees why", async function () {
      const context = await networkHelpers.loadFixture(onboardedRegistry);
      const { registry, actors } = context;
      const { manufacturer, distributorA, pharmacy, regulator } = actors;
      const ipfs = new FakeIpfs();

      const { batchId } = await registerLot(context, ipfs, manufacturer, "LOT-RECALL-DELIVERED");
      await handOff(registry, batchId, manufacturer, distributorA);
      await handOff(registry, batchId, distributorA, pharmacy);
      await sendWrite(registry, registry.connect(pharmacy).markDelivered(batchId));
      expect((await registry.verifyBatch(batchId)).status).to.equal(Status.Delivered);

      const reason = "Mislabelled strength on the outer carton";
      await sendWrite(registry, registry.connect(regulator).recallBatch(batchId, reason));
      await expect(registry.connect(pharmacy).markDelivered(batchId))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(batchId, Status.Recalled);

      // The patient's view: the record says Recalled and still names the
      // pharmacy; the history says what happened and why.
      const reader = await walletlessReader(context);
      const record = await reader.verifyBatch(batchId);
      expect(record.status).to.equal(Status.Recalled);
      expect(record.custodian).to.equal(pharmacy.address);

      const history = await readLogs(context.provider, reader, { fromBlock: context.deployBlock, batchId });
      const [delivered, recalled] = history.slice(-2).map((entry) => entry.event);
      expect(delivered).to.deep.equal({
        name: "StatusUpdated",
        batchId,
        previousStatus: Status.Stored,
        newStatus: Status.Delivered,
        by: pharmacy.address,
      });
      expect(recalled).to.deep.equal({ name: "BatchRecalled", batchId, regulator: regulator.address, reason });
    });
  });

  describe("cancel", function () {
    it("cancels a hand-off to the wrong distributor and re-issues it to the right one; the history shows both", async function () {
      const context = await networkHelpers.loadFixture(onboardedRegistry);
      const { registry, actors } = context;
      const { manufacturer, distributorA, distributorB, pharmacy } = actors;
      const ipfs = new FakeIpfs();
      const { batchId } = await registerLot(context, ipfs, manufacturer, "LOT-CANCEL");

      // The manufacturer meant distributor A but named B.
      await sendWrite(registry, registry.connect(manufacturer).initiateTransfer(batchId, distributorB.address));
      await expect(registry.connect(distributorA).acceptTransfer(batchId))
        .to.be.revertedWithCustomError(registry, "NotPendingCustodian")
        .withArgs(batchId, distributorA.address);

      await sendWrite(registry, registry.connect(manufacturer).cancelTransfer(batchId));
      let record = await registry.verifyBatch(batchId);
      expect(record.status, "back to the status before the hand-off").to.equal(Status.Created);
      expect(record.pendingCustodian).to.equal(ZeroAddress);
      expect(record.custodian).to.equal(manufacturer.address);
      await expect(registry.connect(distributorB).acceptTransfer(batchId))
        .to.be.revertedWithCustomError(registry, "NoPendingTransfer")
        .withArgs(batchId);

      await handOff(registry, batchId, manufacturer, distributorA);

      // The same mistake one stage later: A meant the pharmacy but named B.
      // This time cancelling restores Stored, not Created.
      await sendWrite(registry, registry.connect(distributorA).initiateTransfer(batchId, distributorB.address));
      await sendWrite(registry, registry.connect(distributorA).cancelTransfer(batchId));
      record = await registry.verifyBatch(batchId);
      expect(record.status).to.equal(Status.Stored);
      expect(record.custodian).to.equal(distributorA.address);

      await handOff(registry, batchId, distributorA, pharmacy);

      const history = await readLogs(context.provider, context.registry, { fromBlock: context.deployBlock, batchId });
      const custodyEvents = history
        .map((entry) => entry.event)
        .filter((event) => event.name !== "BatchRegistered")
        .map(({ name, from, to }) => [name, from, to]);
      const [m, a, b, p] = [manufacturer, distributorA, distributorB, pharmacy].map((signer) => signer.address);
      expect(custodyEvents).to.deep.equal([
        ["TransferInitiated", m, b],
        ["TransferCancelled", m, b],
        ["TransferInitiated", m, a],
        ["CustodyTransferred", m, a],
        ["TransferInitiated", a, b],
        ["TransferCancelled", a, b],
        ["TransferInitiated", a, p],
        ["CustodyTransferred", a, p],
      ]);
    });
  });

  describe("offboarding", function () {
    it("stops a revoked distributor from acting, while its lot stays readable, monitored and recallable", async function () {
      const context = await networkHelpers.loadFixture(onboardedRegistry);
      const { registry, roles, actors } = context;
      const { manufacturer, distributorA, distributorB, pharmacy, oracle, regulator } = actors;
      const ipfs = new FakeIpfs();

      // Lot 1 is stored at distributor A; lot 2 is on its way to A.
      const { batchId: held } = await registerLot(context, ipfs, manufacturer, "LOT-OFFBOARD-HELD");
      await handOff(registry, held, manufacturer, distributorA);
      const { batchId: incoming } = await registerLot(context, ipfs, manufacturer, "LOT-OFFBOARD-INCOMING");
      await sendWrite(registry, registry.connect(manufacturer).initiateTransfer(incoming, distributorA.address));

      await expect(registry.connect(regulator).revokeRole(roles.DISTRIBUTOR, distributorA.address))
        .to.emit(registry, "RoleRevoked")
        .withArgs(roles.DISTRIBUTOR, distributorA.address, regulator.address);

      // A can no longer act, on the lot it holds or on the one coming to it.
      await expect(registry.connect(distributorA).initiateTransfer(held, pharmacy.address))
        .to.be.revertedWithCustomError(registry, "MissingEitherRole")
        .withArgs(distributorA.address, roles.MANUFACTURER, roles.DISTRIBUTOR);
      await expect(registry.connect(distributorA).updateStatus(held, Status.InTransit))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(distributorA.address, roles.DISTRIBUTOR);
      await expect(registry.connect(distributorA).cancelTransfer(held))
        .to.be.revertedWithCustomError(registry, "MissingEitherRole")
        .withArgs(distributorA.address, roles.MANUFACTURER, roles.DISTRIBUTOR);
      await expect(registry.connect(distributorA).acceptTransfer(incoming))
        .to.be.revertedWithCustomError(registry, "MissingEitherRole")
        .withArgs(distributorA.address, roles.DISTRIBUTOR, roles.RETAILER);

      // The manufacturer takes back the hand-off it opened to A. A is no
      // longer an allowed recipient, so the lot goes to B instead.
      await sendWrite(registry, registry.connect(manufacturer).cancelTransfer(incoming));
      await expect(registry.connect(manufacturer).initiateTransfer(incoming, distributorA.address))
        .to.be.revertedWithCustomError(registry, "InvalidRecipient")
        .withArgs(distributorA.address);
      await handOff(registry, incoming, manufacturer, distributorB);

      // Lot 1 stays where it is (C4): readable by anyone, still with A, and
      // no other distributor can take it.
      const reader = await walletlessReader(context);
      const record = await reader.verifyBatch(held);
      expect(record.custodian).to.equal(distributorA.address);
      expect(record.status).to.equal(Status.Stored);
      expect(record.pendingCustodian).to.equal(ZeroAddress);
      await expect(registry.connect(distributorB).initiateTransfer(held, pharmacy.address))
        .to.be.revertedWithCustomError(registry, "NotCustodian")
        .withArgs(held, distributorB.address);

      // The oracle still monitors it, and the regulator can still recall it.
      await sendWrite(registry, registry.connect(oracle).anchorSensorLog(held, ipfs.addJson({ type: "sensor-log" })));
      await sendWrite(registry, registry.connect(regulator).recallBatch(held, "Holder offboarded; stock quarantined"));
      expect((await reader.verifyBatch(held)).status).to.equal(Status.Recalled);
      expect((await reader.verifyBatch(incoming)).custodian).to.equal(distributorB.address);
    });
  });
});
