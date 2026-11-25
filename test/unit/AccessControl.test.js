// Unit tests: role-based access control on every write function.
//
// The core is a generated role x function matrix: ten write functions times
// seven actors (the five roles of proposal Table I, an account with no role,
// and the deployer, which the constructor leaves without a role). Each cell
// is one test, so a failure names the exact function and actor.
//
// Every cell sends two calls:
//   - a "probe" that names a lot that does not exist (or, for registerBatch,
//     a zero product hash), so it fails on the first check after the role
//     check;
//   - a call that the function's intended caller would make successfully on
//     a lot in the right state.
// An actor without an accepted role must get the exact role error for both
// calls (AccessControlUnauthorizedAccount for single-role functions,
// MissingEitherRole for two-role ones) and change nothing. That shows the
// role check runs first and that no other condition overrides it. An actor
// with an accepted role must get past the role check: the probe fails with
// BatchNotFound (or ZeroProductHash), and the valid call has the outcome
// its position dictates, either success or the custody error of design
// decision C4 (a role holder that does not hold the lot).
//
// After the matrix: roles that change after deployment (an account granted a
// role can act at once; a revoked organization cannot act, its lots stay
// where they are and the regulator can still recall them), a wallet that
// holds two roles, and the one check that runs before any role check, the
// ABI decoder.
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroHash } from "ethers";
import {
  ACCOUNT_ROLES,
  MATRIX_ACTORS,
  ROLES,
  Status,
  WRITE_FUNCTIONS,
  createRegistryKit,
  expectOnlyEvent,
  expectRejected,
  makeDocument,
  makeProductHash,
  readBatch,
} from "../helpers/registry.js";

const connection = await network.create();
const kit = createRegistryKit(connection);
const { loadFixture, deployRegistryFixture, lotFixture, latestTimestamp } = kit;

const CERTIFICATE = makeDocument("access-control test certificate");
const SENSOR_LOG = makeDocument("access-control test sensor log");
const METADATA = makeDocument("access-control test lot metadata");
const PRODUCT_HASH = makeProductHash("NDC-0000-0000-00", "LOT-ACCESS-CONTROL");
const REASON = "access-control test recall";

const succeeds = (event, args) => ({ event, args });
const reverts = (error, args) => ({ error, args });

