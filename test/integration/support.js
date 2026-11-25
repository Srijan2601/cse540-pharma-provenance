// Shared helpers for the integration journeys in test/integration/.
//
// The journeys use the registry the way its clients will: the dApp and the
// oracle send signed writes, and the patient verify page reads the lot record
// and rebuilds the lot's history from event logs over read-only RPC. This
// module holds what more than one journey needs: deployment and onboarding,
// an in-memory IPFS stand-in, the paged log reader, a pure event reducer, and
// small action helpers.
//
// It depends only on the contract's public API (ABI, events, errors). It uses
// no unit-test fixtures; the only shared code it imports is the generic
// custom-error decoder in test/helpers/common.js and the CID helper in
// scripts/lib/cid.js, which test/tooling/cid.test.js pins to real IPFS CIDs.
// Mocha loads every .js file under test/, this one included, but it declares
// no tests.
import { expect } from "chai";
import { AbiCoder, getBytes, keccak256, toBeHex, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers";
import { rawCidV1 } from "../../scripts/lib/cid.js";
import { decodeDeclaredError } from "../helpers/common.js";

/** Lot statuses in the order of `enum Status`. ethers decodes a uint8 enum as a bigint. */
export const Status = Object.freeze({
  Created: 0n,
  InTransit: 1n,
  Stored: 2n,
  Delivered: 3n,
  Compromised: 4n,
  Recalled: 5n,
});

/**
 * The registry's own events, one per successful write: the eight of proposal
 * Fig. 1 plus TransferCancelled (design decision C3). Everything else the
 * contract can emit comes from OpenZeppelin AccessControl (RoleGranted,
 * RoleRevoked, RoleAdminChanged).
 */
export const REGISTRY_EVENTS = Object.freeze([
  "BatchRegistered",
  "TransferInitiated",
  "CustodyTransferred",
  "TransferCancelled",
  "StatusUpdated",
  "CertificateIssued",
  "SensorLogAnchored",
  "ExcursionReported",
  "BatchRecalled",
]);

/** A synthetic product code (no real product). Lots differ by lot number. */
export const PRODUCT_CODE = "NDC-0000-0000-00";

/** What an unset DocumentRef looks like in a record (no certificate yet, no log yet). */
export const EMPTY_DOCUMENT = Object.freeze({ cid: "", contentHash: ZeroHash });

/** productHash = keccak256(abi.encode(productCode, lotNumber)), computed off-chain (design decision C5). */
export function productHashOf(productCode, lotNumber) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["string", "string"], [productCode, lotNumber]));
}

// =========================================================================
//                         DEPLOYMENT AND ROLES
// =========================================================================

/**
 * Deploy a fresh registry with `regulator` as its admin, and name the
 * accounts of the in-process chain after the organizations of proposal
 * Table I. No role is granted yet. The patient has no account: the verify
 * page reads without a wallet.
 *
 * The accounts are taken in the same order as in the unit-test fixture
 * (test/helpers/registry.js), so a given test account plays the same part in
 * both suites: there `secondManufacturer` and `secondDistributor`, here
 * `manufacturerB` and `distributorB`.
 */
export async function deployRegistry(ethers) {
  const [deployer, regulator, manufacturer, distributorA, pharmacy, oracle, outsider, manufacturerB, distributorB] =
    await ethers.getSigners();
  const registry = await ethers.deployContract("ProvenanceRegistry", [regulator.address]);
  const deployBlock = (await registry.deploymentTransaction().wait()).blockNumber;

  const roles = {
    REGULATOR: await registry.REGULATOR_ROLE(),
    MANUFACTURER: await registry.MANUFACTURER_ROLE(),
    DISTRIBUTOR: await registry.DISTRIBUTOR_ROLE(),
    RETAILER: await registry.RETAILER_ROLE(),
    ORACLE: await registry.ORACLE_ROLE(),
  };
  const actors = { deployer, regulator, manufacturer, distributorA, distributorB, pharmacy, oracle, outsider, manufacturerB };
  return { registry, roles, actors, deployBlock, provider: ethers.provider };
}

