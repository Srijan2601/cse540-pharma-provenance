// Shared code for the ProvenanceRegistry unit tests (test/unit/*.test.js).
//
// It holds three kinds of things:
//   1. Constants that mirror the contract's API: the Status enum, the role
//      names and hashes, and which roles each write function accepts.
//   2. Synthetic test data: product hashes and IPFS document references built
//      from made-up labels. No real product, lot, key or personal data is used.
//   3. createRegistryKit(connection): fixtures and helpers bound to one test
//      file's network connection. Every lot state is reached through real
//      contract calls, never by writing storage, so a helper that builds a
//      state also exercises the transitions that lead to it.
//
// Accounts are the in-process node's unlocked accounts (ethers.getSigners()).
// Mocha loads every .js file under test/, including this one. The module only
// defines code, so loading it registers no tests.
import { expect } from "chai";
import { AbiCoder, ZeroAddress, ZeroHash, id, keccak256, toUtf8Bytes } from "ethers";
import { documentRef } from "../../scripts/lib/cid.js";
import { decodeDeclaredError } from "./common.js";

// =====================================================================
//                     CONSTANTS THAT MIRROR THE CONTRACT
// =====================================================================

/** Must match the order of `enum Status` in IProvenanceRegistry.sol. */
export const Status = Object.freeze({
  Created: 0,
  InTransit: 1,
  Stored: 2,
  Delivered: 3,
  Compromised: 4,
  Recalled: 5,
});

/** Status names indexed by enum value, for readable test titles and messages. */
export const STATUS_NAMES = Object.freeze(Object.keys(Status));

/** Statuses in which a lot is still moving through the supply chain. */
export const ACTIVE_STATUSES = Object.freeze([Status.Created, Status.InTransit, Status.Stored]);

/** Statuses that end the custody flow (Delivered, Compromised, Recalled). */
export const TERMINAL_STATUSES = Object.freeze([Status.Delivered, Status.Compromised, Status.Recalled]);

/** Role constant names as declared in RegistryBase.sol. */
export const ROLE_NAMES = Object.freeze({
  REGULATOR: "REGULATOR_ROLE",
  MANUFACTURER: "MANUFACTURER_ROLE",
  DISTRIBUTOR: "DISTRIBUTOR_ROLE",
  RETAILER: "RETAILER_ROLE",
  ORACLE: "ORACLE_ROLE",
});

/**
 * Role identifiers computed independently of the contract (keccak256 of the
 * name; DEFAULT_ADMIN_ROLE is bytes32(0) in OpenZeppelin), so a test that
 * compares them with the contract's constants checks the contract, not itself.
 */
export const ROLES = Object.freeze({
  DEFAULT_ADMIN: ZeroHash,
  ...Object.fromEntries(Object.entries(ROLE_NAMES).map(([key, name]) => [key, id(name)])),
});

/**
 * Every state-changing function of the registry (besides the inherited role
 * administration), the roles it accepts in the order its error names them,
 * and the one registry event a successful call emits.
 */
export const WRITE_FUNCTIONS = Object.freeze([
  { name: "registerBatch", roles: ["MANUFACTURER"], event: "BatchRegistered" },
  { name: "initiateTransfer", roles: ["MANUFACTURER", "DISTRIBUTOR"], event: "TransferInitiated" },
  { name: "acceptTransfer", roles: ["DISTRIBUTOR", "RETAILER"], event: "CustodyTransferred" },
  { name: "cancelTransfer", roles: ["MANUFACTURER", "DISTRIBUTOR"], event: "TransferCancelled" },
  { name: "updateStatus", roles: ["DISTRIBUTOR"], event: "StatusUpdated" },
  { name: "markDelivered", roles: ["RETAILER"], event: "StatusUpdated" },
  { name: "issueCertificate", roles: ["REGULATOR"], event: "CertificateIssued" },
  { name: "recallBatch", roles: ["REGULATOR"], event: "BatchRecalled" },
  { name: "anchorSensorLog", roles: ["ORACLE"], event: "SensorLogAnchored" },
  { name: "reportExcursion", roles: ["ORACLE"], event: "ExcursionReported" },
]);

/**
 * The seven actors of the access-control matrix: the five roles of proposal
 * Table I, an account with no role, and the deployer (which the constructor
 * deliberately leaves without a role).
 */