// Per write function: the fixture with the lot (ID 1) that the valid call
// needs, the arguments of the probe and of the valid call, and the expected
// outcome of the valid call for each actor that holds an accepted role.
// Argument builders receive the fixture context and the probe's lot ID
// (totalBatches() + 1, a lot that does not exist).
const CASES = {
  registerBatch: {
    fixture: () => deployRegistryFixture,
    probe: async () => ({
      args: [ZeroHash, (await latestTimestamp()) - 60n, 20, 80, METADATA],
      error: ["ZeroProductHash", []],
    }),
    valid: async () => [PRODUCT_HASH, (await latestTimestamp()) - 60n, 20, 80, METADATA],
    outcomes: {
      manufacturer: ({ manufacturer }) => succeeds("BatchRegistered", [1n, manufacturer, PRODUCT_HASH, METADATA.cid]),
    },
  },
  initiateTransfer: {
    fixture: () => lotFixture("Created"),
    probe: async ({ distributor }, missing) => ({ args: [missing, distributor], error: ["BatchNotFound", [missing]] }),
    valid: async ({ distributor }) => [1n, distributor],
    outcomes: {
      manufacturer: ({ manufacturer, distributor }) => succeeds("TransferInitiated", [1n, manufacturer, distributor]),
      distributor: ({ distributor }) => reverts("NotCustodian", [1n, distributor]),
    },
  },
  acceptTransfer: {
    fixture: () => lotFixture("InTransitFromFactory"),
    probe: async (_, missing) => ({ args: [missing], error: ["BatchNotFound", [missing]] }),
    valid: async () => [1n],
    outcomes: {
      distributor: ({ manufacturer, distributor }) => succeeds("CustodyTransferred", [1n, manufacturer, distributor]),
      retailer: ({ retailer }) => reverts("NotPendingCustodian", [1n, retailer]),
    },
  },
  cancelTransfer: {
    fixture: () => lotFixture("InTransitFromFactory"),
    probe: async (_, missing) => ({ args: [missing], error: ["BatchNotFound", [missing]] }),
    valid: async () => [1n],
    outcomes: {
      manufacturer: ({ manufacturer, distributor }) => succeeds("TransferCancelled", [1n, manufacturer, distributor]),
      distributor: ({ distributor }) => reverts("NotCustodian", [1n, distributor]),
    },
  },
  updateStatus: {
    fixture: () => lotFixture("StoredAtDistributor"),
    probe: async (_, missing) => ({ args: [missing, Status.InTransit], error: ["BatchNotFound", [missing]] }),
    valid: async () => [1n, Status.InTransit],
    outcomes: {
      distributor: ({ distributor }) => succeeds("StatusUpdated", [1n, Status.Stored, Status.InTransit, distributor]),
    },
  },
  markDelivered: {
    fixture: () => lotFixture("StoredAtPharmacy"),
    probe: async (_, missing) => ({ args: [missing], error: ["BatchNotFound", [missing]] }),
    valid: async () => [1n],
    outcomes: {
      retailer: ({ retailer }) => succeeds("StatusUpdated", [1n, Status.Stored, Status.Delivered, retailer]),
    },
  },
  issueCertificate: {
    fixture: () => lotFixture("Created"),
    probe: async (_, missing) => ({ args: [missing, CERTIFICATE], error: ["BatchNotFound", [missing]] }),
    valid: async () => [1n, CERTIFICATE],
    outcomes: {
      regulator: ({ regulator }) =>
        succeeds("CertificateIssued", [1n, regulator, CERTIFICATE.cid, CERTIFICATE.contentHash]),
    },
  },
  recallBatch: {
    fixture: () => lotFixture("Created"),
    probe: async (_, missing) => ({ args: [missing, REASON], error: ["BatchNotFound", [missing]] }),
    valid: async () => [1n, REASON],
    outcomes: {
      regulator: ({ regulator }) => succeeds("BatchRecalled", [1n, regulator, REASON]),
    },
  },
  anchorSensorLog: {
    fixture: () => lotFixture("Created"),
    probe: async (_, missing) => ({ args: [missing, SENSOR_LOG], error: ["BatchNotFound", [missing]] }),
    valid: async () => [1n, SENSOR_LOG],
    outcomes: {
      oracle: () => succeeds("SensorLogAnchored", [1n, 1, SENSOR_LOG.cid, SENSOR_LOG.contentHash]),
    },
  },
  reportExcursion: {
    fixture: () => lotFixture("Created"),
    // observedAt is fixed per cell so that the expected event can name it.
    probe: async (_, missing, observedAt) => ({
      args: [missing, 81, observedAt, SENSOR_LOG],
      error: ["BatchNotFound", [missing]],
    }),
    valid: async (_, observedAt) => [1n, 81, observedAt, SENSOR_LOG],
    outcomes: {
      oracle: (_, observedAt) =>
        succeeds("ExcursionReported", [1n, 1, 81, observedAt, SENSOR_LOG.cid, SENSOR_LOG.contentHash]),
    },
  },
};

/** The role error `account` gets from a function that accepts `roles`. */
function roleError(roles, account) {
  return roles.length === 1
    ? ["AccessControlUnauthorizedAccount", [account, ROLES[roles[0]]]]
    : ["MissingEitherRole", [account, ROLES[roles[0]], ROLES[roles[1]]]];
}

/** Everything the contract stores, for checking that a rejected call changed nothing. */
async function registryState(registry) {
  const total = await registry.totalBatches();
  return { total, lot: total > 0n ? await readBatch(registry, 1n) : null };
}

