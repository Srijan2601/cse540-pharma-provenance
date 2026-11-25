// Integration tests: the event log as the lot's history.
//
// The verify page shows a lot's custody and temperature history without any
// storage that grows per event: it reads the lot's events (design decisions
// C6, C7 and O6). These tests check the two properties that this relies on.
//
//   isolation  with several lots interleaved, each lot's batchId-filtered
//              history holds exactly its own events, together the histories
//              cover every registry event once, and no write ever changes
//              another lot's record
//   replay     after a long mixed scenario (a scripted part that produces
//              every event kind and edge case, then a seeded pseudo-random
//              tail of calls that may revert), folding the events through a
//              pure reducer rebuilds every event-derived field of every lot
//              exactly as verifyBatch returns it
import { expect } from "chai";
import { Contract, ZeroAddress } from "ethers";
import { artifacts, network } from "hardhat";

import { seededRandom } from "../helpers/common.js";
import {
  deployOnboardedRegistry,
  FakeIpfs,
  fullView,
  handOff,
  latestTimestamp,
  readLogs,
  rebuildableView,
  REGISTRY_EVENTS,
  registerLot,
  replay,
  revertErrorName,
  sendWrite,
  Status,
} from "./support.js";

const { ethers, networkHelpers } = await network.create();

/** Onboarded registry plus a second manufacturer, so that lots come from rival firms. */
async function registryWithTwoManufacturers() {
  const context = await deployOnboardedRegistry(ethers);
  const { registry, roles, actors } = context;
  await (await registry.connect(actors.regulator).grantRole(roles.MANUFACTURER, actors.manufacturerB.address)).wait();
  return context;
}