/** The onboarding of data flow 4: which organization gets which role. */
export function onboardingPlan({ roles, actors }) {
  return [
    [roles.MANUFACTURER, actors.manufacturer],
    [roles.DISTRIBUTOR, actors.distributorA],
    [roles.DISTRIBUTOR, actors.distributorB],
    [roles.RETAILER, actors.pharmacy],
    [roles.ORACLE, actors.oracle],
  ];
}

/** Deploy, then let the regulator onboard every organization in `onboardingPlan`. */
export async function deployOnboardedRegistry(ethers) {
  const context = await deployRegistry(ethers);
  for (const [role, account] of onboardingPlan(context)) {
    await (await context.registry.connect(context.actors.regulator).grantRole(role, account.address)).wait();
  }
  return context;
}

// =========================================================================
//                            IPFS STAND-IN
// =========================================================================

/**
 * In-memory stand-in for IPFS and a gateway. The CIDs it hands out are the
 * ones `ipfs add --cid-version=1` returns for a small file (CIDv1, raw codec,
 * sha2-256, "bafkrei..."), computed by scripts/lib/cid.js. Note that a CID is
 * built from sha2-256, not from the keccak256 the registry stores next to it
 * (design decision O1). `add` returns the DocumentRef the registry stores
 * ({cid, contentHash}), and `cat` returns the bytes a gateway would serve for
 * a CID. `tamper` makes the gateway serve other bytes
 * for a CID, to show that the on-chain hash catches it. Create one per test,
 * because a fixture's return value is reused across tests while only the
 * chain state is reset.
 */
export class FakeIpfs {
  #files = new Map();

  add(content) {
    const bytes = typeof content === "string" ? toUtf8Bytes(content) : getBytes(content);
    const cid = rawCidV1(bytes);
    this.#files.set(cid, bytes);
    return { cid, contentHash: keccak256(bytes) };
  }

  /** Serialize once and upload those exact bytes: re-serializing could change them (O1). */
  addJson(document) {
    return this.add(JSON.stringify(document));
  }

  cat(cid) {
    const bytes = this.#files.get(cid);
    if (bytes === undefined) throw new Error(`IPFS stand-in: no file for CID ${cid}`);
    return bytes;
  }

  tamper(cid, content) {
    this.#files.set(cid, typeof content === "string" ? toUtf8Bytes(content) : getBytes(content));
  }
}

/**
 * The verify page's file check (data flow 5): download the file named by the
 * on-chain CID and compare keccak256 of the downloaded bytes with the
 * on-chain content hash.
 */
export function documentMatches(ipfs, documentRef) {
  return keccak256(ipfs.cat(documentRef.cid)) === documentRef.contentHash;
}

// =========================================================================
//                          WRITES AND REVERTS
// =========================================================================

/** A decoded event as a plain object: its name plus every argument by name, for deep equality. */
export function toPlain(parsedLog) {
  const plain = { name: parsedLog.name };
  parsedLog.fragment.inputs.forEach((input, index) => {
    plain[input.name] = parsedLog.args[index];
  });
  return plain;
}

/**
 * Send one write and wait for it. Asserts the "one event per write" rule: the
 * receipt holds exactly one log, and it is a registry event. Returns that
 * event as a plain object, plus the receipt.
 */
export async function sendWrite(registry, txPromise) {
  const receipt = await (await txPromise).wait();
  expect(receipt.logs, "a successful write must emit exactly one event").to.have.length(1);
  const parsed = registry.interface.parseLog(receipt.logs[0]);
  expect(REGISTRY_EVENTS, "a successful write must emit a registry event").to.include(parsed?.name);
  return { event: toPlain(parsed), receipt };
}

/**
 * The custom error a rejected write reverted with, as { name, args }.
 * Rethrows anything that is not a revert with one of the custom errors the
 * registry's ABI declares: a panic, a revert string, or a mistake in the test
 * itself cannot pass for an expected rejection.
 */
export function revertError(registry, error) {
  const decoded = decodeDeclaredError(registry, error?.data);
  if (decoded === null) throw error;
  return { name: decoded.name, args: [...decoded.args] };
}

