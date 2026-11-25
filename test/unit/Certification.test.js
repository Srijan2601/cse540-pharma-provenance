// Unit tests: the regulator functions (data flow 4, "Oversee"):
// issueCertificate and recallBatch.
//
// Oversight has to work at any stage and does not depend on who holds the
// lot, so both functions are run against every lot state the suite can build.
// issueCertificate must work in every status except Recalled and never change
// the status; only the newest certificate is stored and the earlier ones stay
// in events (design decision C6). recallBatch must work from every status
// except Recalled, including Delivered and Compromised (design decision C2),
// and must close an open hand-off so that a recalled lot cannot change hands.
// The checks of both functions have no normative order, so each negative test
// breaks exactly one rule. Onboarding organizations, the regulator's third
// duty, is covered by Deployment.test.js; callers without REGULATOR_ROLE by
// AccessControl.test.js.
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress, ZeroHash } from "ethers";
import {
  EMPTY_DOCUMENT,
  LOT_STATES,
  ROLES,
  Status,
  createRegistryKit,
  expectOnlyEvent,
  expectRejected,
  makeDocument,
  readBatch,
} from "../helpers/registry.js";

const connection = await network.create();
const kit = createRegistryKit(connection);
const { loadFixture, lotFixture } = kit;

const NOT_RECALLED_STATES = LOT_STATES.filter((state) => state.status !== Status.Recalled);

const INCOMPLETE_DOCUMENTS = [
  { title: "an empty CID", document: { ...makeDocument("certificate"), cid: "" } },
  { title: "a zero content hash", document: { ...makeDocument("certificate"), contentHash: ZeroHash } },
  { title: "both halves empty", document: EMPTY_DOCUMENT },
];