describe("Access control", function () {
  describe("role x function matrix", function () {
    for (const { name, roles } of WRITE_FUNCTIONS) {
      const spec = CASES[name];
      describe(`${name} (${roles.join(" or ")})`, function () {
        for (const actor of MATRIX_ACTORS) {
          const allowed = roles.includes(ACCOUNT_ROLES[actor]);
          const heldRole = ACCOUNT_ROLES[actor] ?? "no role";
          const title = allowed
            ? `the ${actor} (${heldRole}) gets past the role check`
            : `the ${actor} (${heldRole}) is rejected with ${roleError(roles, "")[0]} before any other check`;

          it(title, async function () {
            const { registry, accounts } = await loadFixture(spec.fixture());
            const caller = accounts[actor];
            const addresses = Object.fromEntries(Object.entries(accounts).map(([n, s]) => [n, s.address]));
            const missing = (await registry.totalBatches()) + 1n;
            const observedAt = await latestTimestamp();
            const probe = await spec.probe(addresses, missing, observedAt);
            const validArgs = await spec.valid(addresses, observedAt);
            const asCaller = registry.connect(caller);

            if (!allowed) {
              const [error, args] = roleError(roles, caller.address);
              const before = await registryState(registry);
              await expect(asCaller[name](...probe.args))
                .to.be.revertedWithCustomError(registry, error)
                .withArgs(...args);
              await expect(asCaller[name](...validArgs))
                .to.be.revertedWithCustomError(registry, error)
                .withArgs(...args);
              expect(await registryState(registry)).to.deep.equal(before);
              return;
            }

            const [probeError, probeArgs] = probe.error;
            await expect(asCaller[name](...probe.args))
              .to.be.revertedWithCustomError(registry, probeError)
              .withArgs(...probeArgs);

            const outcome = spec.outcomes[actor](addresses, observedAt);
            if (outcome.event !== undefined) {
              const tx = asCaller[name](...validArgs);
              await expect(tx)
                .to.emit(registry, outcome.event)
                .withArgs(...outcome.args);
              await expectOnlyEvent(tx, registry, outcome.event);
            } else {
              await expect(asCaller[name](...validArgs))
                .to.be.revertedWithCustomError(registry, outcome.error)
                .withArgs(...outcome.args);
            }
          });
        }
      });
    }
  });

  describe("roles that change after deployment", function () {
    it("lets an account granted MANUFACTURER_ROLE after deployment register a lot at once", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { regulator, newcomer } = accounts;
      const manufactureDate = (await latestTimestamp()) - 60n;
      await expect(registry.connect(newcomer).registerBatch(PRODUCT_HASH, manufactureDate, 20, 80, METADATA))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(newcomer.address, ROLES.MANUFACTURER);

      await (await registry.connect(regulator).grantRole(ROLES.MANUFACTURER, newcomer.address)).wait();

      await expect(registry.connect(newcomer).registerBatch(PRODUCT_HASH, manufactureDate, 20, 80, METADATA))
        .to.emit(registry, "BatchRegistered")
        .withArgs(1n, newcomer.address, PRODUCT_HASH, METADATA.cid);
      const record = await readBatch(registry, 1n);
      expect(record.manufacturer).to.equal(newcomer.address);
      expect(record.custodian).to.equal(newcomer.address);
    });

    it("lets an account granted DISTRIBUTOR_ROLE after deployment receive a hand-off at once", async function () {
      const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
      const { regulator, manufacturer, newcomer } = accounts;
      await expectRejected(
        registry,
        lot.id,
        () => registry.connect(manufacturer).initiateTransfer(lot.id, newcomer.address),
        "InvalidRecipient",
        [newcomer.address],
      );

      await (await registry.connect(regulator).grantRole(ROLES.DISTRIBUTOR, newcomer.address)).wait();

      await kit.openHandOff({ registry, accounts }, lot.id, manufacturer, newcomer);
      await expect(registry.connect(newcomer).acceptTransfer(lot.id))
        .to.emit(registry, "CustodyTransferred")
        .withArgs(lot.id, manufacturer.address, newcomer.address);
      expect((await readBatch(registry, lot.id)).custodian).to.equal(newcomer.address);
    });

    it("stops a revoked distributor from acting, keeps its lot with it, and still lets the regulator recall it", async function () {
      const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
      const { regulator, distributor, retailer } = accounts;
      await (await registry.connect(regulator).revokeRole(ROLES.DISTRIBUTOR, distributor.address)).wait();

      await expectRejected(
        registry,
        lot.id,
        () => registry.connect(distributor).initiateTransfer(lot.id, retailer.address),
        "MissingEitherRole",
        [distributor.address, ROLES.MANUFACTURER, ROLES.DISTRIBUTOR],
      );
      await expectRejected(
        registry,
        lot.id,
        () => registry.connect(distributor).updateStatus(lot.id, Status.InTransit),
        "AccessControlUnauthorizedAccount",
        [distributor.address, ROLES.DISTRIBUTOR],
      );

      const before = await readBatch(registry, lot.id);
      expect(before.custodian).to.equal(distributor.address);
      await expect(registry.connect(regulator).recallBatch(lot.id, REASON))
        .to.emit(registry, "BatchRecalled")
        .withArgs(lot.id, regulator.address, REASON);
      expect(await readBatch(registry, lot.id)).to.deep.equal({ ...before, status: Status.Recalled });
    });

    it("stops a revoked recipient from accepting, and lets the custodian cancel and re-route the lot", async function () {
      const { registry, accounts, lot } = await loadFixture(lotFixture("InTransitFromFactory"));
      const { regulator, manufacturer, distributor, secondDistributor } = accounts;
      await (await registry.connect(regulator).revokeRole(ROLES.DISTRIBUTOR, distributor.address)).wait();

      await expectRejected(
        registry,
        lot.id,
        () => registry.connect(distributor).acceptTransfer(lot.id),
        "MissingEitherRole",
        [distributor.address, ROLES.DISTRIBUTOR, ROLES.RETAILER],
      );
      await expect(registry.connect(manufacturer).cancelTransfer(lot.id))
        .to.emit(registry, "TransferCancelled")
        .withArgs(lot.id, manufacturer.address, distributor.address);
      await kit.openHandOff({ registry, accounts }, lot.id, manufacturer, secondDistributor);
      await expect(registry.connect(secondDistributor).acceptTransfer(lot.id))
        .to.emit(registry, "CustodyTransferred")
        .withArgs(lot.id, manufacturer.address, secondDistributor.address);
    });

    it("stops a revoked manufacturer from registering, and its earlier lots keep it as their origin", async function () {
      const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
      const { regulator, manufacturer } = accounts;
      await (await registry.connect(regulator).revokeRole(ROLES.MANUFACTURER, manufacturer.address)).wait();

      await expect(
        registry
          .connect(manufacturer)
          .registerBatch(PRODUCT_HASH, (await latestTimestamp()) - 60n, 20, 80, METADATA),
      )
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(manufacturer.address, ROLES.MANUFACTURER);
      expect((await readBatch(registry, lot.id)).manufacturer).to.equal(manufacturer.address);
      expect(await registry.totalBatches()).to.equal(1n);
    });

    it("stops a revoked oracle from reporting, while lots stay open to a newly appointed oracle", async function () {
      const { registry, accounts, lot } = await loadFixture(lotFixture("Created"));
      const { regulator, oracle, newcomer } = accounts;
      await (await registry.connect(regulator).revokeRole(ROLES.ORACLE, oracle.address)).wait();
      await (await registry.connect(regulator).grantRole(ROLES.ORACLE, newcomer.address)).wait();
      const observedAt = await latestTimestamp();

      await expectRejected(
        registry,
        lot.id,
        () => registry.connect(oracle).reportExcursion(lot.id, 81, observedAt, SENSOR_LOG),
        "AccessControlUnauthorizedAccount",
        [oracle.address, ROLES.ORACLE],
      );
      await expect(registry.connect(newcomer).anchorSensorLog(lot.id, SENSOR_LOG))
        .to.emit(registry, "SensorLogAnchored")
        .withArgs(lot.id, 1, SENSOR_LOG.cid, SENSOR_LOG.contentHash);
    });

    it("lets a wallet that holds two roles use the functions of both", async function () {
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const { regulator, distributor, secondDistributor } = accounts;
      await (await registry.connect(regulator).grantRole(ROLES.MANUFACTURER, distributor.address)).wait();
      const ctx = { registry, accounts };

      const { id } = await kit.registerLot(ctx, { by: distributor });
      await kit.openHandOff(ctx, id, distributor, secondDistributor);
      await kit.acceptHandOff(ctx, id, secondDistributor);
      await kit.setStatus(ctx, id, secondDistributor, Status.InTransit);

      const record = await readBatch(registry, id);
      expect(record.manufacturer).to.equal(distributor.address);
      expect(record.custodian).to.equal(secondDistributor.address);
      expect(record.status).to.equal(Status.InTransit);
    });
  });

  describe("the one check before the role check", function () {
    it("rejects an out-of-range Status in the ABI decoder, even for an account without DISTRIBUTOR_ROLE", async function () {
      // Solidity decodes the arguments before any modifier runs, so this call
      // reverts with empty data instead of the role error. The interface
      // documents it; role tests therefore always pass a valid Status.
      const { registry, accounts, lot } = await loadFixture(lotFixture("StoredAtDistributor"));
      await expect(registry.connect(accounts.outsider).updateStatus(lot.id, 6)).to.be.revertedWithoutReason();
      await expect(registry.connect(accounts.outsider).updateStatus(lot.id, Status.InTransit))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(accounts.outsider.address, ROLES.DISTRIBUTOR);
    });
  });
});