export const MATRIX_ACTORS = Object.freeze([
  "regulator",
  "manufacturer",
  "distributor",
  "retailer",
  "oracle",
  "outsider",
  "deployer",
]);

/** The role each fixture account holds after onboarding (null = no role). */
export const ACCOUNT_ROLES = Object.freeze({
  deployer: null,
  regulator: "REGULATOR",
  manufacturer: "MANUFACTURER",
  distributor: "DISTRIBUTOR",
  retailer: "RETAILER",
  oracle: "ORACLE",
  outsider: null,
  secondManufacturer: "MANUFACTURER",
  secondDistributor: "DISTRIBUTOR",
  secondRetailer: "RETAILER",
  newcomer: null,
});

/** Typical cold-chain range: 2.0 C to 8.0 C, in tenths of a degree (design decision C7). */
export const DEFAULT_RANGE = Object.freeze({ min: 20, max: 80 });

/** int16 bounds, the full range a temperature field can hold. */
export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

/** Largest uint64, the widest timestamp the ABI accepts. */
export const UINT64_MAX = 2n ** 64n - 1n;

// =====================================================================
//                            SYNTHETIC TEST DATA
// =====================================================================

/** The value of a DocumentRef that was never set (no certificate, no sensor log yet). */
export const EMPTY_DOCUMENT = Object.freeze({ cid: "", contentHash: ZeroHash });

/**
 * productHash as the dApp computes it: keccak256(abi.encode(productCode,
 * lotNumber)) (design decision C5).
 */
export function makeProductHash(productCode, lotNumber) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["string", "string"], [productCode, lotNumber]));
}

/**
 * A synthetic off-chain document and the DocumentRef that points to it.
 * The bytes are a small JSON object built from `label`. The reference is
 * built the way design decision O1 prescribes: `cid` is the real CIDv1 of
 * those bytes ("bafkrei...", computed by scripts/lib/cid.js, which
 * test/tooling/cid.test.js pins to the CIDs IPFS itself produces) and
 * `contentHash` is keccak256 of the same bytes. Different labels give
 * different references, so tests can tell documents apart.
 */
export function makeDocument(label) {
  return documentRef(toUtf8Bytes(JSON.stringify({ synthetic: true, label })));
}

// =====================================================================
//                       READING AND CHECKING RECORDS
// =====================================================================

/**
 * verifyBatch(batchId) as a plain object with fixed JavaScript types: bigint
 * for uint256/uint64, number for the enum and the small integers, and
 * {cid, contentHash} objects for the documents. Two snapshots of the same
 * record can then be compared with deep equality.
 */
export async function readBatch(registry, batchId) {
  const record = await registry.verifyBatch(batchId);
  const document = (ref) => ({ cid: ref.cid, contentHash: ref.contentHash });
  return {
    id: record.id,
    productHash: record.productHash,
    manufacturer: record.manufacturer,
    manufactureDate: record.manufactureDate,
    registeredAt: record.registeredAt,
    custodian: record.custodian,
    pendingCustodian: record.pendingCustodian,
    status: Number(record.status),
    minTempTenthsC: Number(record.minTempTenthsC),
    maxTempTenthsC: Number(record.maxTempTenthsC),
    sensorLogCount: Number(record.sensorLogCount),
    metadata: document(record.metadata),
    certificate: document(record.certificate),
    latestSensorLog: document(record.latestSensorLog),
  };
}

/** Every lot in the registry, in ID order (IDs 1..totalBatches()). */
export async function readAllBatches(registry) {
  const total = await registry.totalBatches();
  const lots = [];
  for (let batchId = 1n; batchId <= total; batchId++) lots.push(await readBatch(registry, batchId));
  return lots;
}

/**
 * Assert that `tx` emitted exactly one event from the registry, named
 * `eventName` ("each successful write emits exactly one registry event").
 * Pair it with `.to.emit(...).withArgs(...)`, which checks the arguments but
 * would also pass if further events were emitted.
 */
export async function expectOnlyEvent(tx, registry, eventName) {
  const receipt = await (await tx).wait();
  const registryAddress = (await registry.getAddress()).toLowerCase();
  const names = receipt.logs
    .filter((log) => log.address.toLowerCase() === registryAddress)
    .map((log) => registry.interface.parseLog(log)?.name);
  expect(names, "events emitted by the registry").to.deep.equal([eventName]);
}