describe("Integration: the event log is each lot's complete history", function () {
  it("keeps interleaved lots apart: each history holds only its lot's events, and no write changes another lot", async function () {
    const context = await networkHelpers.loadFixture(registryWithTwoManufacturers);
    const { registry, actors, provider, deployBlock } = context;
    const { manufacturer, manufacturerB, distributorA, distributorB, pharmacy, oracle, regulator } = actors;
    const ipfs = new FakeIpfs();

    const lots = [
      (await registerLot(context, ipfs, manufacturer, "LOT-ISO-1")).batchId,
      (await registerLot(context, ipfs, manufacturerB, "LOT-ISO-2")).batchId,
      (await registerLot(context, ipfs, manufacturer, "LOT-ISO-3")).batchId,
    ];
    const [one, two, three] = lots;
    const writesPerLot = new Map(lots.map((batchId) => [batchId, 1])); // the registration

    async function snapshot() {
      return new Map(await Promise.all(lots.map(async (batchId) => [batchId, fullView(await registry.verifyBatch(batchId))])));
    }
    const observedAt = (await latestTimestamp(provider)) - 30;
    const log = (label) => ipfs.addJson({ type: "sensor-log", label });

    // [target lot, write]: the three journeys interleaved block by block.
    const steps = [
      [one, () => registry.connect(manufacturer).initiateTransfer(one, distributorA.address)],
      [two, () => registry.connect(manufacturerB).initiateTransfer(two, distributorB.address)],
      [three, () => registry.connect(oracle).anchorSensorLog(three, log("factory-3"))],
      [one, () => registry.connect(distributorA).acceptTransfer(one)],
      // One hand-off per lot, not per organization: A can hold lot 1 and be
      // the named recipient of lot 3 at the same time.
      [three, () => registry.connect(manufacturer).initiateTransfer(three, distributorA.address)],
      [two, () => registry.connect(oracle).anchorSensorLog(two, log("truck-2"))],
      [two, () => registry.connect(distributorB).acceptTransfer(two)],
      [one, () => registry.connect(regulator).issueCertificate(one, ipfs.addJson({ certificate: 1 }))],
      [three, () => registry.connect(distributorA).acceptTransfer(three)],
      [one, () => registry.connect(distributorA).initiateTransfer(one, pharmacy.address)],
      [two, () => registry.connect(oracle).reportExcursion(two, 95, observedAt, log("excursion-2"))],
      [three, () => registry.connect(distributorA).updateStatus(three, Status.InTransit)],
      [one, () => registry.connect(pharmacy).acceptTransfer(one)],
      [three, () => registry.connect(regulator).recallBatch(three, "Isolation test recall")],
      [one, () => registry.connect(pharmacy).markDelivered(one)],
    ];

    for (const [target, send] of steps) {
      const before = await snapshot();
      const { event } = await sendWrite(registry, send());
      expect(event.batchId, `${event.name} names the lot it acted on`).to.equal(target);
      const after = await snapshot();
      for (const batchId of lots) {
        if (batchId === target) {
          expect(after.get(batchId), `${event.name} changed lot ${batchId}`).to.not.deep.equal(before.get(batchId));
        } else {
          expect(after.get(batchId), `${event.name} on lot ${target} left lot ${batchId} alone`).to.deep.equal(
            before.get(batchId),
          );
        }
      }
      writesPerLot.set(target, writesPerLot.get(target) + 1);
    }

    // A rival's lot is out of reach: B holds lot 2, so A cannot act on it.
    await expect(registry.connect(distributorA).initiateTransfer(two, pharmacy.address))
      .to.be.revertedWithCustomError(registry, "NotCustodian")
      .withArgs(two, distributorA.address);

    const final = await snapshot();
    expect([one, two, three].map((batchId) => final.get(batchId).status)).to.deep.equal([
      Status.Delivered,
      Status.Compromised,
      Status.Recalled,
    ]);

    // Each lot's history is exactly its own writes, and the histories
    // partition the registry's events: none is missing, none appears twice.
    const allRegistryEvents = (await readLogs(provider, registry, { fromBlock: deployBlock })).filter((entry) =>
      REGISTRY_EVENTS.includes(entry.event.name),
    );
    const covered = [];
    for (const batchId of lots) {
      const history = await readLogs(provider, registry, { fromBlock: deployBlock, batchId });
      expect(history, `lot ${batchId}`).to.have.length(writesPerLot.get(batchId));
      for (const entry of history) {
        expect(entry.event.batchId, `an event in lot ${batchId}'s history`).to.equal(batchId);
        covered.push(`${entry.transactionHash}#${entry.logIndex}`);
      }
    }
    expect(covered.sort()).to.deep.equal(
      allRegistryEvents.map((entry) => `${entry.transactionHash}#${entry.logIndex}`).sort(),
    );
  });

  it("rebuilds every lot's record from its events alone after a long mixed scenario", async function () {
    const context = await networkHelpers.loadFixture(registryWithTwoManufacturers);
    const { registry, actors, provider, deployBlock } = context;
    const { manufacturer, manufacturerB, distributorA, distributorB, pharmacy, oracle, regulator, outsider } = actors;
    const ipfs = new FakeIpfs();
    const write = (txPromise) => sendWrite(registry, txPromise);
    let documents = 0;
    const doc = (type) => ipfs.addJson({ type, serial: ++documents });
    const recentTime = async () => (await latestTimestamp(provider)) - 10;

    // ---- Scripted part: every event kind and the edge cases of the reducer.

    // Lot A: the happy path to Delivered, then a recall of the delivered lot.
    const { batchId: lotA } = await registerLot(context, ipfs, manufacturer, "LOT-REPLAY-A");
    await write(registry.connect(manufacturer).initiateTransfer(lotA, distributorA.address));
    await write(registry.connect(oracle).anchorSensorLog(lotA, doc("sensor-log")));
    await write(registry.connect(distributorA).acceptTransfer(lotA));
    await write(registry.connect(regulator).issueCertificate(lotA, doc("certificate")));
    await write(registry.connect(distributorA).updateStatus(lotA, Status.InTransit));
    await write(registry.connect(distributorA).updateStatus(lotA, Status.Stored));
    await handOff(registry, lotA, distributorA, pharmacy);
    await write(registry.connect(pharmacy).markDelivered(lotA));
    await write(registry.connect(regulator).recallBatch(lotA, "Recall after delivery"));

    // Lot B (the rival manufacturer): cancels that restore Created and then
    // Stored, an excursion while Stored, a certificate on the Compromised
    // lot, then a recall of the Compromised lot.
    const { batchId: lotB } = await registerLot(context, ipfs, manufacturerB, "LOT-REPLAY-B");
    await write(registry.connect(manufacturerB).initiateTransfer(lotB, distributorB.address));
    await write(registry.connect(manufacturerB).cancelTransfer(lotB));
    await handOff(registry, lotB, manufacturerB, distributorA);
    await write(registry.connect(distributorA).initiateTransfer(lotB, distributorB.address));
    await write(registry.connect(distributorA).cancelTransfer(lotB));
    await write(registry.connect(oracle).reportExcursion(lotB, -5, await recentTime(), doc("sensor-log")));
    await write(registry.connect(regulator).issueCertificate(lotB, doc("certificate")));
    await write(registry.connect(regulator).recallBatch(lotB, "Recall after excursion"));

    // Lot C: an excursion in the middle of a hand-off clears it.
    const { batchId: lotC } = await registerLot(context, ipfs, manufacturer, "LOT-REPLAY-C");
    await write(registry.connect(manufacturer).initiateTransfer(lotC, distributorB.address));
    await write(registry.connect(oracle).anchorSensorLog(lotC, doc("sensor-log")));
    await write(registry.connect(oracle).reportExcursion(lotC, 120, await recentTime(), doc("sensor-log")));

    // Lot D: a recall in the middle of a hand-off clears it.
    const { batchId: lotD } = await registerLot(context, ipfs, manufacturerB, "LOT-REPLAY-D");
    await handOff(registry, lotD, manufacturerB, distributorA);
    await write(registry.connect(distributorA).initiateTransfer(lotD, distributorB.address));
    await write(registry.connect(regulator).recallBatch(lotD, "Recall in transit"));

    // Lot E: still at the factory, with two logs and a replaced certificate.
    const { batchId: lotE } = await registerLot(context, ipfs, manufacturer, "LOT-REPLAY-E");
    await write(registry.connect(oracle).anchorSensorLog(lotE, doc("sensor-log")));
    await write(registry.connect(oracle).anchorSensorLog(lotE, doc("sensor-log")));
    await write(registry.connect(regulator).issueCertificate(lotE, doc("certificate")));
    await write(registry.connect(regulator).issueCertificate(lotE, doc("certificate")));

    // ---- Pseudo-random tail: 150 attempts, fixed seed (the same seed always
    // gives the same scenario), reverts allowed.
    // Each attempt picks a lot (usually one that is still active), then
    // usually an action that lot's status allows, a recipient on the allowed
    // route and the actor the action belongs to (custodian, named recipient,
    // oracle, regulator). The rest of the time any action, recipient or
    // actor is used; this is also where the rarer excursions and recalls
    // come from. The chain is read only to steer these choices; the check at
    // the end uses the events alone.
    const random = seededRandom(540);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const usually = (natural, anything) => (natural !== undefined && random() < 0.8 ? natural : anything());
    const everyone = [manufacturer, manufacturerB, distributorA, distributorB, pharmacy, oracle, regulator, outsider];
    const signerOf = new Map(everyone.map((signer) => [signer.address, signer]));
    const anyone = () => pick(everyone);
    const ACTIONS = ["initiate", "accept", "cancel", "updateStatus", "markDelivered", "certify", "anchor", "excursion", "recall"];

    async function pickLot() {
      const ids = Array.from({ length: Number(await registry.totalBatches()) }, (_, index) => BigInt(index + 1));
      const records = await Promise.all(ids.map((batchId) => registry.verifyBatch(batchId)));
      // Active = Created, InTransit or Stored, the first three enum values.
      const active = ids.filter((_, index) => records[index].status <= Status.Stored);
      return active.length > 0 && random() < 0.8 ? pick(active) : pick(ids);
    }

    /** The writes that the state machine on IProvenanceRegistry.Status allows next. */
    function plausibleActions(record) {
      if (record.pendingCustodian !== ZeroAddress) return ["accept", "accept", "cancel", "anchor"];
      if (record.status === Status.Created) return ["initiate", "initiate", "anchor", "certify"];
      if (record.status === Status.InTransit) return ["updateStatus", "anchor"];
      if (record.status === Status.Stored && record.custodian === pharmacy.address) return ["markDelivered", "anchor"];
      if (record.status === Status.Stored) return ["initiate", "initiate", "updateStatus", "anchor", "certify"];
      return ["certify"];
    }

    /** Design decision C3: a distributor ships to another distributor or the pharmacy, anyone else to a distributor. */
    function allowedRecipients(sender) {
      const distributors = [distributorA, distributorB];
      const candidates = distributors.includes(sender) ? [...distributors, pharmacy] : distributors;
      return candidates.filter((candidate) => candidate !== sender);
    }

    let registeredInTail = 0;
    let succeeded = 0;
    const rejectedWith = new Set();

    for (let attempt = 0; attempt < 150; attempt++) {
      const batchId = await pickLot();
      const record = await registry.verifyBatch(batchId);
      const custodian = signerOf.get(record.custodian);
      let action;
      if (random() < 0.06) action = "register";
      else if (random() < 0.85) action = pick(plausibleActions(record));
      else action = pick(ACTIONS);
      const recipient = usually(pick(allowedRecipients(custodian)), anyone).address;
      const send = {
        register: () =>
          registry
            .connect(usually(pick([manufacturer, manufacturerB]), anyone))
            .registerBatch(
              ethers.id(`LOT-REPLAY-TAIL-${registeredInTail}`),
              record.registeredAt,
              -250,
              -150,
              doc("lot-metadata"),
            ),
        initiate: () => registry.connect(usually(custodian, anyone)).initiateTransfer(batchId, recipient),
        accept: () => registry.connect(usually(signerOf.get(record.pendingCustodian), anyone)).acceptTransfer(batchId),
        cancel: () => registry.connect(usually(custodian, anyone)).cancelTransfer(batchId),
        updateStatus: () =>
          registry
            .connect(usually(custodian, anyone))
            .updateStatus(batchId, record.status === Status.Stored ? Status.InTransit : Status.Stored),
        markDelivered: () => registry.connect(usually(custodian, anyone)).markDelivered(batchId),
        certify: () => registry.connect(usually(regulator, anyone)).issueCertificate(batchId, doc("certificate")),
        anchor: () => registry.connect(usually(oracle, anyone)).anchorSensorLog(batchId, doc("sensor-log")),
        excursion: async () =>
          registry
            .connect(usually(oracle, anyone))
            .reportExcursion(batchId, record.maxTempTenthsC + 1n, await recentTime(), doc("sensor-log")),
        recall: () => registry.connect(usually(regulator, anyone)).recallBatch(batchId, "Recall from the random tail"),
      }[action];

      try {
        await write(send());
        succeeded++;
        if (action === "register") registeredInTail++;
      } catch (error) {
        // A rejected call must be a registry revert with a known custom
        // error; anything else (a broken test) is rethrown here.
        rejectedWith.add(revertErrorName(registry, error));
      }
    }
    expect(succeeded, "the random tail made progress").to.be.greaterThan(0);
    expect(rejectedWith.size, "the random tail also hit rejections").to.be.greaterThan(0);

    // ---- Replay: what a verify page with no wallet can rebuild.
    const { abi } = await artifacts.readArtifact("ProvenanceRegistry");
    const reader = new Contract(await registry.getAddress(), abi, provider);
    const entries = await readLogs(provider, reader, { fromBlock: deployBlock, pageSize: 16 });
    const registryEntries = entries.filter((entry) => REGISTRY_EVENTS.includes(entry.event.name));
    // Everything else comes from AccessControl: the constructor's role set-up and the onboarding.
    const otherNames = new Set(
      entries.filter((entry) => !REGISTRY_EVENTS.includes(entry.event.name)).map((entry) => entry.event.name),
    );
    expect([...otherNames].sort()).to.deep.equal(["RoleAdminChanged", "RoleGranted"]);
    expect(new Set(registryEntries.map((entry) => entry.event.name)), "every event kind occurs").to.deep.equal(
      new Set(REGISTRY_EVENTS),
    );

    const rebuilt = replay(registryEntries);
    const total = await reader.totalBatches();
    expect(BigInt(rebuilt.size)).to.equal(total);
    for (let batchId = 1n; batchId <= total; batchId++) {
      expect(rebuilt.get(batchId).record, `lot ${batchId}`).to.deep.equal(
        rebuildableView(await reader.verifyBatch(batchId)),
      );
    }
  });
});
