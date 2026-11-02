// Unit tests for the ProvenanceRegistry draft.
//
// Run: npm test   (in-process Hardhat network; no .env needed)
//
// What the draft can already be tested on:
//   - deployment and role administration (regulator onboards organizations)
//   - the public interface matches proposal Table I and Fig. 1
//   - read-only views (verifyBatch, totalBatches, batchIdOf)
//   - access control on every write function (wrong role -> revert,
//     right role -> reaches the not-yet-implemented body)
// The "behaviour to implement" block lists pending tests (shown as "pending"
// by mocha) for the state machine. Turn each into a real test when its
// function is implemented.
import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

// Must match the order of `enum Status` in IProvenanceRegistry.sol.
const Status = { Created: 0, InTransit: 1, Stored: 2, Delivered: 3, Compromised: 4, Recalled: 5 };

// Example off-chain document pointer: an IPFS CID plus keccak256 of the file bytes (O1).
const DOC = {
  cid: "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
  contentHash: ethers.keccak256(ethers.toUtf8Bytes('{"example":"lot metadata"}')),
};

// productHash = keccak256(abi.encode(productCode, lotNumber)), computed off-chain (C5).
const PRODUCT_HASH = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], ["NDC-0000-0000-00", "LOT-2026-001"]),
);

const JAN_1_2026 = 1767225600n;

async function deployRegistryFixture() {
  const [deployer, regulator, manufacturer, distributor, retailer, oracle, outsider] =
    await ethers.getSigners();

  const registry = await ethers.deployContract("ProvenanceRegistry", [regulator.address]);

  const roles = {
    DEFAULT_ADMIN: await registry.DEFAULT_ADMIN_ROLE(),
    REGULATOR: await registry.REGULATOR_ROLE(),
    MANUFACTURER: await registry.MANUFACTURER_ROLE(),
    DISTRIBUTOR: await registry.DISTRIBUTOR_ROLE(),
    RETAILER: await registry.RETAILER_ROLE(),
    ORACLE: await registry.ORACLE_ROLE(),
  };

  // Data-flow step 4 ("Oversee"): the regulator onboards each organization.
  const asRegulator = registry.connect(regulator);
  await asRegulator.grantRole(roles.MANUFACTURER, manufacturer.address);
  await asRegulator.grantRole(roles.DISTRIBUTOR, distributor.address);
  await asRegulator.grantRole(roles.RETAILER, retailer.address);
  await asRegulator.grantRole(roles.ORACLE, oracle.address);

  return {
    registry,
    roles,
    signers: { deployer, regulator, manufacturer, distributor, retailer, oracle, outsider },
  };
}