/**
 * Assert that `send()` reverts with the custom error `errorName(...args)` and
 * leaves lot `batchId` exactly as it was. `send` is a function so that the
 * record is read before the transaction is sent.
 */
export async function expectRejected(registry, batchId, send, errorName, args = []) {
  const before = await readBatch(registry, batchId);
  await expect(send())
    .to.be.revertedWithCustomError(registry, errorName)
    .withArgs(...args);
  expect(await readBatch(registry, batchId), `lot ${batchId} must not change`).to.deep.equal(before);
}

/**
 * The custom error a failed call reverted with, as [name, args] with every
 * argument converted to a string (so bigints, numbers and addresses compare
 * by value). Fails the test if the call did not revert with a custom error
 * that the registry's ABI declares.
 */
export async function rejectionOf(registry, send) {
  let failure;
  try {
    await (await send()).wait();
  } catch (error) {
    failure = error;
  }
  expect(failure, "the call must revert").to.not.equal(undefined);
  const decoded = decodeDeclaredError(registry, failure.data);
  if (decoded === null) throw failure; // not a registry custom error: show the original failure
  return [decoded.name, decoded.args.map(String)];
}

/**
 * Like expectRejected, for a call that breaks two rules whose check order
 * the API leaves open (the reverts that contracts/README.md lists without an
 * order): the call must revert with one of
 * `alternatives` ([errorName, args] pairs) and leave lot `batchId` unchanged.
 */
export async function expectRejectedWithAnyOf(registry, batchId, send, alternatives) {
  const before = await readBatch(registry, batchId);
  const rejection = await rejectionOf(registry, send);
  const allowed = alternatives.map(([name, args]) => [name, args.map(String)]);
  expect(allowed, "the error must be one of the allowed ones").to.deep.include(rejection);
  expect(await readBatch(registry, batchId), `lot ${batchId} must not change`).to.deep.equal(before);
}

/**
 * The status changes a single transaction can make (the transitions listed on
 * IProvenanceRegistry.Status). Recalled has none: it is absorbing (I5).
 */
const STATUS_EDGES = Object.freeze({
  [Status.Created]: [Status.InTransit, Status.Compromised, Status.Recalled],
  [Status.InTransit]: [Status.Stored, Status.Created, Status.Compromised, Status.Recalled],
  [Status.Stored]: [Status.InTransit, Status.Delivered, Status.Compromised, Status.Recalled],
  [Status.Delivered]: [Status.Recalled],
  [Status.Compromised]: [Status.Recalled],
  [Status.Recalled]: [],
});

/** Record fields that registerBatch sets once and no function changes afterwards. */
const FIXED_FIELDS = [
  "id",
  "productHash",
  "manufacturer",
  "manufactureDate",
  "registeredAt",
  "minTempTenthsC",
  "maxTempTenthsC",
  "metadata",
];

/**
 * Check the storage invariants documented in RegistryBase.sol on every lot,
 * and return the lots it read so that the caller can pass them back in as
 * `previousLots` after the next transaction.
 *
 *   I1  pendingCustodian != 0  implies  status == InTransit
 *   I2  status terminal        implies  pendingCustodian == 0
 *   I3  IDs are exactly 1..totalBatches(); batchIdOf(productHash) is the lot's ID
 *   I4  custodian and manufacturer are never zero
 *   I5  (needs `previousLots`) Recalled stays Recalled; Delivered and
 *       Compromised can only stay or become Recalled
 *
 * It also checks two properties that follow from the custody rules rather
 * than being numbered invariants of the contract:
 *   - a Created lot is still with its manufacturer: custody only moves in
 *     acceptTransfer, which sets Stored, and cancelTransfer only restores
 *     Created for a hand-off that never moved custody;
 *   - (needs `previousLots`) every status change is one edge of the state
 *     machine documented on IProvenanceRegistry.Status.
 *
 * With `previousLots` it also checks that no lot disappeared, that the
 * fields fixed at registration did not change, and that sensorLogCount never
 * went down. `previousLots` must be the lots read just before ONE
 * transaction, because the edge check compares single steps.
 */
