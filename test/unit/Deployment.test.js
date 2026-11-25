// Unit tests: deployment, role wiring, role administration, ERC-165, the
// public interface, and the read-only views on an empty registry.
//
// Everything here holds before the first lot is registered, so these tests
// pin down the ground the other suites build on:
//   - the constructor: who gets which role, which role administers which,
//     the zero-address guard, and the events it emits;
//   - role administration through the inherited AccessControl functions: a
//     generated matrix of who may grant and revoke each role, plus renouncing,
//     adding a second regulator and handing the registry to a new key;
//   - supportsInterface for IERC165, IAccessControl and IProvenanceRegistry;
//   - completeness of the ABI against proposal Table I and Fig. 1, with exact
//     lists of functions, events and errors so that nothing is missing and
//     nothing undocumented is exposed;
//   - the views on an empty registry, also read without a signer.
// Which role may call each write function is tested in AccessControl.test.js.
import { expect } from "chai";
import { network } from "hardhat";
import { MaxUint256, ZeroAddress, ZeroHash, id } from "ethers";
import {
  MATRIX_ACTORS,
  ROLES,
  ROLE_NAMES,
  WRITE_FUNCTIONS,
  createRegistryKit,
  makeProductHash,
} from "../helpers/registry.js";

const connection = await network.create();
const { ethers } = connection;
const { loadFixture, deployRegistryFixture } = createRegistryKit(connection);

const ORGANIZATION_ROLES = ["MANUFACTURER", "DISTRIBUTOR", "RETAILER", "ORACLE"];

/** ERC-165 interface ID: XOR of the 4-byte selectors of the interface's functions. */
function interfaceIdOf(selectors) {
  const xor = selectors.reduce((acc, selector) => acc ^ BigInt(selector), 0n);
  return `0x${xor.toString(16).padStart(8, "0")}`;
}

/** Selector of a function signature such as "hasRole(bytes32,address)". */
const selectorOf = (signature) => id(signature).slice(0, 10);