/** Name of the custom error a rejected write reverted with (see revertError). */
export function revertErrorName(registry, error) {
  return revertError(registry, error).name;
}

/**
 * Send a write that must be rejected and return its custom error as
 * { name, args } (see revertError). For calls that break two rules whose
 * check order the API leaves open, so the test can accept either error.
 */
export async function rejectionOf(registry, txPromise) {
  try {
    await (await txPromise).wait();
  } catch (error) {
    return revertError(registry, error);
  }
  expect.fail("the write must be rejected, but it succeeded");
}

/** The latest block's timestamp, in Unix seconds. */
export async function latestTimestamp(provider) {
  return (await provider.getBlock("latest")).timestamp;
}

/**
 * Data flow 1: the manufacturer uploads the lot metadata JSON to IPFS and
 * registers the lot with its CID and hash. Manufactured a day before the
 * latest block, with the default 2.0-8.0 C range unless `range` says otherwise.
 */
export async function registerLot({ registry, provider }, ipfs, manufacturer, lotNumber, range = { min: 20, max: 80 }) {
  const productHash = productHashOf(PRODUCT_CODE, lotNumber);
  const manufactureDate = (await latestTimestamp(provider)) - 86_400;
  const metadata = ipfs.addJson({
    type: "lot-metadata",
    productCode: PRODUCT_CODE,
    lotNumber,
    productName: "Synthetic test vaccine",
    site: "Plant A",
    manufactureDate,
    storage: { minTempTenthsC: range.min, maxTempTenthsC: range.max },
  });
  const { event } = await sendWrite(
    registry,
    registry.connect(manufacturer).registerBatch(productHash, manufactureDate, range.min, range.max, metadata),
  );
  return { batchId: event.batchId, productHash, manufactureDate, metadata };
}

/** Data flow 2: one complete hand-off, as a signed initiate/accept pair. */
export async function handOff(registry, batchId, from, to) {
  await sendWrite(registry, registry.connect(from).initiateTransfer(batchId, to.address));
  await sendWrite(registry, registry.connect(to).acceptTransfer(batchId));
}

// =========================================================================
//                   READING HISTORY FROM EVENT LOGS
// =========================================================================

/**
 * Read the registry's logs the way the verify page does: eth_getLogs on the
 * registry address, in block-range pages from the deploy block, because
 * public RPCs cap the range of a single query (design decision O6). With
 * `batchId`, only that lot's logs are fetched, using the batchId topic that
 * every registry event carries first (topics [null, batchId]).
 *
 * Returns entries {event, blockNumber, blockTimestamp, transactionHash,
 * logIndex} in chain order, with `event` as a plain object (see toPlain).
 * `contract` only supplies the ABI for decoding, so a read-only instance is
 * enough.
 */