export async function expectInvariants(registry, previousLots = []) {
  const total = await registry.totalBatches();
  const lots = await readAllBatches(registry);

  // I3: nothing exists outside 1..total. ID 0 never exists.
  await expect(registry.verifyBatch(0n)).to.be.revertedWithCustomError(registry, "BatchNotFound").withArgs(0n);
  await expect(registry.verifyBatch(total + 1n))
    .to.be.revertedWithCustomError(registry, "BatchNotFound")
    .withArgs(total + 1n);

  for (const [index, lot] of lots.entries()) {
    const where = `lot ${index + 1}`;
    // I3: the record at position n carries ID n, and its hash maps back to it.
    expect(lot.id, `${where}: id`).to.equal(BigInt(index + 1));
    expect(await registry.batchIdOf(lot.productHash), `${where}: batchIdOf`).to.equal(lot.id);
    // I1 and I2.
    if (lot.pendingCustodian !== ZeroAddress) {
      expect(STATUS_NAMES[lot.status], `${where}: I1 (open hand-off implies InTransit)`).to.equal("InTransit");
    }
    if (TERMINAL_STATUSES.includes(lot.status)) {
      expect(lot.pendingCustodian, `${where}: I2 (terminal lot has no hand-off)`).to.equal(ZeroAddress);
    }
    // I4.
    expect(lot.custodian, `${where}: I4 custodian`).to.not.equal(ZeroAddress);
    expect(lot.manufacturer, `${where}: I4 manufacturer`).to.not.equal(ZeroAddress);
    // Derived from the custody rules (see above).
    if (lot.status === Status.Created) {
      expect(lot.custodian, `${where}: a Created lot is still with its manufacturer`).to.equal(lot.manufacturer);
    }
  }

  expect(lots.length, "lots are never removed").to.be.at.least(previousLots.length);
  for (const [index, before] of previousLots.entries()) {
    const after = lots[index];
    const where = `lot ${index + 1}`;
    const from = STATUS_NAMES[before.status];
    const to = STATUS_NAMES[after.status];
    // I5.
    if (before.status === Status.Recalled) {
      expect(to, `${where}: I5 (Recalled is absorbing)`).to.equal("Recalled");
    } else if (before.status === Status.Delivered || before.status === Status.Compromised) {
      expect([from, "Recalled"], `${where}: I5 (${from} can only become Recalled)`).to.include(to);
    }
    // Derived from the state machine (see above).
    if (after.status !== before.status) {
      const edges = STATUS_EDGES[before.status].map((status) => STATUS_NAMES[status]);
      expect(edges, `${where}: ${from} -> ${to} must be an edge of the state machine`).to.include(to);
    }
    for (const field of FIXED_FIELDS) {
      expect(after[field], `${where}: ${field} is fixed at registration`).to.deep.equal(before[field]);
    }
    expect(after.sensorLogCount, `${where}: sensorLogCount never decreases`).to.be.at.least(before.sensorLogCount);
  }
  return lots;
}

// =====================================================================
//                               LOT STATES
// =====================================================================

/**
 * Every state a lot can be in, as the state-machine tests enumerate them.
 * InTransit appears three times because its behaviour depends on whether a
 * hand-off is open, and on whether the open hand-off started at Created
 * (cancelling restores Created) or at Stored (cancelling restores Stored).
 * Lots in Compromised and Recalled are held by the distributor: of the
 * fixture's custodians it is the one that holds a custody role (it can call
 * initiateTransfer, cancelTransfer and updateStatus), so its calls reach the
 * status checks instead of failing the role check.
 */
export const LOT_STATES = Object.freeze([
  { key: "Created", status: Status.Created, label: "Created (at the manufacturer)" },
  {
    key: "InTransitFromFactory",
    status: Status.InTransit,
    label: "InTransit with an open hand-off manufacturer -> distributor",
  },
  {
    key: "InTransitToPharmacy",
    status: Status.InTransit,
    label: "InTransit with an open hand-off distributor -> pharmacy",
  },
  { key: "InTransitMoving", status: Status.InTransit, label: "InTransit without a hand-off (distributor moving it)" },
  { key: "StoredAtDistributor", status: Status.Stored, label: "Stored at the distributor" },
  { key: "StoredAtPharmacy", status: Status.Stored, label: "Stored at the pharmacy" },
  { key: "Delivered", status: Status.Delivered, label: "Delivered (by the pharmacy)" },
  { key: "Compromised", status: Status.Compromised, label: "Compromised (excursion while at the distributor)" },
  { key: "Recalled", status: Status.Recalled, label: "Recalled (while at the distributor)" },
]);

// =====================================================================
//                     FIXTURES AND HELPERS PER CONNECTION
// =====================================================================

