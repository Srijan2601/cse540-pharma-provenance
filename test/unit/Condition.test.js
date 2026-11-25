// Unit tests: the IoT oracle functions (data flow 3, "Monitor"):
// anchorSensorLog and reportExcursion.
//
// The registry stores only a lot's latest sensor log and a counter, and keeps
// earlier logs in events (design decision C7). So the tests follow the
// counter and the logIndex of each event over several calls, check that
// routine logs and excursion logs share one numbering, and read the earlier
// logs back from the events.
//
// reportExcursion is tested at the edges of the lot's range (a reading equal
// to a bound is in range; one tenth beyond it is an excursion), with negative
// ranges and the int16 extremes, with observedAt at 0, at the block time and
// in the future, and while a hand-off is open: the excursion closes the
// hand-off, so the named recipient cannot take over a compromised lot.
//
// Both functions accept active lots only. Their checks have no normative
// order, so each negative test breaks exactly one rule. Callers without
// ORACLE_ROLE are covered by AccessControl.test.js.
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress, ZeroHash } from "ethers";
import {
  ACTIVE_STATUSES,
  EMPTY_DOCUMENT,
  INT16_MAX,
  INT16_MIN,
  LOT_STATES,
  Status,
  UINT64_MAX,
  createRegistryKit,
  expectOnlyEvent,
  expectRejected,
  makeDocument,
  readBatch,
} from "../helpers/registry.js";

const connection = await network.create();
const { networkHelpers } = connection;
const kit = createRegistryKit(connection);
const { loadFixture, deployRegistryFixture, lotFixture, latestTimestamp, registerLot } = kit;

const ACTIVE_STATES = LOT_STATES.filter((state) => ACTIVE_STATUSES.includes(state.status));
const INACTIVE_STATES = LOT_STATES.filter((state) => !ACTIVE_STATUSES.includes(state.status));

const INCOMPLETE_DOCUMENTS = [
  { title: "an empty CID", document: { ...makeDocument("sensor log"), cid: "" } },
  { title: "a zero content hash", document: { ...makeDocument("sensor log"), contentHash: ZeroHash } },
  { title: "both halves empty", document: EMPTY_DOCUMENT },
];

