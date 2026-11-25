// Unit tests: registerBatch (data flow 1, "Register") and the read-only views
// over registered lots.
//
// registerBatch is where every lot record starts, so the success tests compare
// the whole stored record with what the call supplied, and the ID tests pin
// the numbering scheme (1, 2, 3, ... across all manufacturers, design decision
// C5). Each validation test breaks exactly one rule of the function (zero
// product hash, a manufactureDate that is 0 or in the future, an empty or
// inverted temperature range, an incomplete metadata reference, a duplicate
// product hash) and checks that nothing was stored. The registerBatch rules
// have no normative order, so no test depends on one. Who may call
// registerBatch is covered by AccessControl.test.js.
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress, ZeroHash } from "ethers";
import {
  EMPTY_DOCUMENT,
  INT16_MAX,
  INT16_MIN,
  Status,
  UINT64_MAX,
  createRegistryKit,
  expectOnlyEvent,
  makeDocument,
  makeProductHash,
  readBatch,
} from "../helpers/registry.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const kit = createRegistryKit(connection);
const { loadFixture, deployRegistryFixture, latestTimestamp, blockTimestampOf, registerLot } = kit;

/** The record registerBatch must store: the arguments, plus the defaults of a new lot. */
function newLotRecord({ id, productHash, manufacturer, manufactureDate, registeredAt, min, max, metadata }) {
  return {
    id,
    productHash,
    manufacturer,
    manufactureDate,
    registeredAt,
    custodian: manufacturer, // the manufacturer is the first custodian
    pendingCustodian: ZeroAddress,
    status: Status.Created,
    minTempTenthsC: min,
    maxTempTenthsC: max,
    sensorLogCount: 0,
    metadata,
    certificate: EMPTY_DOCUMENT,
    latestSensorLog: EMPTY_DOCUMENT,
  };
}

/** Valid registerBatch arguments; a test overrides the one it wants to break. */
async function validArgs(overrides = {}) {
  return {
    productHash: makeProductHash("NDC-1234-5678-90", "LOT-2026-001"),
    manufactureDate: (await latestTimestamp()) - 3600n,
    min: 20,
    max: 80,
    metadata: makeDocument("lot metadata LOT-2026-001"),
    ...overrides,
  };
}

function register(registry, signer, { productHash, manufactureDate, min, max, metadata }) {
  return registry.connect(signer).registerBatch(productHash, manufactureDate, min, max, metadata);
}