describe("Deployment and roles", function () {
  describe("constructor", function () {
    it("gives the regulator DEFAULT_ADMIN_ROLE and REGULATOR_ROLE", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      expect(await registry.hasRole(ROLES.DEFAULT_ADMIN, accounts.regulator.address)).to.equal(true);
      expect(await registry.hasRole(ROLES.REGULATOR, accounts.regulator.address)).to.equal(true);
    });

    it("gives the regulator none of the four organization roles", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      for (const role of ORGANIZATION_ROLES) {
        expect(await registry.hasRole(ROLES[role], accounts.regulator.address), role).to.equal(false);
      }
    });

    it("gives the deployer no role when the deployer is not the regulator", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      for (const [name, role] of Object.entries(ROLES)) {
        expect(await registry.hasRole(role, accounts.deployer.address), name).to.equal(false);
      }
    });

    it("gives the deployer both regulator roles when it names itself as regulator", async function () {
      // scripts/deploy.js does this when no separate regulator address is configured.
      const [deployer] = await ethers.getSigners();
      const registry = await ethers.deployContract("ProvenanceRegistry", [deployer.address], deployer);
      expect(await registry.hasRole(ROLES.DEFAULT_ADMIN, deployer.address)).to.equal(true);
      expect(await registry.hasRole(ROLES.REGULATOR, deployer.address)).to.equal(true);
    });

    it("leaves every organization role unassigned until the regulator onboards someone", async function () {
      const signers = (await ethers.getSigners()).slice(0, 11);
      const registry = await ethers.deployContract("ProvenanceRegistry", [signers[1].address], signers[0]);
      for (const signer of signers) {
        for (const role of ORGANIZATION_ROLES) {
          expect(await registry.hasRole(ROLES[role], signer.address), `${role} ${signer.address}`).to.equal(false);
        }
      }
    });

    it("makes REGULATOR_ROLE the admin of the four organization roles", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      for (const role of ORGANIZATION_ROLES) {
        expect(await registry.getRoleAdmin(ROLES[role]), role).to.equal(ROLES.REGULATOR);
      }
    });

    it("keeps DEFAULT_ADMIN_ROLE as the admin of REGULATOR_ROLE and of itself", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      expect(await registry.getRoleAdmin(ROLES.REGULATOR)).to.equal(ROLES.DEFAULT_ADMIN);
      expect(await registry.getRoleAdmin(ROLES.DEFAULT_ADMIN)).to.equal(ROLES.DEFAULT_ADMIN);
    });

    it("exposes each role constant as keccak256 of its name, and DEFAULT_ADMIN_ROLE as zero", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      expect(await registry.DEFAULT_ADMIN_ROLE()).to.equal(ZeroHash);
      for (const [key, name] of Object.entries(ROLE_NAMES)) {
        expect(await registry[name](), name).to.equal(id(name));
        expect(await registry[name](), name).to.equal(ROLES[key]);
      }
    });

    it("emits RoleGranted for both regulator roles and RoleAdminChanged for each organization role", async function () {
      const [deployer, regulator] = await ethers.getSigners();
      const registry = await ethers.deployContract("ProvenanceRegistry", [regulator.address], deployer);
      const tx = registry.deploymentTransaction();

      await expect(tx)
        .to.emit(registry, "RoleGranted")
        .withArgs(ROLES.DEFAULT_ADMIN, regulator.address, deployer.address);
      await expect(tx).to.emit(registry, "RoleGranted").withArgs(ROLES.REGULATOR, regulator.address, deployer.address);
      for (const role of ORGANIZATION_ROLES) {
        await expect(tx)
          .to.emit(registry, "RoleAdminChanged")
          .withArgs(ROLES[role], ROLES.DEFAULT_ADMIN, ROLES.REGULATOR);
      }

      // Nothing else: in particular no registry event and no role for the deployer.
      const receipt = await tx.wait();
      const names = receipt.logs.map((log) => registry.interface.parseLog(log)?.name);
      expect(names).to.deep.equal(["RoleGranted", "RoleGranted", ...ORGANIZATION_ROLES.map(() => "RoleAdminChanged")]);
    });

    it("reverts with ZeroAddress when the regulator is the zero address", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      await expect(ethers.deployContract("ProvenanceRegistry", [ZeroAddress])).to.be.revertedWithCustomError(
        registry,
        "ZeroAddress",
      );
    });
  });

  describe("role administration (inherited grantRole / revokeRole)", function () {
    // Who holds each role in the fixture, and which role administers it.
    const ROLE_SETUP = {
      DEFAULT_ADMIN: { holder: "regulator", admin: "DEFAULT_ADMIN" },
      REGULATOR: { holder: "regulator", admin: "DEFAULT_ADMIN" },
      MANUFACTURER: { holder: "manufacturer", admin: "REGULATOR" },
      DISTRIBUTOR: { holder: "distributor", admin: "REGULATOR" },
      RETAILER: { holder: "retailer", admin: "REGULATOR" },
      ORACLE: { holder: "oracle", admin: "REGULATOR" },
    };

    // Generated matrix: one test per (role, actor). Only the regulator holds
    // an admin role (it holds both DEFAULT_ADMIN_ROLE and REGULATOR_ROLE).
    for (const [role, { holder, admin }] of Object.entries(ROLE_SETUP)) {
      for (const actor of MATRIX_ACTORS) {
        if (actor === "regulator") {
          it(`${role}_ROLE: the regulator can grant it and revoke it`, async function () {
            const { registry, accounts } = await loadFixture(deployRegistryFixture);
            const { regulator, newcomer } = accounts;

            await expect(registry.connect(regulator).grantRole(ROLES[role], newcomer.address))
              .to.emit(registry, "RoleGranted")
              .withArgs(ROLES[role], newcomer.address, regulator.address);
            expect(await registry.hasRole(ROLES[role], newcomer.address)).to.equal(true);

            await expect(registry.connect(regulator).revokeRole(ROLES[role], newcomer.address))
              .to.emit(registry, "RoleRevoked")
              .withArgs(ROLES[role], newcomer.address, regulator.address);
            expect(await registry.hasRole(ROLES[role], newcomer.address)).to.equal(false);
          });
        } else {
          it(`${role}_ROLE: the ${actor} can neither grant it nor revoke it (needs ${admin}_ROLE)`, async function () {
            const { registry, accounts } = await loadFixture(deployRegistryFixture);
            const caller = accounts[actor];
            const { newcomer } = accounts;
            const current = accounts[holder];

            await expect(registry.connect(caller).grantRole(ROLES[role], newcomer.address))
              .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
              .withArgs(caller.address, ROLES[admin]);
            await expect(registry.connect(caller).revokeRole(ROLES[role], current.address))
              .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
              .withArgs(caller.address, ROLES[admin]);

            expect(await registry.hasRole(ROLES[role], newcomer.address)).to.equal(false);
            expect(await registry.hasRole(ROLES[role], current.address)).to.equal(true);
          });
        }
      }
    }

    it("emits nothing when a role is granted to an account that already holds it", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      await expect(
        registry.connect(accounts.regulator).grantRole(ROLES.MANUFACTURER, accounts.manufacturer.address),
      ).to.not.emit(registry, "RoleGranted");
      expect(await registry.hasRole(ROLES.MANUFACTURER, accounts.manufacturer.address)).to.equal(true);
    });

    it("emits nothing when a role is revoked from an account that does not hold it", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      await expect(
        registry.connect(accounts.regulator).revokeRole(ROLES.MANUFACTURER, accounts.outsider.address),
      ).to.not.emit(registry, "RoleRevoked");
    });

    it("lets an organization renounce its own role", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { manufacturer } = accounts;
      await expect(registry.connect(manufacturer).renounceRole(ROLES.MANUFACTURER, manufacturer.address))
        .to.emit(registry, "RoleRevoked")
        .withArgs(ROLES.MANUFACTURER, manufacturer.address, manufacturer.address);
      expect(await registry.hasRole(ROLES.MANUFACTURER, manufacturer.address)).to.equal(false);
    });

    it("rejects renouncing a role on behalf of another account", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { regulator, manufacturer } = accounts;
      await expect(
        registry.connect(regulator).renounceRole(ROLES.MANUFACTURER, manufacturer.address),
      ).to.be.revertedWithCustomError(registry, "AccessControlBadConfirmation");
      expect(await registry.hasRole(ROLES.MANUFACTURER, manufacturer.address)).to.equal(true);
    });

    it("lets a second regulator onboard organizations but not appoint further regulators", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { regulator, newcomer, outsider } = accounts;
      await (await registry.connect(regulator).grantRole(ROLES.REGULATOR, newcomer.address)).wait();

      await expect(registry.connect(newcomer).grantRole(ROLES.DISTRIBUTOR, outsider.address))
        .to.emit(registry, "RoleGranted")
        .withArgs(ROLES.DISTRIBUTOR, outsider.address, newcomer.address);
      await expect(registry.connect(newcomer).grantRole(ROLES.REGULATOR, outsider.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(newcomer.address, ROLES.DEFAULT_ADMIN);
    });

    it("does not let a DEFAULT_ADMIN_ROLE holder without REGULATOR_ROLE onboard organizations", async function () {
      // REGULATOR_ROLE, not DEFAULT_ADMIN_ROLE, administers the organization roles.
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { regulator, newcomer, outsider } = accounts;
      await (await registry.connect(regulator).grantRole(ROLES.DEFAULT_ADMIN, newcomer.address)).wait();

      await expect(registry.connect(newcomer).grantRole(ROLES.MANUFACTURER, outsider.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(newcomer.address, ROLES.REGULATOR);
    });

    it("lets the regulator hand the registry over to a new key and then lose its powers", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { regulator, newcomer, outsider } = accounts;
      await (await registry.connect(regulator).grantRole(ROLES.DEFAULT_ADMIN, newcomer.address)).wait();
      await (await registry.connect(regulator).grantRole(ROLES.REGULATOR, newcomer.address)).wait();
      await (await registry.connect(regulator).renounceRole(ROLES.REGULATOR, regulator.address)).wait();
      await (await registry.connect(regulator).renounceRole(ROLES.DEFAULT_ADMIN, regulator.address)).wait();

      await expect(registry.connect(regulator).grantRole(ROLES.RETAILER, outsider.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(regulator.address, ROLES.REGULATOR);
      await expect(registry.connect(newcomer).grantRole(ROLES.RETAILER, outsider.address))
        .to.emit(registry, "RoleGranted")
        .withArgs(ROLES.RETAILER, outsider.address, newcomer.address);
    });
  });

  describe("supportsInterface (ERC-165)", function () {
    it("reports IERC165", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const ierc165 = interfaceIdOf([selectorOf("supportsInterface(bytes4)")]);
      expect(ierc165).to.equal("0x01ffc9a7");
      expect(await registry.supportsInterface(ierc165)).to.equal(true);
    });

    it("reports IAccessControl", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const iAccessControl = interfaceIdOf(
        [
          "hasRole(bytes32,address)",
          "getRoleAdmin(bytes32)",
          "grantRole(bytes32,address)",
          "revokeRole(bytes32,address)",
          "renounceRole(bytes32,address)",
        ].map(selectorOf),
      );
      expect(iAccessControl).to.equal("0x7965db0b");
      expect(await registry.supportsInterface(iAccessControl)).to.equal(true);
    });

    it("reports IProvenanceRegistry, with the ID computed from the interface's own ABI", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const iface = (await ethers.getContractAt("IProvenanceRegistry", await registry.getAddress())).interface;
      const functions = iface.fragments.filter((fragment) => fragment.type === "function");
      expect(functions.length, "functions declared in IProvenanceRegistry").to.equal(13);

      expect(await registry.supportsInterface(interfaceIdOf(functions.map((f) => f.selector)))).to.equal(true);
    });

    it("rejects 0xffffffff, as ERC-165 requires, and interfaces the registry does not implement", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      // 0x5a05180f IAccessControlEnumerable, 0x80ac58cd ERC-721, 0xd9b67a26 ERC-1155.
      for (const interfaceId of ["0xffffffff", "0x00000000", "0x5a05180f", "0x80ac58cd", "0xd9b67a26"]) {
        expect(await registry.supportsInterface(interfaceId), interfaceId).to.equal(false);
      }
    });
  });

  describe("public interface (proposal Table I and Fig. 1)", function () {
    // Proposal Table I: actor -> contract role -> main functions. "grant
    // roles" is OpenZeppelin's grantRole; the patient has no role or wallet.
    const TABLE_I = [
      { actor: "Manufacturer", role: "MANUFACTURER", functions: ["registerBatch", "initiateTransfer"] },
      {
        actor: "Distributor/3PL",
        role: "DISTRIBUTOR",
        functions: ["acceptTransfer", "updateStatus", "initiateTransfer"],
      },
      { actor: "Pharmacy", role: "RETAILER", functions: ["verifyBatch", "acceptTransfer", "markDelivered"] },
      { actor: "Regulator", role: "REGULATOR", functions: ["grantRole", "issueCertificate", "recallBatch"] },
      { actor: "IoT oracle", role: "ORACLE", functions: ["anchorSensorLog", "reportExcursion"] },
      { actor: "Patient", role: null, functions: ["verifyBatch"] },
    ];

    // Proposal Fig. 1: one event per write.
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
    const OPENZEPPELIN_EVENTS = ["RoleAdminChanged", "RoleGranted", "RoleRevoked"];

    const fragmentsOf = (registry, type) => registry.interface.fragments.filter((fragment) => fragment.type === type);
    const namesOf = (registry, type) => fragmentsOf(registry, type).map((fragment) => fragment.name);

    for (const row of TABLE_I) {
      it(`exposes the ${row.actor} functions of Table I: ${row.functions.join(", ")}`, async function () {
        const { registry } = await loadFixture(deployRegistryFixture);
        for (const name of row.functions) {
          expect(registry.interface.getFunction(name), name).to.not.equal(null);
        }
      });
    }

    it("WRITE_FUNCTIONS (which drives the access-control matrix) gives every Table I write function at least the role Table I names", async function () {
      // This test only compares two tables and calls no contract.
      // WRITE_FUNCTIONS drives the access-control matrix in
      // AccessControl.test.js, which checks it against the deployed contract;
      // this ties that table to the proposal.
      for (const row of TABLE_I.filter((r) => r.role !== null)) {
        for (const name of row.functions.filter((n) => n !== "verifyBatch" && n !== "grantRole")) {
          const entry = WRITE_FUNCTIONS.find((f) => f.name === name);
          expect(entry.roles, `${name} accepts ${row.role}`).to.include(row.role);
        }
      }
    });

    it("declares exactly the registry functions plus the inherited AccessControl ones", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const expected = [
        ...WRITE_FUNCTIONS.map((f) => f.name),
        "verifyBatch",
        "totalBatches",
        "batchIdOf",
        "supportsInterface",
        ...Object.values(ROLE_NAMES),
        "DEFAULT_ADMIN_ROLE",
        "hasRole",
        "getRoleAdmin",
        "grantRole",
        "revokeRole",
        "renounceRole",
      ];
      expect(namesOf(registry, "function").sort()).to.deep.equal(expected.sort());
    });

    it("declares every Fig. 1 event plus TransferCancelled (C3), and no other registry event", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const expected = [...FIG_1_EVENTS, "TransferCancelled", ...OPENZEPPELIN_EVENTS];
      expect(namesOf(registry, "event").sort()).to.deep.equal(expected.sort());
    });

    it("indexes batchId as the first parameter of every registry event, for per-lot history queries (O6)", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      for (const name of [...FIG_1_EVENTS, "TransferCancelled"]) {
        const [first] = registry.interface.getEvent(name).inputs;
        expect(first.name, name).to.equal("batchId");
        expect(first.indexed, name).to.equal(true);
      }
    });

    it("declares exactly the documented custom errors", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const expected = [
        "ZeroAddress",
        "MissingEitherRole",
        "BatchNotFound",
        "ZeroProductHash",
        "DuplicateProduct",
        "InvalidTimestamp",
        "InvalidTemperatureRange",
        "EmptyDocument",
        "NotCustodian",
        "NotPendingCustodian",
        "TransferAlreadyPending",
        "NoPendingTransfer",
        "InvalidRecipient",
        "InvalidStatus",
        "InvalidStatusTransition",
        "ReadingWithinRange",
        "EmptyReason",
        // OpenZeppelin AccessControl
        "AccessControlUnauthorizedAccount",
        "AccessControlBadConfirmation",
      ];
      expect(namesOf(registry, "error").sort()).to.deep.equal(expected.sort());
    });

    it("makes the three lookups view functions and no function payable", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      for (const name of ["verifyBatch", "totalBatches", "batchIdOf"]) {
        expect(registry.interface.getFunction(name).stateMutability, name).to.equal("view");
      }
      for (const { name } of WRITE_FUNCTIONS) {
        expect(registry.interface.getFunction(name).stateMutability, name).to.equal("nonpayable");
      }
      expect(fragmentsOf(registry, "function").filter((f) => f.payable)).to.deep.equal([]);
    });

    it("rejects plain ether transfers, since it has no receive or fallback function", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      expect(registry.interface.receive).to.equal(false);
      expect(registry.interface.fallback).to.equal(null);
      await expect(
        accounts.outsider.sendTransaction({ to: await registry.getAddress(), value: 1n }),
      ).to.be.revertedWithoutReason();
    });
  });

  describe("read-only views on an empty registry", function () {
    it("reports zero lots", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      expect(await registry.totalBatches()).to.equal(0n);
    });

    it("maps every product hash to 0, including the zero hash", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      expect(await registry.batchIdOf(makeProductHash("NDC-0000-0000-00", "LOT-TEST-1"))).to.equal(0n);
      expect(await registry.batchIdOf(ZeroHash)).to.equal(0n);
    });

    for (const [label, batchId] of [
      ["0", 0n],
      ["1 (= totalBatches() + 1)", 1n],
      ["2^256 - 1", MaxUint256],
    ]) {
      it(`reverts verifyBatch(${label}) with BatchNotFound`, async function () {
        const { registry } = await loadFixture(deployRegistryFixture);
        await expect(registry.verifyBatch(batchId))
          .to.be.revertedWithCustomError(registry, "BatchNotFound")
          .withArgs(batchId);
      });
    }

    it("answers a patient's read-only queries through a provider with no signer", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const asPatient = registry.connect(ethers.provider);
      expect(await asPatient.totalBatches()).to.equal(0n);
      await expect(asPatient.verifyBatch(1n)).to.be.revertedWithCustomError(registry, "BatchNotFound").withArgs(1n);
    });
  });
});