describe("ProvenanceRegistry (draft)", function () {
  describe("deployment and roles", function () {
    it("gives the regulator REGULATOR_ROLE and DEFAULT_ADMIN_ROLE", async function () {
      const { registry, roles, signers } = await networkHelpers.loadFixture(deployRegistryFixture);
      expect(await registry.hasRole(roles.REGULATOR, signers.regulator.address)).to.equal(true);
      expect(await registry.hasRole(roles.DEFAULT_ADMIN, signers.regulator.address)).to.equal(true);
    });

    it("gives the deployer no role when it is not the regulator", async function () {
      const { registry, roles, signers } = await networkHelpers.loadFixture(deployRegistryFixture);
      for (const role of Object.values(roles)) {
        expect(await registry.hasRole(role, signers.deployer.address)).to.equal(false);
      }
    });

    it("makes REGULATOR_ROLE the admin of the four organization roles", async function () {
      const { registry, roles } = await networkHelpers.loadFixture(deployRegistryFixture);
      for (const role of [roles.MANUFACTURER, roles.DISTRIBUTOR, roles.RETAILER, roles.ORACLE]) {
        expect(await registry.getRoleAdmin(role)).to.equal(roles.REGULATOR);
      }
    });

    it("rejects a zero regulator address", async function () {
      const { registry } = await networkHelpers.loadFixture(deployRegistryFixture);
      await expect(
        ethers.deployContract("ProvenanceRegistry", [ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("lets the regulator onboard and offboard an organization", async function () {
      const { registry, roles, signers } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { regulator, outsider } = signers;

      await expect(registry.connect(regulator).grantRole(roles.DISTRIBUTOR, outsider.address))
        .to.emit(registry, "RoleGranted")
        .withArgs(roles.DISTRIBUTOR, outsider.address, regulator.address);

      await expect(registry.connect(regulator).revokeRole(roles.DISTRIBUTOR, outsider.address))
        .to.emit(registry, "RoleRevoked")
        .withArgs(roles.DISTRIBUTOR, outsider.address, regulator.address);
    });

    it("stops anyone else from granting roles", async function () {
      const { registry, roles, signers } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { manufacturer, outsider } = signers;

      await expect(registry.connect(manufacturer).grantRole(roles.MANUFACTURER, outsider.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(manufacturer.address, roles.REGULATOR);
    });
  });

  describe("public interface (proposal Table I and Fig. 1)", function () {
    const TABLE_I_FUNCTIONS = [
      "registerBatch",
      "initiateTransfer",
      "acceptTransfer",
      "updateStatus",
      "markDelivered",
      "verifyBatch",
      "grantRole",
      "revokeRole",
      "issueCertificate",
      "recallBatch",
      "anchorSensorLog",
      "reportExcursion",
    ];
    const FIG_1_EVENTS = [
      "BatchRegistered",
      "TransferInitiated",
      "CustodyTransferred",
      "StatusUpdated",
      "CertificateIssued",
      "SensorLogAnchored",
      "ExcursionReported",
      "BatchRecalled",
    ];

    it("exposes every function in Table I", async function () {
      const { registry } = await networkHelpers.loadFixture(deployRegistryFixture);
      for (const name of TABLE_I_FUNCTIONS) {
        expect(registry.interface.getFunction(name), name).to.not.equal(null);
      }
    });

    it("declares every event in Fig. 1, plus the proposed TransferCancelled", async function () {
      const { registry } = await networkHelpers.loadFixture(deployRegistryFixture);
      for (const name of [...FIG_1_EVENTS, "TransferCancelled"]) {
        expect(registry.interface.getEvent(name), name).to.not.equal(null);
      }
    });
  });

  describe("read-only views", function () {
    it("starts with no lots", async function () {
      const { registry } = await networkHelpers.loadFixture(deployRegistryFixture);
      expect(await registry.totalBatches()).to.equal(0n);
      expect(await registry.batchIdOf(PRODUCT_HASH)).to.equal(0n);
    });

    it("reverts verifyBatch for a lot that does not exist (including id 0)", async function () {
      const { registry, signers } = await networkHelpers.loadFixture(deployRegistryFixture);
      // Called from an account with no role, like a patient's verify page.
      const asPublic = registry.connect(signers.outsider);
      for (const id of [0n, 1n]) {
        await expect(asPublic.verifyBatch(id))
          .to.be.revertedWithCustomError(registry, "BatchNotFound")
          .withArgs(id);
      }
    });
  });

  describe("access control on write functions", function () {
    // `allowed` holds a role in the fixture. Functions that accept two roles
    // list both in `eitherRoles`.
    const WRITE_CALLS = [
      {
        fn: "registerBatch",
        role: "MANUFACTURER",
        allowed: "manufacturer",
        args: () => [PRODUCT_HASH, JAN_1_2026, 20, 80, DOC],
      },
      {
        fn: "initiateTransfer",
        eitherRoles: ["MANUFACTURER", "DISTRIBUTOR"],
        allowed: "manufacturer",
        args: (s) => [1n, s.distributor.address],
      },
      {
        fn: "acceptTransfer",
        eitherRoles: ["DISTRIBUTOR", "RETAILER"],
        allowed: "distributor",
        args: () => [1n],
      },
      {
        fn: "cancelTransfer",
        eitherRoles: ["MANUFACTURER", "DISTRIBUTOR"],
        allowed: "distributor",
        args: () => [1n],
      },
      { fn: "updateStatus", role: "DISTRIBUTOR", allowed: "distributor", args: () => [1n, Status.Stored] },
      { fn: "markDelivered", role: "RETAILER", allowed: "retailer", args: () => [1n] },
      { fn: "issueCertificate", role: "REGULATOR", allowed: "regulator", args: () => [1n, DOC] },
      { fn: "recallBatch", role: "REGULATOR", allowed: "regulator", args: () => [1n, "test recall"] },
      { fn: "anchorSensorLog", role: "ORACLE", allowed: "oracle", args: () => [1n, DOC] },
      { fn: "reportExcursion", role: "ORACLE", allowed: "oracle", args: () => [1n, 95, JAN_1_2026, DOC] },
    ];

    for (const call of WRITE_CALLS) {
      const who = call.role ?? call.eitherRoles.join(" or ");

      it(`${call.fn}: rejects callers without ${who}`, async function () {
        const { registry, roles, signers } = await networkHelpers.loadFixture(deployRegistryFixture);
        const tx = registry.connect(signers.outsider)[call.fn](...call.args(signers));

        if (call.role) {
          await expect(tx)
            .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
            .withArgs(signers.outsider.address, roles[call.role]);
        } else {
          const [a, b] = call.eitherRoles;
          await expect(tx)
            .to.be.revertedWithCustomError(registry, "MissingEitherRole")
            .withArgs(signers.outsider.address, roles[a], roles[b]);
        }
      });

      it(`${call.fn}: lets ${who} through to the draft body (NotImplemented)`, async function () {
        const { registry, signers } = await networkHelpers.loadFixture(deployRegistryFixture);
        await expect(
          registry.connect(signers[call.allowed])[call.fn](...call.args(signers)),
        ).to.be.revertedWithCustomError(registry, "NotImplemented");
      });
    }
  });

  // Pending until the 11/15 Amoy prototype. Each item matches a step in the
  // TODO comments in contracts/ProvenanceRegistry.sol and the transition
  // table in contracts/README.md.
  describe("behaviour to implement (pending)", function () {
    it("registerBatch assigns ids from 1, stores the record and emits BatchRegistered");
    it("registerBatch rejects a duplicate productHash, min >= max temperature, or empty metadata");
    it("initiateTransfer: only the custodian, only to an allowed role, Created|Stored -> InTransit");
    it("initiateTransfer rejects a second open hand-off for the same lot");
    it("acceptTransfer: only the pending custodian; custody moves; InTransit -> Stored");
    it("cancelTransfer restores the status the lot had before initiateTransfer");
    it("updateStatus allows only InTransit <-> Stored and is blocked while a hand-off is open");
    it("markDelivered: only the custodian pharmacy, Stored -> Delivered");
    it("custody functions reject a role holder that is not the lot's custodian (C4)");
    it("anchorSensorLog stores the latest log, increments the count, active lots only");
    it("reportExcursion rejects in-range readings, flags Compromised and clears an open hand-off");
    it("issueCertificate works in every status except Recalled and overwrites the certificate");
    it("recallBatch works from every status except Recalled, including Delivered and Compromised");
    it("Delivered, Compromised and Recalled lots reject transfers, updateStatus and markDelivered");
    // Moves to test/integration/ (design decision D4) once the write functions exist.
    it("full journey (data flows 1-5) can be rebuilt from events alone");
  });
});