describe("Certification", function () {
  describe("issueCertificate", function () {
    describe("success", function () {
      it("attaches a certificate to a lot and changes nothing else", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { regulator } = accounts;
        const certificate = makeDocument("GMP certificate");
        const before = await readBatch(registry, lot.id);
        expect(before.certificate).to.deep.equal(EMPTY_DOCUMENT); // a new lot is uncertified

        const tx = registry.connect(regulator).issueCertificate(lot.id, certificate);
        await expect(tx)
          .to.emit(registry, "CertificateIssued")
          .withArgs(lot.id, regulator.address, certificate.cid, certificate.contentHash);
        await expectOnlyEvent(tx, registry, "CertificateIssued");

        expect(await readBatch(registry, lot.id)).to.deep.equal({ ...before, certificate });
      });

      for (const state of NOT_RECALLED_STATES) {
        it(`certifies a lot that is ${state.label}, without changing its status`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(state.key));
          const certificate = makeDocument(`certificate at ${state.key}`);
          const before = await readBatch(registry, lot.id);

          await expect(registry.connect(accounts.regulator).issueCertificate(lot.id, certificate))
            .to.emit(registry, "CertificateIssued")
            .withArgs(lot.id, accounts.regulator.address, certificate.cid, certificate.contentHash);
          expect(await readBatch(registry, lot.id)).to.deep.equal({ ...before, certificate });
        });
      }

      it("replaces the previous certificate and keeps the earlier one in events (C6)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
        const { regulator } = accounts;
        const first = makeDocument("certificate, first issue");
        const second = makeDocument("certificate, reissued");
        await kit.certify({ registry, accounts }, lot.id, first);

        await expect(registry.connect(regulator).issueCertificate(lot.id, second))
          .to.emit(registry, "CertificateIssued")
          .withArgs(lot.id, regulator.address, second.cid, second.contentHash);

        expect((await readBatch(registry, lot.id)).certificate).to.deep.equal(second);
        const history = await registry.queryFilter(registry.filters.CertificateIssued(lot.id));
        expect(history.map((event) => [event.args.cid, event.args.contentHash])).to.deep.equal([
          [first.cid, first.contentHash],
          [second.cid, second.contentHash],
        ]);
      });

      it("leaves an open hand-off open, so the named recipient can still accept", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
        const { manufacturer, distributor } = accounts;
        await kit.certify({ registry, accounts }, lot.id);

        await expect(registry.connect(distributor).acceptTransfer(lot.id))
          .to.emit(registry, "CustodyTransferred")
          .withArgs(lot.id, manufacturer.address, distributor.address);
      });

      it("names the issuing regulator in the event when a second regulator certifies", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { regulator, newcomer } = accounts;
        await (await registry.connect(regulator).grantRole(ROLES.REGULATOR, newcomer.address)).wait();
        const certificate = makeDocument("certificate from a second regulator");

        await expect(registry.connect(newcomer).issueCertificate(lot.id, certificate))
          .to.emit(registry, "CertificateIssued")
          .withArgs(lot.id, newcomer.address, certificate.cid, certificate.contentHash);
      });
    });

    describe("rules", function () {
      it("rejects a Recalled lot with InvalidStatus(Recalled)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Recalled"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.regulator).issueCertificate(lot.id, makeDocument("certificate")),
          "InvalidStatus",
          [lot.id, Status.Recalled],
        );
      });

      for (const { title, document } of INCOMPLETE_DOCUMENTS) {
        it(`rejects a certificate reference with ${title}: EmptyDocument`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
          await expectRejected(
            registry,
            lot.id,
            () => registry.connect(accounts.regulator).issueCertificate(lot.id, document),
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
            () => registry.connect(accounts.regulator).issueCertificate(batchId, makeDocument("certificate")),
            "BatchNotFound",
            [batchId],
          );
        });
      }
    });
  });

  describe("recallBatch", function () {
    const REASON = "Synthetic test recall: stability failure in a retained sample";

    describe("success", function () {
      it("recalls a lot and publishes the reason in BatchRecalled", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        const { regulator } = accounts;
        const before = await readBatch(registry, lot.id);

        const tx = registry.connect(regulator).recallBatch(lot.id, REASON);
        await expect(tx).to.emit(registry, "BatchRecalled").withArgs(lot.id, regulator.address, REASON);
        await expectOnlyEvent(tx, registry, "BatchRecalled");

        expect(await readBatch(registry, lot.id)).to.deep.equal({ ...before, status: Status.Recalled });
      });

      for (const state of NOT_RECALLED_STATES) {
        it(`recalls a lot that is ${state.label}; custody stays put and no hand-off is left open`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(state.key));
          const before = await readBatch(registry, lot.id);

          await expect(registry.connect(accounts.regulator).recallBatch(lot.id, REASON))
            .to.emit(registry, "BatchRecalled")
            .withArgs(lot.id, accounts.regulator.address, REASON);
          expect(await readBatch(registry, lot.id)).to.deep.equal({
            ...before,
            status: Status.Recalled,
            pendingCustodian: ZeroAddress,
          });
        });
      }

      for (const { key, sender, recipient, route } of [
        { key: "InTransitFromFactory", sender: "manufacturer", recipient: "distributor", route: "manufacturer -> distributor" },
        { key: "InTransitToPharmacy", sender: "distributor", recipient: "retailer", route: "distributor -> pharmacy" },
      ]) {
        it(`closes an open ${route} hand-off: the recipient can no longer accept, the sender has nothing to cancel`, async function () {
          const { registry, accounts, lot } = await loadFixture(lotFixture(key));
          await kit.recall({ registry, accounts }, lot.id);

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
          expect((await readBatch(registry, lot.id)).custodian).to.equal(accounts[sender].address);
        });
      }

      it("accepts a one-character reason, the shortest that is not empty", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
        await expect(registry.connect(accounts.regulator).recallBatch(lot.id, "x"))
          .to.emit(registry, "BatchRecalled")
          .withArgs(lot.id, accounts.regulator.address, "x");
      });
    });

    describe("rules", function () {
      it("rejects a lot that is already Recalled with InvalidStatus(Recalled)", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("Recalled"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.regulator).recallBatch(lot.id, REASON),
          "InvalidStatus",
          [lot.id, Status.Recalled],
        );
      });

      it("rejects an empty reason with EmptyReason", async function () {
        const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtPharmacy"));
        await expectRejected(
          registry,
          lot.id,
          () => registry.connect(accounts.regulator).recallBatch(lot.id, ""),
          "EmptyReason",
        );
      });

      for (const batchId of [0n, 2n]) {
        it(`rejects lot ID ${batchId} with BatchNotFound`, async function () {
          const { registry, accounts } = await loadFixture(lotFixture("Created"));
          await expectRejected(
            registry,
            1n,
            () => registry.connect(accounts.regulator).recallBatch(batchId, REASON),
            "BatchNotFound",
            [batchId],
          );
        });
      }
    });
  });
});