describe("Registration", function () {
  describe("registerBatch: success", function () {
    it("registers the first lot as ID 1, stores the full record and emits BatchRegistered", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { manufacturer } = accounts;
      const args = await validArgs();

      const tx = register(registry, manufacturer, args);
      await expect(tx)
        .to.emit(registry, "BatchRegistered")
        .withArgs(1n, manufacturer.address, args.productHash, args.metadata.cid);
      await expectOnlyEvent(tx, registry, "BatchRegistered");

      expect(await readBatch(registry, 1n)).to.deep.equal(
        newLotRecord({
          ...args,
          id: 1n,
          manufacturer: manufacturer.address,
          registeredAt: await blockTimestampOf(tx),
        }),
      );
      expect(await registry.totalBatches()).to.equal(1n);
      expect(await registry.batchIdOf(args.productHash)).to.equal(1n);
    });

    it("returns the new lot's ID to the caller", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { manufacturer } = accounts;
      const first = await validArgs();
      const second = await validArgs({ productHash: makeProductHash("NDC-1234-5678-90", "LOT-2026-002") });

      expect(
        await registry
          .connect(manufacturer)
          .registerBatch.staticCall(first.productHash, first.manufactureDate, first.min, first.max, first.metadata),
      ).to.equal(1n);
      await (await register(registry, manufacturer, first)).wait();
      expect(
        await registry
          .connect(manufacturer)
          .registerBatch.staticCall(second.productHash, second.manufactureDate, second.min, second.max, second.metadata),
      ).to.equal(2n);
    });

    it("numbers lots 1, 2, 3 in registration order across different manufacturers", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { manufacturer, secondManufacturer } = accounts;
      const registrations = [
        { by: manufacturer, lotNumber: "LOT-A" },
        { by: secondManufacturer, lotNumber: "LOT-B" },
        { by: manufacturer, lotNumber: "LOT-C" },
      ];

      for (const [index, { by, lotNumber }] of registrations.entries()) {
        const args = await validArgs({
          productHash: makeProductHash("NDC-1234-5678-90", lotNumber),
          metadata: makeDocument(`lot metadata ${lotNumber}`),
        });
        await expect(register(registry, by, args))
          .to.emit(registry, "BatchRegistered")
          .withArgs(BigInt(index + 1), by.address, args.productHash, args.metadata.cid);
      }

      expect(await registry.totalBatches()).to.equal(3n);
      for (const [index, { by, lotNumber }] of registrations.entries()) {
        const record = await readBatch(registry, BigInt(index + 1));
        expect(record.manufacturer, lotNumber).to.equal(by.address);
        expect(record.custodian, lotNumber).to.equal(by.address);
        expect(await registry.batchIdOf(makeProductHash("NDC-1234-5678-90", lotNumber))).to.equal(BigInt(index + 1));
      }
    });

    it("accepts a manufactureDate equal to the block timestamp", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const blockTime = (await latestTimestamp()) + 60n;
      await networkHelpers.time.setNextBlockTimestamp(blockTime);
      const args = await validArgs({ manufactureDate: blockTime });

      await expect(register(registry, accounts.manufacturer, args))
        .to.emit(registry, "BatchRegistered")
        .withArgs(1n, accounts.manufacturer.address, args.productHash, args.metadata.cid);
      const record = await readBatch(registry, 1n);
      expect(record.manufactureDate).to.equal(blockTime);
      expect(record.registeredAt).to.equal(blockTime);
    });

    it("accepts the earliest non-zero manufactureDate, 1 second after the Unix epoch", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const args = await validArgs({ manufactureDate: 1n });
      await expect(register(registry, accounts.manufacturer, args))
        .to.emit(registry, "BatchRegistered")
        .withArgs(1n, accounts.manufacturer.address, args.productHash, args.metadata.cid);
      expect((await readBatch(registry, 1n)).manufactureDate).to.equal(1n);
    });

    for (const { title, min, max } of [
      { title: "the narrowest range, min = max - 1", min: 20, max: 21 },
      { title: "a negative range for a frozen product (-25.0 C to -15.0 C)", min: -250, max: -150 },
      { title: "a range that crosses 0 C", min: -5, max: 5 },
      { title: "the int16 extremes as the range", min: INT16_MIN, max: INT16_MAX },
    ]) {
      it(`accepts and stores ${title}`, async function () {
        const { registry, accounts } = await loadFixture(deployRegistryFixture);
        const args = await validArgs({ min, max });

        const tx = register(registry, accounts.manufacturer, args);
        await expect(tx)
          .to.emit(registry, "BatchRegistered")
          .withArgs(1n, accounts.manufacturer.address, args.productHash, args.metadata.cid);
        expect(await readBatch(registry, 1n)).to.deep.equal(
          newLotRecord({
            ...args,
            id: 1n,
            manufacturer: accounts.manufacturer.address,
            registeredAt: await blockTimestampOf(tx),
          }),
        );
      });
    }

    it("leaves earlier lots untouched when a new lot is registered", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      await registerLot({ registry, accounts });
      const before = await readBatch(registry, 1n);

      await registerLot({ registry, accounts }, { by: accounts.secondManufacturer });

      expect(await readBatch(registry, 1n)).to.deep.equal(before);
    });
  });

  describe("registerBatch: validation", function () {
    /** A rejected registration stores nothing: no lot, no hash mapping. */
    async function expectNothingStored(registry, productHash, lotsBefore = 0n) {
      expect(await registry.totalBatches()).to.equal(lotsBefore);
      if (lotsBefore === 0n) expect(await registry.batchIdOf(productHash)).to.equal(0n);
    }

    it("rejects a zero product hash with ZeroProductHash", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const args = await validArgs({ productHash: ZeroHash });
      await expect(register(registry, accounts.manufacturer, args)).to.be.revertedWithCustomError(
        registry,
        "ZeroProductHash",
      );
      await expectNothingStored(registry, ZeroHash);
    });

    it("rejects manufactureDate 0 with InvalidTimestamp(0)", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const args = await validArgs({ manufactureDate: 0n });
      await expect(register(registry, accounts.manufacturer, args))
        .to.be.revertedWithCustomError(registry, "InvalidTimestamp")
        .withArgs(0n);
      await expectNothingStored(registry, args.productHash);
    });

    it("rejects a manufactureDate one second after the block timestamp", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const blockTime = (await latestTimestamp()) + 60n;
      await networkHelpers.time.setNextBlockTimestamp(blockTime);
      const args = await validArgs({ manufactureDate: blockTime + 1n });

      await expect(register(registry, accounts.manufacturer, args))
        .to.be.revertedWithCustomError(registry, "InvalidTimestamp")
        .withArgs(blockTime + 1n);
      await expectNothingStored(registry, args.productHash);
    });

    it("rejects the largest uint64 manufactureDate", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const args = await validArgs({ manufactureDate: UINT64_MAX });
      await expect(register(registry, accounts.manufacturer, args))
        .to.be.revertedWithCustomError(registry, "InvalidTimestamp")
        .withArgs(UINT64_MAX);
      await expectNothingStored(registry, args.productHash);
    });

    for (const { title, min, max } of [
      { title: "an empty range, min == max", min: 20, max: 20 },
      { title: "an inverted range, min > max", min: 80, max: 20 },
      { title: "an inverted range at the int16 extremes", min: INT16_MAX, max: INT16_MIN },
      { title: "an empty negative range", min: -150, max: -150 },
    ]) {
      it(`rejects ${title}: InvalidTemperatureRange(min, max)`, async function () {
        const { registry, accounts } = await loadFixture(deployRegistryFixture);
        const args = await validArgs({ min, max });
        await expect(register(registry, accounts.manufacturer, args))
          .to.be.revertedWithCustomError(registry, "InvalidTemperatureRange")
          .withArgs(min, max);
        await expectNothingStored(registry, args.productHash);
      });
    }

    for (const { title, metadata } of [
      { title: "an empty CID", metadata: { ...makeDocument("metadata"), cid: "" } },
      { title: "a zero content hash", metadata: { ...makeDocument("metadata"), contentHash: ZeroHash } },
      { title: "both halves empty", metadata: EMPTY_DOCUMENT },
    ]) {
      it(`rejects metadata with ${title}: EmptyDocument`, async function () {
        const { registry, accounts } = await loadFixture(deployRegistryFixture);
        const args = await validArgs({ metadata });
        await expect(register(registry, accounts.manufacturer, args)).to.be.revertedWithCustomError(
          registry,
          "EmptyDocument",
        );
        await expectNothingStored(registry, args.productHash);
      });
    }

    it("rejects a product hash the same manufacturer already registered with DuplicateProduct(hash, 1)", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { productHash } = await registerLot({ registry, accounts });
      const before = await readBatch(registry, 1n);

      // Everything except the product hash differs from the first registration.
      const args = await validArgs({ productHash, min: -100, max: 0, metadata: makeDocument("other metadata") });
      await expect(register(registry, accounts.manufacturer, args))
        .to.be.revertedWithCustomError(registry, "DuplicateProduct")
        .withArgs(productHash, 1n);

      await expectNothingStored(registry, productHash, 1n);
      expect(await readBatch(registry, 1n)).to.deep.equal(before);
    });

    it("rejects a product hash another manufacturer already registered (uniqueness is global, C5)", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { productHash } = await registerLot({ registry, accounts });

      const args = await validArgs({ productHash });
      await expect(register(registry, accounts.secondManufacturer, args))
        .to.be.revertedWithCustomError(registry, "DuplicateProduct")
        .withArgs(productHash, 1n);
      await expectNothingStored(registry, productHash, 1n);
      expect(await registry.batchIdOf(productHash)).to.equal(1n);
    });

    it("names the lot that already holds the hash when several lots exist", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const ctx = { registry, accounts };
      await registerLot(ctx);
      const { productHash } = await registerLot(ctx);
      await registerLot(ctx);

      const args = await validArgs({ productHash });
      await expect(register(registry, accounts.manufacturer, args))
        .to.be.revertedWithCustomError(registry, "DuplicateProduct")
        .withArgs(productHash, 2n);
      await expectNothingStored(registry, productHash, 3n);
    });

    it("still rejects the product hash of a recalled lot (a recall does not free it, C5)", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const ctx = { registry, accounts };
      const { id, productHash } = await registerLot(ctx);
      await kit.recall(ctx, id);

      const args = await validArgs({ productHash });
      await expect(register(registry, accounts.manufacturer, args))
        .to.be.revertedWithCustomError(registry, "DuplicateProduct")
        .withArgs(productHash, 1n);
      await expectNothingStored(registry, productHash, 1n);
    });
  });

  describe("read-only views after registration", function () {
    it("returns the same record to a patient reading through a provider with no signer", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      await registerLot({ registry, accounts });

      const asPatient = registry.connect(ethers.provider);
      expect(await readBatch(asPatient, 1n)).to.deep.equal(await readBatch(registry, 1n));
      expect(await asPatient.totalBatches()).to.equal(1n);
    });

    it("maps each registered product hash to its lot and an unknown hash to 0", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const ctx = { registry, accounts };
      const first = await registerLot(ctx);
      const second = await registerLot(ctx, { by: accounts.secondManufacturer });

      expect(await registry.batchIdOf(first.productHash)).to.equal(1n);
      expect(await registry.batchIdOf(second.productHash)).to.equal(2n);
      expect(await registry.batchIdOf(makeProductHash("NDC-0000-0000-00", "NEVER-REGISTERED"))).to.equal(0n);
    });

    it("rejects verifyBatch(0) and verifyBatch(totalBatches() + 1) with BatchNotFound", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      await registerLot({ registry, accounts });
      await registerLot({ registry, accounts });

      for (const batchId of [0n, 3n]) {
        await expect(registry.verifyBatch(batchId))
          .to.be.revertedWithCustomError(registry, "BatchNotFound")
          .withArgs(batchId);
      }
    });
  });
});