export async function readLogs(provider, contract, { fromBlock, batchId, pageSize = 1000 }) {
  const address = await contract.getAddress();
  const lastBlock = await provider.getBlockNumber();
  const topics = batchId === undefined ? undefined : [null, toBeHex(batchId, 32)];
  const timestamps = new Map();
  const entries = [];

  for (let start = fromBlock; start <= lastBlock; start += pageSize) {
    const end = Math.min(start + pageSize - 1, lastBlock);
    for (const log of await provider.getLogs({ address, topics, fromBlock: start, toBlock: end })) {
      const parsed = contract.interface.parseLog(log);
      if (parsed === null) throw new Error(`log ${log.transactionHash}#${log.index} is not in the registry ABI`);
      if (!timestamps.has(log.blockNumber)) {
        timestamps.set(log.blockNumber, (await provider.getBlock(log.blockNumber)).timestamp);
      }
      entries.push({
        event: toPlain(parsed),
        blockNumber: log.blockNumber,
        blockTimestamp: timestamps.get(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: log.index,
      });
    }
  }
  return entries;
}

// =========================================================================
//                REBUILDING LOT RECORDS FROM EVENTS ALONE
// =========================================================================

/**
 * The part of a lot's on-chain record that its events determine. The
 * temperature range, manufactureDate and the metadata hash appear in no
 * event; the verify page reads those from verifyBatch.
 */
export function rebuildableView(batch) {
  return {
    id: batch.id,
    productHash: batch.productHash,
    manufacturer: batch.manufacturer,
    registeredAt: batch.registeredAt,
    metadataCid: batch.metadata.cid,
    status: batch.status,
    custodian: batch.custodian,
    pendingCustodian: batch.pendingCustodian,
    sensorLogCount: batch.sensorLogCount,
    certificate: { cid: batch.certificate.cid, contentHash: batch.certificate.contentHash },
    latestSensorLog: { cid: batch.latestSensorLog.cid, contentHash: batch.latestSensorLog.contentHash },
  };
}

/** Every field of a verifyBatch result as a plain object, so whole records can be compared. */
export function fullView(batch) {
  return {
    ...rebuildableView(batch),
    manufactureDate: batch.manufactureDate,
    minTempTenthsC: batch.minTempTenthsC,
    maxTempTenthsC: batch.maxTempTenthsC,
    metadata: { cid: batch.metadata.cid, contentHash: batch.metadata.contentHash },
  };
}

/**
 * Pure reducer: the state of one lot after one more of its events. A state
 * is {record, statusBeforeTransfer}. `record` has the shape of
 * rebuildableView. `statusBeforeTransfer` is what the reducer remembers from
 * TransferInitiated, because TransferCancelled does not say which status it
 * restores. The rules are the transitions documented on
 * IProvenanceRegistry.Status; nothing here reads the chain.
 */
export function applyEvent(state, entry) {
  const event = entry.event;
  if (event.name === "BatchRegistered") {
    if (state !== undefined) throw new Error(`lot ${event.batchId} was registered twice`);
    return {
      record: {
        id: event.batchId,
        productHash: event.productHash,
        manufacturer: event.manufacturer,
        registeredAt: BigInt(entry.blockTimestamp),
        metadataCid: event.metadataCid,
        status: Status.Created,
        custodian: event.manufacturer,
        pendingCustodian: ZeroAddress,
        sensorLogCount: 0n,
        certificate: EMPTY_DOCUMENT,
        latestSensorLog: EMPTY_DOCUMENT,
      },
      statusBeforeTransfer: undefined,
    };
  }
  if (state === undefined) throw new Error(`${event.name} for lot ${event.batchId} before its BatchRegistered`);

  const record = state.record;
  const next = (changes) => ({ ...state, record: { ...record, ...changes } });
  switch (event.name) {
    case "TransferInitiated":
      return {
        record: { ...record, pendingCustodian: event.to, status: Status.InTransit },
        statusBeforeTransfer: record.status,
      };
    case "CustodyTransferred":
      return next({ custodian: event.to, pendingCustodian: ZeroAddress, status: Status.Stored });
    case "TransferCancelled":
      return next({ pendingCustodian: ZeroAddress, status: state.statusBeforeTransfer });
    case "StatusUpdated":
      return next({ status: event.newStatus });
    case "CertificateIssued":
      return next({ certificate: { cid: event.cid, contentHash: event.contentHash } });
    case "SensorLogAnchored":
      return next({ sensorLogCount: event.logIndex, latestSensorLog: { cid: event.cid, contentHash: event.contentHash } });
    case "ExcursionReported":
      return next({
        sensorLogCount: event.logIndex,
        latestSensorLog: { cid: event.logCid, contentHash: event.logContentHash },
        pendingCustodian: ZeroAddress,
        status: Status.Compromised,
      });
    case "BatchRecalled":
      return next({ pendingCustodian: ZeroAddress, status: Status.Recalled });
    default:
      throw new Error(`the reducer does not know the event ${event.name}`);
  }
}

/** Fold registry event entries (any mix of lots, in chain order) into a Map batchId => state. */
export function replay(entries) {
  const lots = new Map();
  for (const entry of entries) {
    const batchId = entry.event.batchId;
    lots.set(batchId, applyEvent(lots.get(batchId), entry));
  }
  return lots;
}