/**
 * Build the fixtures and helpers for one network connection.
 *
 * Call it once at the top of a test file, with the `ethers` and
 * `networkHelpers` that the file's `network.create()` returned. loadFixture
 * recognises a fixture by function identity, so the functions created here
 * must be reused for the whole file.
 *
 * Lot helpers take the fixture context `ctx` ({ registry, accounts }) and
 * return plain data; the action helpers wait for each transaction to be
 * mined, so a test can rely on the new state as soon as they return.
 */
export function createRegistryKit({ ethers, networkHelpers }) {
  /**
   * Deploy a registry with a dedicated regulator, then let the regulator
   * onboard the organizations (data flow 4, "Oversee"). The deployer is a
   * different account and keeps no role. `outsider` and `newcomer` never get
   * a role here; tests grant one to `newcomer` when they need an account
   * that joins after deployment.
   */
  async function deployRegistryFixture() {
    const [
      deployer,
      regulator,
      manufacturer,
      distributor,
      retailer,
      oracle,
      outsider,
      secondManufacturer,
      secondDistributor,
      secondRetailer,
      newcomer,
    ] = await ethers.getSigners();
    const accounts = {
      deployer,
      regulator,
      manufacturer,
      distributor,
      retailer,
      oracle,
      outsider,
      secondManufacturer,
      secondDistributor,
      secondRetailer,
      newcomer,
    };

    const registry = await ethers.deployContract("ProvenanceRegistry", [regulator.address], deployer);
    await registry.waitForDeployment();

    for (const [name, role] of Object.entries(ACCOUNT_ROLES)) {
      if (role === null || role === "REGULATOR") continue;
      await (await registry.connect(regulator).grantRole(ROLES[role], accounts[name].address)).wait();
    }
    return { registry, accounts };
  }

  /** Timestamp of the latest block, as a bigint (the type the contract's uint64 fields come back as). */
  async function latestTimestamp() {
    return BigInt(await networkHelpers.time.latest());
  }

  /** Timestamp of the block that mined `tx`. */
  async function blockTimestampOf(tx) {
    const receipt = await (await tx).wait();
    return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
  }

  /**
   * Register a lot with valid arguments, overridable one by one. The default
   * product hash is derived from the next lot ID, so it is new in any
   * registry state and the same in every run.
   * @returns the new lot's ID and the arguments it was registered with
   */
  async function registerLot(ctx, overrides = {}) {
    const { registry, accounts } = ctx;
    const nextId = (await registry.totalBatches()) + 1n;
    const args = {
      by: accounts.manufacturer,
      productHash: makeProductHash("NDC-0000-0000-00", `LOT-TEST-${nextId}`),
      manufactureDate: (await latestTimestamp()) - 86_400n,
      min: DEFAULT_RANGE.min,
      max: DEFAULT_RANGE.max,
      metadata: makeDocument(`lot metadata ${nextId}`),
      ...overrides,
    };
    await (
      await registry
        .connect(args.by)
        .registerBatch(args.productHash, args.manufactureDate, args.min, args.max, args.metadata)
    ).wait();
    return { id: await registry.totalBatches(), ...args };
  }

  // Thin wrappers around the write functions, used to build states. Tests of
  // a function itself call the contract directly instead.

  async function openHandOff(ctx, batchId, from, to) {
    await (await ctx.registry.connect(from).initiateTransfer(batchId, to.address)).wait();
  }

  async function acceptHandOff(ctx, batchId, by) {
    await (await ctx.registry.connect(by).acceptTransfer(batchId)).wait();
  }

  async function cancelHandOff(ctx, batchId, by) {
    await (await ctx.registry.connect(by).cancelTransfer(batchId)).wait();
  }

  async function setStatus(ctx, batchId, by, newStatus) {
    await (await ctx.registry.connect(by).updateStatus(batchId, newStatus)).wait();
  }

  async function deliver(ctx, batchId, by) {
    await (await ctx.registry.connect(by).markDelivered(batchId)).wait();
  }

  async function anchorLog(ctx, batchId, sensorLog = makeDocument(`sensor log for lot ${batchId}`)) {
    await (await ctx.registry.connect(ctx.accounts.oracle).anchorSensorLog(batchId, sensorLog)).wait();
  }

  /** Report an excursion one tenth of a degree above the lot's maximum, observed in the latest block. */
  async function flagExcursion(ctx, batchId) {
    const { maxTempTenthsC } = await readBatch(ctx.registry, batchId);
    const observedAt = await latestTimestamp();
    const sensorLog = makeDocument(`excursion log for lot ${batchId}`);
    await (
      await ctx.registry.connect(ctx.accounts.oracle).reportExcursion(batchId, maxTempTenthsC + 1, observedAt, sensorLog)
    ).wait();
  }

  async function recall(ctx, batchId, reason = "synthetic recall for testing") {
    await (await ctx.registry.connect(ctx.accounts.regulator).recallBatch(batchId, reason)).wait();
  }

  async function certify(ctx, batchId, certificate = makeDocument(`certificate for lot ${batchId}`)) {
    await (await ctx.registry.connect(ctx.accounts.regulator).issueCertificate(batchId, certificate)).wait();
  }

  /**
   * Register a lot and move it into the state named by `key` (see
   * LOT_STATES), using only the calls a real journey would make.
   * @returns { id, key, status, custodian, pending } where custodian and
   *          pending are signers (pending is null when no hand-off is open)
   */
  async function lotIn(ctx, key) {
    const { manufacturer, distributor, retailer } = ctx.accounts;
    const state = LOT_STATES.find((s) => s.key === key);
    if (state === undefined) throw new Error(`unknown lot state "${key}"`);
    const lot = (id, custodian, pending = null) => ({ id, key, status: state.status, custodian, pending });

    switch (key) {
      case "Created": {
        const { id } = await registerLot(ctx);
        return lot(id, manufacturer);
      }
      case "InTransitFromFactory": {
        const { id } = await lotIn(ctx, "Created");
        await openHandOff(ctx, id, manufacturer, distributor);
        return lot(id, manufacturer, distributor);
      }
      case "StoredAtDistributor": {
        const { id } = await lotIn(ctx, "InTransitFromFactory");
        await acceptHandOff(ctx, id, distributor);
        return lot(id, distributor);
      }
      case "InTransitToPharmacy": {
        const { id } = await lotIn(ctx, "StoredAtDistributor");
        await openHandOff(ctx, id, distributor, retailer);
        return lot(id, distributor, retailer);
      }
      case "InTransitMoving": {
        const { id } = await lotIn(ctx, "StoredAtDistributor");
        await setStatus(ctx, id, distributor, Status.InTransit);
        return lot(id, distributor);
      }
      case "StoredAtPharmacy": {
        const { id } = await lotIn(ctx, "InTransitToPharmacy");
        await acceptHandOff(ctx, id, retailer);
        return lot(id, retailer);
      }
      case "Delivered": {
        const { id } = await lotIn(ctx, "StoredAtPharmacy");
        await deliver(ctx, id, retailer);
        return lot(id, retailer);
      }
      case "Compromised": {
        const { id } = await lotIn(ctx, "StoredAtDistributor");
        await flagExcursion(ctx, id);
        return lot(id, distributor);
      }
      case "Recalled": {
        const { id } = await lotIn(ctx, "StoredAtDistributor");
        await recall(ctx, id);
        return lot(id, distributor);
      }
    }
  }

  // One fixture per lot state, created on first use and then reused, so
  // loadFixture can snapshot it. A lot fixture deploys its own registry
  // instead of calling loadFixture(deployRegistryFixture): a nested
  // loadFixture would restore an older snapshot underneath the outer one and
  // leave the outer fixture's snapshot list pointing at discarded snapshots.
  const lotFixtures = new Map();

  /**
   * A named fixture function (as loadFixture requires) that deploys and
   * onboards a registry and puts one lot, ID 1, into state `key`.
   * Resolves to { registry, accounts, lot }.
   */
  function lotFixture(key) {
    if (!lotFixtures.has(key)) {
      const fixture = async function deployWithOneLotFixture() {
        const ctx = await deployRegistryFixture();
        return { ...ctx, lot: await lotIn(ctx, key) };
      };
      lotFixtures.set(key, fixture);
    }
    return lotFixtures.get(key);
  }

  return {
    deployRegistryFixture,
    lotFixture,
    loadFixture: networkHelpers.loadFixture,
    latestTimestamp,
    blockTimestampOf,
    registerLot,
    lotIn,
    openHandOff,
    acceptHandOff,
    cancelHandOff,
    setStatus,
    deliver,
    anchorLog,
    flagExcursion,
    recall,
    certify,
  };
}
