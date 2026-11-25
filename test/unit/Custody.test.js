// Unit tests: the custody hand-off and status functions (data flow 2,
// "Hand off"): initiateTransfer, acceptTransfer, cancelTransfer, updateStatus
// and markDelivered.
//
// These functions combine three kinds of rules, and the tests are grouped the
// same way for each function:
//   - success: the event with all its arguments, exactly one registry event,
//     and the whole record afterwards (custody moves only on acceptTransfer);
//   - rules: each test breaks exactly one rule (who holds the lot, decision
//     C4; the open hand-off; the status; the route, decision C3) and checks
//     the exact custom error and that the record did not change. The callers
//     include the parties closest to the lot, not only outsiders: the sender
//     of an open hand-off, and the manufacturer after custody has moved on;
//   - check order: the interface fixes the order of the checks for
//     initiateTransfer, acceptTransfer, cancelTransfer and updateStatus.
//     These tests deliberately break two rules at once and expect the error
//     of the one checked first. markDelivered's order is left open, so the
//     one scenario that cannot avoid breaking two of its rules accepts either
//     error (expectRejectedWithAnyOf).
// updateStatus is also run against every (from, to) pair of statuses. Some
// statuses can only reach a custody check if the custodian holds a second
// role (a manufacturer that is also a distributor holds a Created lot; a
// pharmacy that is also a distributor holds a Delivered one); those tests
// grant the second role so that the status is the only rule they break. The
// route rule is tested the same way from both sides: a pharmacy that is also
// a distributor, and a manufacturer that is also a distributor.
// Callers without the function's role are covered by AccessControl.test.js.
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import {
  ROLES,
  STATUS_NAMES,
  Status,
  createRegistryKit,
  expectOnlyEvent,
  expectRejected,
  expectRejectedWithAnyOf,
  readBatch,
} from "../helpers/registry.js";

const connection = await network.create();
const kit = createRegistryKit(connection);
const { loadFixture, lotFixture } = kit;

/**
 * BatchNotFound for lot ID 0 and for totalBatches() + 1, called by an account
 * that holds the function's role, on a registry with one lot.
 */
function rejectsUnknownLots(functionName, callerName, extraArgs = () => []) {
  for (const batchId of [0n, 2n]) {
    it(`rejects lot ID ${batchId} (${batchId === 0n ? "never used" : "totalBatches() + 1"}) with BatchNotFound`, async function () {
      const { registry, accounts } = await loadFixture(lotFixture("Created"));
      await expectRejected(
        registry,
        1n,
        () => registry.connect(accounts[callerName])[functionName](batchId, ...extraArgs(accounts)),
        "BatchNotFound",
        [batchId],
      );
    });
  }
}