describe("Condition", function () {
  describe("anchorSensorLog", function () {
    describe("success", function () {
      for (const state of ACTIVE_STATES) {
        it(`anchors a log to a lot that is ${state.label}, without changing anything else`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(state.key));
          const log = makeDocument("sensor log 1");
          const before = await readBatch(registry, lot.id);

          const tx = registry.connect(accounts.oracle).anchorSensorLog(lot.id, log);
          await expect(tx).to.emit(registry, "SensorLogAnchored").withArgs(lot.id, 1, log.cid, log.contentHash);
          await expectOnlyEvent(tx, registry, "SensorLogAnchored");

          expect(await readBatch(registry, lot.id)).to.deep.equal({
            ...before,
            sensorLogCount: 1,
            latestSensorLog: log,
          });
        });
      }

      it("numbers successive logs 1, 2, 3, stores only the latest and keeps the others in events", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const logs = [1, 2, 3].map((n) => makeDocument(`sensor log ${n}`));

        for (const [index, log] of logs.entries()) {
          await expect(registry.connect(accounts.oracle).anchorSensorLog(lot.id, log))
            .to.emit(registry, "SensorLogAnchored")
            .withArgs(lot.id, index + 1, log.cid, log.contentHash);
        }

        const record = await readBatch(registry, lot.id);
        expect(record.sensorLogCount).to.equal(3);
        expect(record.latestSensorLog).to.deep.equal(logs[2]);

        const history = await registry.queryFilter(registry.filters.SensorLogAnchored(lot.id));
        expect(history.map((event) => [Number(event.args.logIndex), event.args.cid, event.args.contentHash])).to.deep.equal(
          logs.map((log, index) => [index + 1, log.cid, log.contentHash]),
        );
      });

      it("counts logs per lot", async function () {
        const { registry, accounts } = await loadFixture(deployRegistryFixture);
        const ctx = { registry, accounts };
        const first = await registerLot(ctx);
        const second = await registerLot(ctx);
        await kit.anchorLog(ctx, first.id);
        await kit.anchorLog(ctx, first.id);

        const log = makeDocument("first log of the second lot");
        await expect(registry.connect(accounts.oracle).anchorSensorLog(second.id, log))
          .to.emit(registry, "SensorLogAnchored")
          .withArgs(second.id, 1, log.cid, log.contentHash);
        expect((await readBatch(registry, first.id)).sensorLogCount).to.equal(2);
        expect((await readBatch(registry, second.id)).sensorLogCount).to.equal(1);
      });

      it("leaves an open hand-off open, so the named recipient can still accept", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { manufacturer, distributor } = accounts;
        await kit.anchorLog({ registry, accounts }, lot.id);

        expect((await readBatch(registry, lot.id)).pendingCustodian).to.equal(distributor.address);
        await expect(registry.connect(distributor).acceptTransfer(lot.id))
          .to.emit(registry, "CustodyTransferred")
          .withArgs(lot.id, manufacturer.address, distributor.address);
      });
    });

    describe("rules", function () {
      for (const state of INACTIVE_STATES) {
        it(`rejects a lot that is ${state.label} with InvalidStatus`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(state.key));
          await expectRejected(
            registry,
            lot.id,
            () => registry.connect(accounts.oracle).anchorSensorLog(lot.id, makeDocument("late log")),
            "InvalidStatus",
            [lot.id, state.status],
          );
        });
      }

      for (const { title, document } of INCOMPLETE_DOCUMENTS) {
        it(`rejects a log reference with ${title}: EmptyDocument`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
          await expectRejected(
            registry,
            lot.id,
            () => registry.connect(accounts.oracle).anchorSensorLog(lot.id, document),
            "EmptyDocument",
          );
        });
      }

      for (const batchId of [0n, 2n]) {
        it(`rejects lot ID ${batchId} with BatchNotFound`, async function () {
          const { registry, accounts } = await loadFixture(lotFixture("Created"));
          await expectRejected(
            registry,
            1n,
            () => registry.connect(accounts.oracle).anchorSensorLog(batchId, makeDocument("log")),
            "BatchNotFound",
            [batchId],
          );
        });
      }
    });
  });

  describe("reportExcursion", function () {
    /** Send an excursion report from the oracle; observedAt defaults to the latest block time. */
    async function report(registry, oracle, batchId, reading, { observedAt, log } = {}) {
      return registry
        .connect(oracle)
        .reportExcursion(
          batchId,
          reading,
          observedAt ?? (await latestTimestamp()),
          log ?? makeDocument(`excursion log, reading ${reading}`),
        );
    }

    describe("success", function () {
      it("flags a lot Compromised for a reading one tenth above the maximum and records its log", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const log = makeDocument("excursion log");
        const observedAt = await latestTimestamp();
        const before = await readBatch(registry, lot.id);

        const tx = registry.connect(accounts.oracle).reportExcursion(lot.id, 81, observedAt, log);
        await expect(tx)
          .to.emit(registry, "ExcursionReported")
          .withArgs(lot.id, 1, 81, observedAt, log.cid, log.contentHash);
        await expectOnlyEvent(tx, registry, "ExcursionReported");

        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          status: Status.Compromised,
          sensorLogCount: 1,
          latestSensorLog: log,
        });
      });

      it("flags a lot Compromised for a reading one tenth below the minimum", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const observedAt = await latestTimestamp();
        const log = makeDocument("cold excursion log");

        await expect(registry.connect(accounts.oracle).reportExcursion(lot.id, 19, observedAt, log))
          .to.emit(registry, "ExcursionReported")
          .withArgs(lot.id, 1, 19, observedAt, log.cid, log.contentHash);
        expect((await readBatch(registry, lot.id)).status).to.equal(Status.Compromised);
      });

      for (const state of ACTIVE_STATES) {
        it(`flags a lot that is ${state.label}, and keeps it with its custodian`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(state.key));
          const before = await readBatch(registry, lot.id);
          const log = makeDocument("excursion log");
          const observedAt = await latestTimestamp();

          await expect(registry.connect(accounts.oracle).reportExcursion(lot.id, 95, observedAt, log))
            .to.emit(registry, "ExcursionReported")
            .withArgs(lot.id, before.sensorLogCount + 1, 95, observedAt, log.cid, log.contentHash);
          expect(await readBatch(registry, lot.id)).to.deep.equal({
            ...before,
            status: Status.Compromised,
            pendingCustodian: ZeroAddress,
            sensorLogCount: before.sensorLogCount + 1,
            latestSensorLog: log,
          });
        });
      }

      it("accepts observedAt equal to the block timestamp", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const blockTime = (await latestTimestamp()) + 60n;
        await networkHelpers.time.setNextBlockTimestamp(blockTime);
        const log = makeDocument("excursion log");

        await expect(registry.connect(accounts.oracle).reportExcursion(lot.id, 81, blockTime, log))
          .to.emit(registry, "ExcursionReported")
          .withArgs(lot.id, 1, 81, blockTime, log.cid, log.contentHash);
      });

      it("accepts the earliest non-zero observedAt, 1 second after the Unix epoch", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const log = makeDocument("excursion log");
        await expect(registry.connect(accounts.oracle).reportExcursion(lot.id, 81, 1n, log))
          .to.emit(registry, "ExcursionReported")
          .withArgs(lot.id, 1, 81, 1n, log.cid, log.contentHash);
      });

      for (const reading of [-251, -149]) {
        it(`flags a frozen lot (-25.0 C to -15.0 C) for a reading of ${reading / 10} C`, async function () {
          const { registry, accounts } = await loadFixture(deployRegistryFixture);
          const { id } = await registerLot({ registry, accounts }, { min: -250, max: -150 });
          const observedAt = await latestTimestamp();
          const log = makeDocument("frozen excursion log");

          await expect(registry.connect(accounts.oracle).reportExcursion(id, reading, observedAt, log))
            .to.emit(registry, "ExcursionReported")
            .withArgs(id, 1, reading, observedAt, log.cid, log.contentHash);
          expect((await readBatch(registry, id)).status).to.equal(Status.Compromised);
        });
      }

      for (const reading of [INT16_MIN, INT16_MAX]) {
        it(`flags a lot for the extreme reading ${reading} when its range stops one short of it`, async function () {
          const { registry, accounts } = await loadFixture(deployRegistryFixture);
          const { id } = await registerLot({ registry, accounts }, { min: INT16_MIN + 1, max: INT16_MAX - 1 });
          const observedAt = await latestTimestamp();
          const log = makeDocument("extreme excursion log");

          await expect(registry.connect(accounts.oracle).reportExcursion(id, reading, observedAt, log))
            .to.emit(registry, "ExcursionReported")
            .withArgs(id, 1, reading, observedAt, log.cid, log.contentHash);
        });
      }

      it("continues the log numbering of anchorSensorLog: two routine logs, then excursion log 3", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const ctx = { registry, accounts };
        await kit.anchorLog(ctx, lot.id, makeDocument("routine log 1"));
        await kit.anchorLog(ctx, lot.id, makeDocument("routine log 2"));
        const log = makeDocument("excursion log");
        const observedAt = await latestTimestamp();

        await expect(registry.connect(accounts.oracle).reportExcursion(lot.id, 81, observedAt, log))
          .to.emit(registry, "ExcursionReported")
          .withArgs(lot.id, 3, 81, observedAt, log.cid, log.contentHash);

        const record = await readBatch(registry, lot.id);
        expect(record.sensorLogCount).to.equal(3);
        expect(record.latestSensorLog).to.deep.equal(log);
        // The excursion log is not also announced as a routine log.
        expect(await registry.queryFilter(registry.filters.SensorLogAnchored(lot.id))).to.have.length(2);
      });

      for (const { key, sender, recipient, route } of [
        { key: "InTransitFromFactory", sender: "manufacturer", recipient: "distributor", route: "manufacturer -> distributor" },
        { key: "InTransitToPharmacy", sender: "distributor", recipient: "retailer", route: "distributor -> pharmacy" },
      ]) {
        it(`closes an open ${route} hand-off: the recipient can no longer accept, the sender has nothing to cancel`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(key));
          await (await report(registry, accounts.oracle, lot.id, 81)).wait();

          const record = await readBatch(registry, lot.id);
          expect(record.pendingCustodian).to.equal(ZeroAddress);
          expect(record.custodian).to.equal(accounts[sender].address);
          await expectRejected(
            registry,
            lot.id,
            () => registry.connect(accounts[recipient]).acceptTransfer(lot.id),
            "NoPendingTransfer",
            [lot.id],
          );
          await expectRejected(
            registry,
            lot.id,
            () => registry.connect(accounts[sender]).cancelTransfer(lot.id),
            "NoPendingTransfer",
            [lot.id],
          );
        });
      }
    });

    describe("rules", function () {
      for (const { title, reading } of [
        { title: "equal to the minimum", reading: 20 },
        { title: "equal to the maximum", reading: 80 },
        { title: "in the middle of the range", reading: 50 },
      ]) {
        it(`rejects a reading ${title} with ReadingWithinRange(reading, min, max)`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
          await expectRejected(
            registry,
            lot.id,
            async () => report(registry, accounts.oracle, lot.id, reading),
            "ReadingWithinRange",
            [reading, 20, 80],
          );
        });
      }

      for (const reading of [-250, -150]) {
        it(`rejects a reading on the bound ${reading} of a negative range`, async function () {
          const { registry, accounts } = await loadFixture(deployRegistryFixture);
          const { id } = await registerLot({ registry, accounts }, { min: -250, max: -150 });
          await expectRejected(
            registry,
            id,
            async () => report(registry, accounts.oracle, id, reading),
            "ReadingWithinRange",
            [reading, -250, -150],
          );
        });
      }

      for (const reading of [INT16_MIN, INT16_MAX]) {
        it(`rejects even the reading ${reading} for a lot whose range spans all of int16`, async function () {
          const { registry, accounts } = await loadFixture(deployRegistryFixture);
          const { id } = await registerLot({ registry, accounts }, { min: INT16_MIN, max: INT16_MAX });
          await expectRejected(
            registry,
            id,
            async () => report(registry, accounts.oracle, id, reading),
            "ReadingWithinRange",
            [reading, INT16_MIN, INT16_MAX],
          );
        });
      }

      it("rejects observedAt 0 with InvalidTimestamp(0)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        await expectRejected(
          registry,
          lot.id,
          async () => report(registry, accounts.oracle, lot.id, 81, { observedAt: 0n }),
          "InvalidTimestamp",
          [0n],
        );
      });

      it("rejects an observedAt one second after the block timestamp", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const blockTime = (await latestTimestamp()) + 60n;
        await networkHelpers.time.setNextBlockTimestamp(blockTime);
        await expectRejected(
          registry,
          lot.id,
          async () => report(registry, accounts.oracle, lot.id, 81, { observedAt: blockTime + 1n }),
          "InvalidTimestamp",
          [blockTime + 1n],
        );
      });

      it("rejects the largest uint64 observedAt", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        await expectRejected(
          registry,
          lot.id,
          async () => report(registry, accounts.oracle, lot.id, 81, { observedAt: UINT64_MAX }),
          "InvalidTimestamp",
          [UINT64_MAX],
        );
      });

      for (const { title, document } of INCOMPLETE_DOCUMENTS) {
        it(`rejects a log reference with ${title}: EmptyDocument`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
          await expectRejected(
            registry,
            lot.id,
            async () => report(registry, accounts.oracle, lot.id, 81, { log: document }),
            "EmptyDocument",
          );
        });
      }

      for (const state of INACTIVE_STATES) {
        it(`rejects a lot that is ${state.label} with InvalidStatus`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(state.key));
          await expectRejected(
            registry,
            lot.id,
            async () => report(registry, accounts.oracle, lot.id, 81),
            "InvalidStatus",
            [lot.id, state.status],
          );
        });
      }

      for (const batchId of [0n, 2n]) {
        it(`rejects lot ID ${batchId} with BatchNotFound`, async function () {
          const { registry, accounts } = await loadFixture(lotFixture("Created"));
          await expectRejected(
            registry,
            1n,
            async () => report(registry, accounts.oracle, batchId, 81),
            "BatchNotFound",
            [batchId],
          );
        });
      }
    });
  });
});