describe("Custody", function () {
  describe("initiateTransfer", function () {
    describe("success", function () {
      it("opens a hand-off from the manufacturer to a distributor: InTransit, custody unchanged", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { manufacturer, distributor } = accounts;
        const before = await readBatch(registry, lot.id);

        const tx = registry.connect(manufacturer).initiateTransfer(lot.id, distributor.address);
        await expect(tx)
          .to.emit(registry, "TransferInitiated")
          .withArgs(lot.id, manufacturer.address, distributor.address);
        await expectOnlyEvent(tx, registry, "TransferInitiated");

        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          status: Status.InTransit,
          pendingCustodian: distributor.address,
        });
      });

      it("opens a hand-off from a distributor to a pharmacy", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { distributor, retailer } = accounts;
        const before = await readBatch(registry, lot.id);

        await expect(registry.connect(distributor).initiateTransfer(lot.id, retailer.address))
          .to.emit(registry, "TransferInitiated")
          .withArgs(lot.id, distributor.address, retailer.address);
        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          status: Status.InTransit,
          pendingCustodian: retailer.address,
        });
      });

      it("opens a hand-off from a distributor to another distributor", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { distributor, secondDistributor } = accounts;
        const before = await readBatch(registry, lot.id);

        await expect(registry.connect(distributor).initiateTransfer(lot.id, secondDistributor.address))
          .to.emit(registry, "TransferInitiated")
          .withArgs(lot.id, distributor.address, secondDistributor.address);
        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          status: Status.InTransit,
          pendingCustodian: secondDistributor.address,
        });
      });

      it("routes by role, not by account: a manufacturer may hand off to a pharmacy that also holds DISTRIBUTOR_ROLE", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { regulator, manufacturer, retailer } = accounts;
        await (await registry.connect(regulator).grantRole(ROLES.DISTRIBUTOR, retailer.address)).wait();

        await expect(registry.connect(manufacturer).initiateTransfer(lot.id, retailer.address))
          .to.emit(registry, "TransferInitiated")
          .withArgs(lot.id, manufacturer.address, retailer.address);
        expect((await readBatch(registry, lot.id)).pendingCustodian).to.equal(retailer.address);
      });

      it("routes by the caller's role: a manufacturer that also holds DISTRIBUTOR_ROLE may hand off to a pharmacy", async function () {
        // The mirror case of the test above. The pharmacy is an ordinary one;
        // the regulator has made the manufacturer a distributor as well.
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { regulator, manufacturer, retailer } = accounts;
        await (await registry.connect(regulator).grantRole(ROLES.DISTRIBUTOR, manufacturer.address)).wait();
        const before = await readBatch(registry, lot.id);

        const tx = registry.connect(manufacturer).initiateTransfer(lot.id, retailer.address);
        await expect(tx)
          .to.emit(registry, "TransferInitiated")
          .withArgs(lot.id, manufacturer.address, retailer.address);
        await expectOnlyEvent(tx, registry, "TransferInitiated");
        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          status: Status.InTransit,
          pendingCustodian: retailer.address,
        });
      });
    });

    describe("recipient (route rule, C3)", function () {
      // The regulator can grant a role to the zero address (OpenZeppelin does
      // not refuse it). These two tests do so, which makes the route valid,
      // so that being the zero address is the only rule the recipient breaks.
      // Without the explicit zero check, the lot would become InTransit with
      // no open hand-off that anyone could accept or cancel.
      it("rejects the zero address with InvalidRecipient(0), even when it holds DISTRIBUTOR_ROLE", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        await (await registry.connect(accounts.regulator).grantRole(ROLES.DISTRIBUTOR, ZeroAddress)).wait();
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).initiateTransfer(lot.id, ZeroAddress),
          "InvalidRecipient",
          [ZeroAddress],
        );
      });

      it("rejects the zero address with InvalidRecipient(0), even when it holds RETAILER_ROLE", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        await (await registry.connect(accounts.regulator).grantRole(ROLES.RETAILER, ZeroAddress)).wait();
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).initiateTransfer(lot.id, ZeroAddress),
          "InvalidRecipient",
          [ZeroAddress],
        );
      });

      it("rejects a hand-off to the caller itself", async function () {
        // The distributor holds DISTRIBUTOR_ROLE, so being the caller is the only problem.
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { distributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(distributor).initiateTransfer(lot.id, distributor.address),
          "InvalidRecipient",
          [distributor.address],
        );
      });

      for (const [recipient, description] of [
        ["outsider", "an account with no role"],
        ["secondManufacturer", "a manufacturer"],
        ["oracle", "the oracle"],
        ["regulator", "the regulator"],
      ]) {
        it(`rejects a recipient without a receiving role: ${description}`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
          const to = accounts[recipient].address;
          await expectRejected(
            registry,
            lot.id,
            () => registry.connect(accounts.distributor).initiateTransfer(lot.id, to),
            "InvalidRecipient",
            [to],
          );
        });
      }

      it("rejects a hand-off from a manufacturer without DISTRIBUTOR_ROLE straight to a pharmacy", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { manufacturer, retailer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(manufacturer).initiateTransfer(lot.id, retailer.address),
          "InvalidRecipient",
          [retailer.address],
        );
      });
    });

    describe("custody, hand-off and status rules", function () {
      it("rejects a distributor that holds the role but not the lot with NotCustodian (C4)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { secondDistributor, retailer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondDistributor).initiateTransfer(lot.id, retailer.address),
          "NotCustodian",
          [lot.id, secondDistributor.address],
        );
      });

      it("rejects a manufacturer that did not register the lot with NotCustodian (C4)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { secondManufacturer, distributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondManufacturer).initiateTransfer(lot.id, distributor.address),
          "NotCustodian",
          [lot.id, secondManufacturer.address],
        );
      });

      it("rejects the lot's own manufacturer once custody has moved, with NotCustodian (C4)", async function () {
        // The manufacturer registered the lot and still holds the role, but
        // the distributor accepted it: being the origin gives no custody rights.
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { manufacturer, secondDistributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(manufacturer).initiateTransfer(lot.id, secondDistributor.address),
          "NotCustodian",
          [lot.id, manufacturer.address],
        );
      });

      it("rejects a second hand-off while one is open with TransferAlreadyPending(id, pending)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { manufacturer, distributor, secondDistributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(manufacturer).initiateTransfer(lot.id, secondDistributor.address),
          "TransferAlreadyPending",
          [lot.id, distributor.address],
        );
      });

      it("rejects a lot that its distributor set InTransit with updateStatus", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitMoving"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).initiateTransfer(lot.id, accounts.retailer.address),
          "InvalidStatus",
          [lot.id, Status.InTransit],
        );
      });

      for (const key of ["Compromised", "Recalled"]) {
        it(`rejects a ${key} lot with InvalidStatus`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(key));
          await expectRejected(
            registry,
            lot.id,
            () => registry.connect(accounts.distributor).initiateTransfer(lot.id, accounts.retailer.address),
            "InvalidStatus",
            [lot.id, Status[key]],
          );
        });
      }

      it("rejects a Delivered lot, even when the pharmacy also holds DISTRIBUTOR_ROLE", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Delivered"));
        const { regulator, retailer, distributor } = accounts;
        await (await registry.connect(regulator).grantRole(ROLES.DISTRIBUTOR, retailer.address)).wait();
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(retailer).initiateTransfer(lot.id, distributor.address),
          "InvalidStatus",
          [lot.id, Status.Delivered],
        );
      });

      rejectsUnknownLots("initiateTransfer", "manufacturer", (a) => [a.distributor.address]);
    });

    describe("check order (normative)", function () {
      it("reports NotCustodian before TransferAlreadyPending", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { secondDistributor, retailer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondDistributor).initiateTransfer(lot.id, retailer.address),
          "NotCustodian",
          [lot.id, secondDistributor.address],
        );
      });

      it("reports TransferAlreadyPending before InvalidStatus (an open hand-off is always InTransit)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        const { distributor, secondDistributor, retailer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(distributor).initiateTransfer(lot.id, secondDistributor.address),
          "TransferAlreadyPending",
          [lot.id, retailer.address],
        );
      });

      it("reports InvalidStatus before InvalidRecipient", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Compromised"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).initiateTransfer(lot.id, ZeroAddress),
          "InvalidStatus",
          [lot.id, Status.Compromised],
        );
      });

      it("reports NotCustodian before InvalidRecipient", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { secondDistributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondDistributor).initiateTransfer(lot.id, ZeroAddress),
          "NotCustodian",
          [lot.id, secondDistributor.address],
        );
      });
    });
  });

  describe("acceptTransfer", function () {
    describe("success", function () {
      it("moves custody to the named distributor: Stored, hand-off closed, origin unchanged", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { manufacturer, distributor } = accounts;
        const before = await readBatch(registry, lot.id);

        const tx = registry.connect(distributor).acceptTransfer(lot.id);
        await expect(tx)
          .to.emit(registry, "CustodyTransferred")
          .withArgs(lot.id, manufacturer.address, distributor.address);
        await expectOnlyEvent(tx, registry, "CustodyTransferred");

        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          custodian: distributor.address,
          pendingCustodian: ZeroAddress,
          status: Status.Stored,
        });
        expect(before.manufacturer).to.equal(manufacturer.address);
      });

      it("moves custody to the named pharmacy", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        const { distributor, retailer } = accounts;
        const before = await readBatch(registry, lot.id);

        await expect(registry.connect(retailer).acceptTransfer(lot.id))
          .to.emit(registry, "CustodyTransferred")
          .withArgs(lot.id, distributor.address, retailer.address);
        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          custodian: retailer.address,
          pendingCustodian: ZeroAddress,
          status: Status.Stored,
        });
      });

      it("moves custody from one distributor to another", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { distributor, secondDistributor } = accounts;
        await kit.openHandOff({ registry, accounts }, lot.id, distributor, secondDistributor);
        const before = await readBatch(registry, lot.id);

        await expect(registry.connect(secondDistributor).acceptTransfer(lot.id))
          .to.emit(registry, "CustodyTransferred")
          .withArgs(lot.id, distributor.address, secondDistributor.address);
        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          custodian: secondDistributor.address,
          pendingCustodian: ZeroAddress,
          status: Status.Stored,
        });
      });
    });

    describe("rules", function () {
      it("rejects a distributor that was not named with NotPendingCustodian", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { secondDistributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondDistributor).acceptTransfer(lot.id),
          "NotPendingCustodian",
          [lot.id, secondDistributor.address],
        );
      });

      it("rejects a pharmacy when a distributor was named", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { retailer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(retailer).acceptTransfer(lot.id),
          "NotPendingCustodian",
          [lot.id, retailer.address],
        );
      });

      it("rejects the sender of the hand-off with NotPendingCustodian: it cannot accept its own offer (C3)", async function () {
        // The distributor opened this hand-off to the pharmacy and holds
        // DISTRIBUTOR_ROLE, which acceptTransfer accepts. If it could accept,
        // the hand-off would close with a one-signature CustodyTransferred(d, d).
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        const { distributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(distributor).acceptTransfer(lot.id),
          "NotPendingCustodian",
          [lot.id, distributor.address],
        );
      });

      it("rejects acceptance when no hand-off is open with NoPendingTransfer", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).acceptTransfer(lot.id),
          "NoPendingTransfer",
          [lot.id],
        );
      });

      it("rejects a second acceptance of the same hand-off", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { distributor } = accounts;
        await kit.acceptHandOff({ registry, accounts }, lot.id, distributor);
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(distributor).acceptTransfer(lot.id),
          "NoPendingTransfer",
          [lot.id],
        );
      });

      it("rejects acceptance of a hand-off that the custodian cancelled", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        await kit.cancelHandOff({ registry, accounts }, lot.id, accounts.manufacturer);
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).acceptTransfer(lot.id),
          "NoPendingTransfer",
          [lot.id],
        );
      });

      rejectsUnknownLots("acceptTransfer", "distributor");
    });

    describe("check order (normative)", function () {
      it("reports NoPendingTransfer before NotPendingCustodian", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.secondDistributor).acceptTransfer(lot.id),
          "NoPendingTransfer",
          [lot.id],
        );
      });
    });
  });

  describe("cancelTransfer", function () {
    describe("success", function () {
      it("cancels a hand-off opened at Created and restores Created", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { manufacturer, distributor } = accounts;
        const before = await readBatch(registry, lot.id);

        const tx = registry.connect(manufacturer).cancelTransfer(lot.id);
        await expect(tx)
          .to.emit(registry, "TransferCancelled")
          .withArgs(lot.id, manufacturer.address, distributor.address);
        await expectOnlyEvent(tx, registry, "TransferCancelled");

        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          status: Status.Created,
          pendingCustodian: ZeroAddress,
        });
      });

      it("cancels a hand-off opened at Stored and restores Stored", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        const { distributor, retailer } = accounts;
        const before = await readBatch(registry, lot.id);

        await expect(registry.connect(distributor).cancelTransfer(lot.id))
          .to.emit(registry, "TransferCancelled")
          .withArgs(lot.id, distributor.address, retailer.address);
        expect(await readBatch(registry, lot.id)).to.deep.equal({
          ...before,
          status: Status.Stored,
          pendingCustodian: ZeroAddress,
        });
      });

      it("allows a new hand-off afterwards, which the former recipient cannot accept", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { manufacturer, distributor, secondDistributor } = accounts;
        await kit.cancelHandOff({ registry, accounts }, lot.id, manufacturer);

        await expect(registry.connect(manufacturer).initiateTransfer(lot.id, secondDistributor.address))
          .to.emit(registry, "TransferInitiated")
          .withArgs(lot.id, manufacturer.address, secondDistributor.address);
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(distributor).acceptTransfer(lot.id),
          "NotPendingCustodian",
          [lot.id, distributor.address],
        );
        await expect(registry.connect(secondDistributor).acceptTransfer(lot.id))
          .to.emit(registry, "CustodyTransferred")
          .withArgs(lot.id, manufacturer.address, secondDistributor.address);
      });

      it("restores the status the latest hand-off started from, not an earlier one", async function () {
        // The first hand-off starts at Created; the one cancelled here starts at Stored.
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const ctx = { registry, accounts };
        const { distributor, retailer } = accounts;
        await kit.setStatus(ctx, lot.id, distributor, Status.InTransit);
        await kit.setStatus(ctx, lot.id, distributor, Status.Stored);
        await kit.openHandOff(ctx, lot.id, distributor, retailer);

        await expect(registry.connect(distributor).cancelTransfer(lot.id))
          .to.emit(registry, "TransferCancelled")
          .withArgs(lot.id, distributor.address, retailer.address);
        expect((await readBatch(registry, lot.id)).status).to.equal(Status.Stored);
      });

      it("restores each lot's own earlier status when hand-offs on two lots interleave", async function () {
        // The remembered status is kept per lot. Lot 1 opens its hand-off at
        // Stored, lot 2 opens one at Created in between, and each cancel must
        // still restore its own lot's status.
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const ctx = { registry, accounts };
        const { manufacturer, distributor, retailer, secondDistributor } = accounts;
        await kit.openHandOff(ctx, lot.id, distributor, retailer);
        const { id: secondLot } = await kit.registerLot(ctx);
        await kit.openHandOff(ctx, secondLot, manufacturer, secondDistributor);

        await kit.cancelHandOff(ctx, lot.id, distributor);
        expect((await readBatch(registry, lot.id)).status, "lot 1").to.equal(Status.Stored);
        await kit.cancelHandOff(ctx, secondLot, manufacturer);
        expect((await readBatch(registry, secondLot)).status, "lot 2").to.equal(Status.Created);
      });
    });

    describe("rules", function () {
      it("rejects a cancel when no hand-off is open with NoPendingTransfer", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).cancelTransfer(lot.id),
          "NoPendingTransfer",
          [lot.id],
        );
      });

      it("rejects a cancel by the named recipient, which is not the custodian (C4)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { distributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(distributor).cancelTransfer(lot.id),
          "NotCustodian",
          [lot.id, distributor.address],
        );
      });

      it("rejects a cancel by a manufacturer that does not hold the lot (C4)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { secondManufacturer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondManufacturer).cancelTransfer(lot.id),
          "NotCustodian",
          [lot.id, secondManufacturer.address],
        );
      });

      it("rejects the lot's own manufacturer after custody has moved, with NotCustodian (C4)", async function () {
        // The hand-off was opened by the distributor that now holds the lot;
        // the manufacturer that registered the lot has no say in it.
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        const { manufacturer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(manufacturer).cancelTransfer(lot.id),
          "NotCustodian",
          [lot.id, manufacturer.address],
        );
      });

      rejectsUnknownLots("cancelTransfer", "manufacturer");
    });

    describe("check order (normative)", function () {
      it("reports NotCustodian before NoPendingTransfer", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { secondDistributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondDistributor).cancelTransfer(lot.id),
          "NotCustodian",
          [lot.id, secondDistributor.address],
        );
      });
    });
  });

  describe("updateStatus", function () {
    // For each starting status: the lot state that has it with no open
    // hand-off, the custodian that calls updateStatus, and whether that
    // custodian needs DISTRIBUTOR_ROLE granted on top of its own role.
    const FROM = [
      { from: Status.Created, key: "Created", caller: "manufacturer", grantDistributor: true },
      { from: Status.InTransit, key: "InTransitMoving", caller: "distributor", grantDistributor: false },
      { from: Status.Stored, key: "StoredAtDistributor", caller: "distributor", grantDistributor: false },
      { from: Status.Delivered, key: "Delivered", caller: "retailer", grantDistributor: true },
      { from: Status.Compromised, key: "Compromised", caller: "distributor", grantDistributor: false },
      { from: Status.Recalled, key: "Recalled", caller: "distributor", grantDistributor: false },
    ];
    const ALLOWED = new Set([`${Status.InTransit}->${Status.Stored}`, `${Status.Stored}->${Status.InTransit}`]);

    describe("every (from, to) pair, called by the custodian with no hand-off open", function () {
      for (const { from, key, caller, grantDistributor } of FROM) {
        for (const to of Object.values(Status)) {
          const allowed = ALLOWED.has(`${from}->${to}`);
          const title = `${STATUS_NAMES[from]} -> ${STATUS_NAMES[to]}: ${
            allowed ? "changes the status and emits StatusUpdated" : "reverts InvalidStatusTransition"
          }`;
          it(title, async function () {
            const { registry, accounts, lot } = await loadFixture(lotFixture(key));
            const custodian = accounts[caller];
            if (grantDistributor) {
              await (await registry.connect(accounts.regulator).grantRole(ROLES.DISTRIBUTOR, custodian.address)).wait();
            }
            const before = await readBatch(registry, lot.id);
            expect(before.custodian).to.equal(custodian.address);

            if (allowed) {
              const tx = registry.connect(custodian).updateStatus(lot.id, to);
              await expect(tx).to.emit(registry, "StatusUpdated").withArgs(lot.id, from, to, custodian.address);
              await expectOnlyEvent(tx, registry, "StatusUpdated");
              expect(await readBatch(registry, lot.id)).to.deep.equal({ ...before, status: to });
            } else {
              await expectRejected(
                registry,
                lot.id,
                () => registry.connect(custodian).updateStatus(lot.id, to),
                "InvalidStatusTransition",
                [lot.id, from, to],
              );
            }
          });
        }
      }
    });

    describe("rules", function () {
      it("rejects any update while a hand-off is open with TransferAlreadyPending", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).updateStatus(lot.id, Status.Stored),
          "TransferAlreadyPending",
          [lot.id, accounts.retailer.address],
        );
      });

      it("rejects a distributor that holds the role but not the lot with NotCustodian (C4)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { secondDistributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondDistributor).updateStatus(lot.id, Status.InTransit),
          "NotCustodian",
          [lot.id, secondDistributor.address],
        );
      });

      it("lets a lot moved back to Stored be handed off again", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitMoving"));
        const { distributor, retailer } = accounts;
        await kit.setStatus({ registry, accounts }, lot.id, distributor, Status.Stored);

        await expect(registry.connect(distributor).initiateTransfer(lot.id, retailer.address))
          .to.emit(registry, "TransferInitiated")
          .withArgs(lot.id, distributor.address, retailer.address);
      });

      for (const value of [6, 255]) {
        it(`rejects the out-of-range Status value ${value} in the ABI decoder, with empty revert data`, async function () {
          // The decoder runs before any modifier, so the role check cannot
          // come first here; the interface documents this exception.
          const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
          const before = await readBatch(registry, lot.id);
          await expect(registry.connect(accounts.distributor).updateStatus(lot.id, value)).to.be.revertedWithoutReason();
          await expect(registry.connect(accounts.outsider).updateStatus(lot.id, value)).to.be.revertedWithoutReason();
          expect(await readBatch(registry, lot.id)).to.deep.equal(before);
        });
      }

      rejectsUnknownLots("updateStatus", "distributor", () => [Status.Stored]);
    });

    describe("check order (normative)", function () {
      it("reports NotCustodian before TransferAlreadyPending", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        const { secondDistributor } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondDistributor).updateStatus(lot.id, Status.Stored),
          "NotCustodian",
          [lot.id, secondDistributor.address],
        );
      });

      it("reports TransferAlreadyPending before InvalidStatusTransition", async function () {
        // InTransit -> InTransit is also an invalid pair.
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.distributor).updateStatus(lot.id, Status.InTransit),
          "TransferAlreadyPending",
          [lot.id, accounts.retailer.address],
        );
      });
    });
  });

  describe("markDelivered", function () {
    describe("success", function () {
      it("marks a lot the pharmacy holds as Delivered and emits StatusUpdated(Stored, Delivered)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtPharmacy"));
        const { retailer } = accounts;
        const before = await readBatch(registry, lot.id);

        const tx = registry.connect(retailer).markDelivered(lot.id);
        await expect(tx)
          .to.emit(registry, "StatusUpdated")
          .withArgs(lot.id, Status.Stored, Status.Delivered, retailer.address);
        await expectOnlyEvent(tx, registry, "StatusUpdated");

        expect(await readBatch(registry, lot.id)).to.deep.equal({ ...before, status: Status.Delivered });
      });
    });

    describe("rules", function () {
      it("rejects a pharmacy that holds the role but not the lot with NotCustodian (C4)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtPharmacy"));
        const { secondRetailer } = accounts;
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(secondRetailer).markDelivered(lot.id),
          "NotCustodian",
          [lot.id, secondRetailer.address],
        );
      });

      it("rejects the named pharmacy before it has accepted the hand-off", async function () {
        // This scenario always breaks two rules: an open hand-off means the lot
        // is InTransit (I1), and the pharmacy is not the custodian until it
        // accepts. markDelivered's check order is not part of the API, so
        // either error is correct. Each rule alone is covered above and below.
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitToPharmacy"));
        const { retailer } = accounts;
        await expectRejectedWithAnyOf(registry, lot.id, () => registry.connect(retailer).markDelivered(lot.id), [
          ["NotCustodian", [lot.id, retailer.address]],
          ["InvalidStatus", [lot.id, Status.InTransit]],
        ]);
      });

      it("rejects a Created lot with InvalidStatus, even when its custodian also holds RETAILER_ROLE", async function () {
        // Only a Stored lot can be delivered. A manufacturer that the
        // regulator has also made a pharmacy still cannot skip the journey.
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { regulator, manufacturer } = accounts;
        await (await registry.connect(regulator).grantRole(ROLES.RETAILER, manufacturer.address)).wait();
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(manufacturer).markDelivered(lot.id),
          "InvalidStatus",
          [lot.id, Status.Created],
        );
      });

      it("rejects a second delivery with InvalidStatus(Delivered)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Delivered"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.retailer).markDelivered(lot.id),
          "InvalidStatus",
          [lot.id, Status.Delivered],
        );
      });

      it("rejects a lot flagged Compromised while at the pharmacy", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtPharmacy"));
        await kit.flagExcursion({ registry, accounts }, lot.id);
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.retailer).markDelivered(lot.id),
          "InvalidStatus",
          [lot.id, Status.Compromised],
        );
      });

      it("rejects a lot recalled while at the pharmacy", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtPharmacy"));
        await kit.recall({ registry, accounts }, lot.id);
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.retailer).markDelivered(lot.id),
          "InvalidStatus",
          [lot.id, Status.Recalled],
        );
      });

      it("rejects a lot that its pharmacy, also holding DISTRIBUTOR_ROLE, set InTransit", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtPharmacy"));
        const { regulator, retailer } = accounts;
        await (await registry.connect(regulator).grantRole(ROLES.DISTRIBUTOR, retailer.address)).wait();
        await kit.setStatus({ registry, accounts }, lot.id, retailer, Status.InTransit);
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(retailer).markDelivered(lot.id),
          "InvalidStatus",
          [lot.id, Status.InTransit],
        );
      });

      rejectsUnknownLots("markDelivered", "retailer");
    });
  });
});
