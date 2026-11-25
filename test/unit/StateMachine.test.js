// Unit tests: the lot state machine (proposal Fig. 1, design decisions C1 and
// C2) and the storage invariants I1-I5 (RegistryBase.sol).
//
// Part 1 is a generated status x function matrix. Rows are every state a lot
// can be in (LOT_STATES in test/helpers/registry.js): InTransit appears three
// times, with a hand-off opened at Created, with one opened at Stored, and
// with none. Columns are the nine write functions that act on an existing
// lot. Each cell is one test that sends one call and asserts its exact
// outcome from the EXPECTED table below: the new status with the event and
// all its arguments, or the exact custom error with its arguments and an
// unchanged record. Every cell then checks I1-I5 against the state before
// the call.
//
// Who calls: the custody functions are called by the lot's custodian, the
// only account whose call can depend on the status (C4); acceptTransfer by
// the named recipient, or by the distributor when no hand-off is open; the
// regulator and oracle functions by the regulator and the oracle. Where that
// caller lacks the function's role (a pharmacy cannot ship a lot onward) the
// cell expects the role error. Custody.test.js reaches the status checks
// behind those cells with dual-role accounts.
//
// Part 2 is a seeded random walk of 500 calls over up to 30 lots. Most steps
// are "sensible" (the intended caller, arguments that pass the argument
// checks, a lot whose state makes the call worth trying), so lots really
// travel, get delivered, flagged and recalled; the rest use any caller and
// any argument, valid or not. The walk checks that every call either succeeds
// with exactly its one registry event or reverts with one of the custom
// errors the contract declares (not a panic or a revert string), that I1-I5
// hold after every step, and that every write function succeeded at least
// once (so the walk did not degenerate into reverts). It predicts one kind of
// outcome, the party rule of C3 and C4: a call by an account that holds the
// function's role but is not the party the lot names (its custodian, or the
// named recipient for acceptTransfer) must fail with the custody error. Such
// calls are checked when the walk makes them, and after every step a probe
// makes one on purpose, so the rule is tested in every state the walk
// reaches. The seed is fixed, so a failure is reproducible, and its message
// names the step and the call.
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress, ZeroHash } from "ethers";
import { decodeDeclaredError, seededRandom } from "../helpers/common.js";
import {
  ACCOUNT_ROLES,
  ACTIVE_STATUSES,
  EMPTY_DOCUMENT,
  LOT_STATES,
  ROLES,
  STATUS_NAMES,
  Status,
  WRITE_FUNCTIONS,
  createRegistryKit,
  expectInvariants,
  expectOnlyEvent,
  expectRejected,
  makeDocument,
  makeProductHash,
  readBatch,
  rejectionOf,
} from "../helpers/registry.js";

const connection = await network.create();
const kit = createRegistryKit(connection);
const { loadFixture, deployRegistryFixture, lotFixture, latestTimestamp } = kit;

const CERTIFICATE = makeDocument("state-machine test certificate");
const SENSOR_LOG = makeDocument("state-machine test sensor log");
const REASON = "state-machine test recall";
const EXCURSION_READING = 81; // one tenth above the default 8.0 C maximum

/** The account name (in the fixture) of the signer that holds `address`. */
function nameOf(accounts, address) {
  return Object.keys(accounts).find((name) => accounts[name].address === address);
}

// =====================================================================
//                     PART 1: STATUS x FUNCTION MATRIX
// =====================================================================

// Caller and arguments per function. `lot` is the fixture's lot ({ id,
// custodian, pending }); `observedAt` is the latest block time.
const CALLS = {
  initiateTransfer: {
    caller: (lot) => lot.custodian,
    // A recipient the custodian may ship to: manufacturer -> distributor, distributor -> pharmacy.
    args: (lot, accounts) => [
      lot.id,
      (lot.custodian.address === accounts.distributor.address ? accounts.retailer : accounts.distributor).address,
    ],
  },
  acceptTransfer: { caller: (lot, accounts) => lot.pending ?? accounts.distributor, args: (lot) => [lot.id] },
  cancelTransfer: { caller: (lot) => lot.custodian, args: (lot) => [lot.id] },
  updateStatus: {
    caller: (lot) => lot.custodian,
    // The one valid move from Stored, otherwise the one valid move to Stored.
    args: (lot) => [lot.id, lot.status === Status.Stored ? Status.InTransit : Status.Stored],
  },
  markDelivered: { caller: (lot) => lot.custodian, args: (lot) => [lot.id] },
  issueCertificate: { caller: (_, accounts) => accounts.regulator, args: (lot) => [lot.id, CERTIFICATE] },
  recallBatch: { caller: (_, accounts) => accounts.regulator, args: (lot) => [lot.id, REASON] },
  anchorSensorLog: { caller: (_, accounts) => accounts.oracle, args: (lot) => [lot.id, SENSOR_LOG] },
  reportExcursion: {
    caller: (_, accounts) => accounts.oracle,
    args: (lot, _, observedAt) => [lot.id, EXCURSION_READING, observedAt, SENSOR_LOG],
  },
};

// Expected outcomes. ok(event, to, args, changes): the call emits `event`
// with `args`, the status becomes `to` (null: unchanged) and the other
// record fields in `changes` change; nothing else may change.
// fail(error, args): the call reverts with that custom error and the record
// stays as it was. Argument and change builders receive
// { id, a, before, observedAt }, where `a` maps account names to addresses
// and `before` is the record before the call.
const ok = (event, to, args, changes = () => ({})) => ({ event, to, args, changes });
const fail = (error, args) => ({ error, args });

const notActive = (status) => fail("InvalidStatus", ({ id }) => [id, status]);
const noHandOff = fail("NoPendingTransfer", ({ id }) => [id]);
const roleMissing = (account, role) =>
  fail("AccessControlUnauthorizedAccount", ({ a }) => [a[account], ROLES[role]]);
const pharmacyCannotShip = fail("MissingEitherRole", ({ a }) => [a.retailer, ROLES.MANUFACTURER, ROLES.DISTRIBUTOR]);

const certified = ok(
  "CertificateIssued",
  null,
  ({ id, a }) => [id, a.regulator, CERTIFICATE.cid, CERTIFICATE.contentHash],
  () => ({ certificate: CERTIFICATE }),
);
const recalled = ok(
  "BatchRecalled",
  Status.Recalled,
  ({ id, a }) => [id, a.regulator, REASON],
  () => ({ pendingCustodian: ZeroAddress }),
);
const anchored = ok(
  "SensorLogAnchored",
  null,
  ({ id, before }) => [id, before.sensorLogCount + 1, SENSOR_LOG.cid, SENSOR_LOG.contentHash],
  ({ before }) => ({ sensorLogCount: before.sensorLogCount + 1, latestSensorLog: SENSOR_LOG }),
);
const compromised = ok(
  "ExcursionReported",
  Status.Compromised,
  ({ id, before, observedAt }) => [
    id,
    before.sensorLogCount + 1,
    EXCURSION_READING,
    observedAt,
    SENSOR_LOG.cid,
    SENSOR_LOG.contentHash,
  ],
  ({ before }) => ({ pendingCustodian: ZeroAddress, sensorLogCount: before.sensorLogCount + 1, latestSensorLog: SENSOR_LOG }),
);

/** EXPECTED[function][state key]: the outcome of that function's call on a lot in that state. */
const EXPECTED = {
  initiateTransfer: {
    Created: ok("TransferInitiated", Status.InTransit, ({ id, a }) => [id, a.manufacturer, a.distributor], ({ a }) => ({
      pendingCustodian: a.distributor,
    })),
    InTransitFromFactory: fail("TransferAlreadyPending", ({ id, a }) => [id, a.distributor]),
    InTransitToPharmacy: fail("TransferAlreadyPending", ({ id, a }) => [id, a.retailer]),
    InTransitMoving: notActive(Status.InTransit),
    StoredAtDistributor: ok(
      "TransferInitiated",
      Status.InTransit,
      ({ id, a }) => [id, a.distributor, a.retailer],
      ({ a }) => ({ pendingCustodian: a.retailer }),
    ),
    StoredAtPharmacy: pharmacyCannotShip,
    Delivered: pharmacyCannotShip,
    Compromised: notActive(Status.Compromised),
    Recalled: notActive(Status.Recalled),
  },
  acceptTransfer: {
    Created: noHandOff,
    InTransitFromFactory: ok(
      "CustodyTransferred",
      Status.Stored,
      ({ id, a }) => [id, a.manufacturer, a.distributor],
      ({ a }) => ({ custodian: a.distributor, pendingCustodian: ZeroAddress }),
    ),
    InTransitToPharmacy: ok(
      "CustodyTransferred",
      Status.Stored,
      ({ id, a }) => [id, a.distributor, a.retailer],
      ({ a }) => ({ custodian: a.retailer, pendingCustodian: ZeroAddress }),
    ),
    InTransitMoving: noHandOff,
    StoredAtDistributor: noHandOff,
    StoredAtPharmacy: noHandOff,
    Delivered: noHandOff,
    Compromised: noHandOff,
    Recalled: noHandOff,
  },
  cancelTransfer: {
    Created: noHandOff,
    InTransitFromFactory: ok(
      "TransferCancelled",
      Status.Created,
      ({ id, a }) => [id, a.manufacturer, a.distributor],
      () => ({ pendingCustodian: ZeroAddress }),
    ),
    InTransitToPharmacy: ok(
      "TransferCancelled",
      Status.Stored,
      ({ id, a }) => [id, a.distributor, a.retailer],
      () => ({ pendingCustodian: ZeroAddress }),
    ),
    InTransitMoving: noHandOff,
    StoredAtDistributor: noHandOff,
    StoredAtPharmacy: pharmacyCannotShip,
    Delivered: pharmacyCannotShip,
    Compromised: noHandOff,
    Recalled: noHandOff,
  },
  updateStatus: {
    Created: roleMissing("manufacturer", "DISTRIBUTOR"),
    InTransitFromFactory: roleMissing("manufacturer", "DISTRIBUTOR"),
    InTransitToPharmacy: fail("TransferAlreadyPending", ({ id, a }) => [id, a.retailer]),
    InTransitMoving: ok("StatusUpdated", Status.Stored, ({ id, a }) => [id, Status.InTransit, Status.Stored, a.distributor]),
    StoredAtDistributor: ok("StatusUpdated", Status.InTransit, ({ id, a }) => [
      id,
      Status.Stored,
      Status.InTransit,
      a.distributor,
    ]),
    StoredAtPharmacy: roleMissing("retailer", "DISTRIBUTOR"),
    Delivered: roleMissing("retailer", "DISTRIBUTOR"),
    Compromised: fail("InvalidStatusTransition", ({ id }) => [id, Status.Compromised, Status.Stored]),
    Recalled: fail("InvalidStatusTransition", ({ id }) => [id, Status.Recalled, Status.Stored]),
  },
  markDelivered: {
    Created: roleMissing("manufacturer", "RETAILER"),
    InTransitFromFactory: roleMissing("manufacturer", "RETAILER"),
    InTransitToPharmacy: roleMissing("distributor", "RETAILER"),
    InTransitMoving: roleMissing("distributor", "RETAILER"),
    StoredAtDistributor: roleMissing("distributor", "RETAILER"),
    StoredAtPharmacy: ok("StatusUpdated", Status.Delivered, ({ id, a }) => [
      id,
      Status.Stored,
      Status.Delivered,
      a.retailer,
    ]),
    Delivered: notActive(Status.Delivered),
    Compromised: roleMissing("distributor", "RETAILER"),
    Recalled: roleMissing("distributor", "RETAILER"),
  },
  // The regulator acts at any stage except after a recall (C2).
  issueCertificate: Object.fromEntries(
    LOT_STATES.map(({ key }) => [key, key === "Recalled" ? notActive(Status.Recalled) : certified]),
  ),
  recallBatch: Object.fromEntries(
    LOT_STATES.map(({ key }) => [key, key === "Recalled" ? notActive(Status.Recalled) : recalled]),
  ),
  // The oracle acts on active lots only (Created, InTransit, Stored).
  anchorSensorLog: Object.fromEntries(
    LOT_STATES.map(({ key, status }) => [key, ACTIVE_STATUSES.includes(status) ? anchored : notActive(status)]),
  ),
  reportExcursion: Object.fromEntries(
    LOT_STATES.map(({ key, status }) => [key, ACTIVE_STATUSES.includes(status) ? compromised : notActive(status)]),
  ),
};

describe("State machine", function () {
  describe("status x function matrix (one call per cell, then I1-I5)", function () {
    for (const state of LOT_STATES) {
      describe(`lot ${state.label}`, function () {
        for (const [functionName, call] of Object.entries(CALLS)) {
          const expected = EXPECTED[functionName][state.key];
          const outcome = expected.event
            ? `${expected.to === null ? `stays ${STATUS_NAMES[state.status]}` : `-> ${STATUS_NAMES[expected.to]}`}, emits ${expected.event}`
            : `reverts ${expected.error}`;

          it(`${functionName}: ${outcome}`, async function () {
            const { registry, accounts, lot } = await loadFixture(lotFixture(state.key));
            const lotsBefore = await expectInvariants(registry);
            const before = lotsBefore[0];
            expect(before.status, "fixture status").to.equal(state.status);

            const caller = call.caller(lot, accounts);
            const observedAt = await latestTimestamp();
            const args = call.args(lot, accounts, observedAt);
            const a = Object.fromEntries(Object.entries(accounts).map(([name, signer]) => [name, signer.address]));
            const context = { id: lot.id, a, before, observedAt };
            const send = () => registry.connect(caller)[functionName](...args);

            if (expected.event) {
              const tx = send();
              await expect(tx)
                .to.emit(registry, expected.event)
                .withArgs(...expected.args(context));
              await expectOnlyEvent(tx, registry, expected.event);
              expect(await readBatch(registry, lot.id)).to.deep.equal({
                ...before,
                status: expected.to ?? before.status,
                ...expected.changes(context),
              });
            } else {
              await expectRejected(registry, lot.id, send, expected.error, expected.args(context));
            }

            await expectInvariants(registry, lotsBefore);
          });
        }
      });
    }
  });

  // =====================================================================
  //                      PART 2: SEEDED RANDOM WALK
  // =====================================================================

  describe("random walk", function () {
    const SEED = 0x540;
    const STEPS = 500;
    const MAX_LOTS = 30; // bounds the cost of the invariant check, which reads every lot

    /** A call argument as it should appear in a failure message. */
    function describeArg(value) {
      if (typeof value !== "object") return String(value);
      if (value.cid === "") return value.contentHash === ZeroHash ? "{empty document}" : "{empty cid}";
      return value.contentHash === ZeroHash ? "{zero content hash}" : `{cid ${value.cid.slice(0, 12)}...}`;
    }

    it(`keeps I1-I5 after each of ${STEPS} random calls, rejects every party the lot does not name, and lets every write function succeed`, async function () {
      this.timeout(300_000);
      const { registry, accounts } = await loadFixture(deployRegistryFixture);
      const random = seededRandom(SEED);
      const pick = (items) => items[Math.floor(random() * items.length)];
      const chance = (p) => random() < p;

      const everyone = Object.values(accounts);
      const signerOf = new Map(everyone.map((signer) => [signer.address, signer]));
      const isDistributor = (signer) => ACCOUNT_ROLES[nameOf(accounts, signer.address)] === "DISTRIBUTOR";
      const distributors = [accounts.distributor, accounts.secondDistributor];
      const pharmacies = [accounts.retailer, accounts.secondRetailer];
      const incomplete = [{ ...CERTIFICATE, cid: "" }, { ...CERTIFICATE, contentHash: ZeroHash }, EMPTY_DOCUMENT];
      // Lot functions weighted so that lots tend to travel before a recall or an excursion ends them.
      const weighted = [
        ...Array(4).fill("initiateTransfer"),
        ...Array(4).fill("acceptTransfer"),
        "cancelTransfer",
        ...Array(2).fill("updateStatus"),
        ...Array(2).fill("markDelivered"),
        ...Array(2).fill("issueCertificate"),
        "recallBatch",
        ...Array(2).fill("anchorSensorLog"),
        "reportExcursion",
      ];
      const eventOf = Object.fromEntries(WRITE_FUNCTIONS.map((f) => [f.name, f.event]));
      const successes = Object.fromEntries(WRITE_FUNCTIONS.map((f) => [f.name, 0]));

      // Lots on which a sensible step's call is worth trying. This only steers
      // which lot is picked; the outcome is still decided by the contract.
      const atPharmacy = (lot) => pharmacies.some((signer) => signer.address === lot.custodian);
      const worthTrying = {
        initiateTransfer: (lot) => lot.status === Status.Created || lot.status === Status.Stored,
        acceptTransfer: (lot) => lot.pendingCustodian !== ZeroAddress,
        cancelTransfer: (lot) => lot.pendingCustodian !== ZeroAddress,
        updateStatus: (lot) => lot.status === Status.InTransit || lot.status === Status.Stored,
        markDelivered: (lot) => lot.status === Status.Stored && atPharmacy(lot),
      };

      // The party a function is meant for, given the lot's current record.
      const intendedCaller = (functionName, lot) => {
        if (["issueCertificate", "recallBatch"].includes(functionName)) return accounts.regulator;
        if (["anchorSensorLog", "reportExcursion"].includes(functionName)) return accounts.oracle;
        if (functionName === "acceptTransfer" && lot.pendingCustodian !== ZeroAddress) {
          return signerOf.get(lot.pendingCustodian);
        }
        return signerOf.get(lot.custodian);
      };

      // The party rule (C3, C4). For a caller that holds one of the
      // function's roles, acting on an existing lot that names another party,
      // return the [error, args] pairs the call may fail with; null when the
      // rule does not decide the outcome. The role error and BatchNotFound
      // come first, so callers without the role and unknown lot IDs are left
      // to the general check. Nobody's roles change during the walk, so
      // ACCOUNT_ROLES is exact.
      const partyRejections = (functionName, caller, lot) => {
        if (lot === undefined) return null;
        const { roles } = WRITE_FUNCTIONS.find((f) => f.name === functionName);
        if (!roles.includes(ACCOUNT_ROLES[nameOf(accounts, caller.address)])) return null;
        const by = caller.address;
        switch (functionName) {
          case "initiateTransfer":
          case "cancelTransfer":
          case "updateStatus":
            // NotCustodian is the first check after BatchNotFound (normative order).
            return by === lot.custodian ? null : [["NotCustodian", [lot.id, by]]];
          case "markDelivered":
            // The order of NotCustodian and InvalidStatus is not part of the API.
            if (by === lot.custodian) return null;
            return lot.status === Status.Stored
              ? [["NotCustodian", [lot.id, by]]]
              : [
                  ["NotCustodian", [lot.id, by]],
                  ["InvalidStatus", [lot.id, lot.status]],
                ];
          case "acceptTransfer":
            if (lot.pendingCustodian === ZeroAddress) return [["NoPendingTransfer", [lot.id]]];
            return by === lot.pendingCustodian ? null : [["NotPendingCustodian", [lot.id, by]]];
          default:
            return null; // the regulator's and the oracle's functions do not depend on custody
        }
      };
      const custodyFunctions = Object.keys(worthTrying);
      const partyChecks = Object.fromEntries(custodyFunctions.map((name) => [name, 0]));

      // Party probes. The walk's own steps rarely send a custody call from a
      // wrong party that holds the right role, so after every step it also
      // sends one such call on purpose: a random custody function on a lot,
      // from an account that holds one of the function's roles but is not the
      // party the lot names. Half of the probes use the wrong parties closest
      // to the lot, which a faulty check is most likely to let through: its
      // custodian, its named recipient and its manufacturer (for example the
      // sender of a hand-off trying to accept it). acceptTransfer and
      // cancelTransfer probes prefer lots with an open hand-off, where the
      // party check is the one that decides. The probes draw from their own
      // PRNG, and a rejected call changes no state, so they leave the walk
      // unchanged.
      const probeRandom = seededRandom(SEED + 1);
      const probePick = (items) => items[Math.floor(probeRandom() * items.length)];
      const holdersOf = (functionName) => {
        const { roles } = WRITE_FUNCTIONS.find((f) => f.name === functionName);
        return everyone.filter((signer) => roles.includes(ACCOUNT_ROLES[nameOf(accounts, signer.address)]));
      };
      const probeArgs = {
        // The custodian check comes before the recipient checks, so any recipient will do.
        initiateTransfer: (lot, caller) => [lot.id, probePick(distributors.filter((d) => d !== caller)).address],
        acceptTransfer: (lot) => [lot.id],
        cancelTransfer: (lot) => [lot.id],
        updateStatus: (lot) => [lot.id, probePick(Object.values(Status))],
        markDelivered: (lot) => [lot.id],
      };
      async function probePartyRule(step, lots) {
        if (lots.length === 0) return;
        const functionName = probePick(custodyFunctions);
        const withHandOff = lots.filter((lot) => lot.pendingCustodian !== ZeroAddress);
        const handOffMatters = functionName === "acceptTransfer" || functionName === "cancelTransfer";
        const lot = handOffMatters && withHandOff.length > 0 && probeRandom() < 0.8 ? probePick(withHandOff) : probePick(lots);
        const named = functionName === "acceptTransfer" ? lot.pendingCustodian : lot.custodian;
        const wrongParties = holdersOf(functionName).filter((signer) => signer.address !== named);
        const closest = wrongParties.filter((signer) =>
          [lot.custodian, lot.pendingCustodian, lot.manufacturer].includes(signer.address),
        );
        const caller = probePick(closest.length > 0 && probeRandom() < 0.5 ? closest : wrongParties);
        const args = probeArgs[functionName](lot, caller);
        const expected = partyRejections(functionName, caller, lot);
        try {
          expect(expected, "a probe always breaks the party rule").to.not.equal(null);
          const rejection = await rejectionOf(registry, () => registry.connect(caller)[functionName](...args));
          const allowed = expected.map(([name, values]) => [name, values.map(String)]);
          expect(allowed, "the custody error of the party rule").to.deep.include(rejection);
        } catch (error) {
          const call = `${functionName}(${args.map(describeArg).join(", ")}) from ${nameOf(accounts, caller.address)}`;
          error.message = `after step ${step}, party probe ${call}: ${error.message}`;
          throw error;
        }
        partyChecks[functionName] += 1;
      }

      let lots = await expectInvariants(registry);
      for (let step = 1; step <= STEPS; step++) {
        // A "sensible" step picks the intended caller and arguments that pass
        // the argument checks, so whether it succeeds depends on the lot's
        // state. Otherwise every caller and argument, valid or not, is fair game.
        const sensible = chance(0.7);
        const now = await latestTimestamp();
        const active = lots.filter((lot) => ACTIVE_STATUSES.includes(lot.status));
        const freshDocument = () => makeDocument(`walk document ${step}`);
        const documentArg = () => (sensible || chance(0.5) ? freshDocument() : pick(incomplete));
        let functionName;
        let caller;
        let args;
        let target; // the record of the lot the call names, read before the call; undefined if none

        if (lots.length < MAX_LOTS && (lots.length === 0 || chance(active.length < 4 ? 0.3 : 0.05))) {
          functionName = "registerBatch";
          // A pool of 40 product hashes, so later registrations hit duplicates.
          const productHash = makeProductHash("NDC-0000-0000-00", `LOT-WALK-${Math.floor(random() * 40)}`);
          if (sensible) {
            caller = pick([accounts.manufacturer, accounts.secondManufacturer]);
            const [min, max] = pick([[20, 80], [-250, -150]]);
            args = [productHash, now - 3600n, min, max, freshDocument()];
          } else {
            caller = pick(everyone);
            const [min, max] = pick([[20, 80], [30, 30], [80, 20]]);
            args = [pick([productHash, ZeroHash]), pick([now - 3600n, 0n, now + 3600n]), min, max, documentArg()];
          }
        } else {
          functionName = pick(weighted);
          const candidates = sensible ? lots.filter(worthTrying[functionName] ?? ((lot) => active.includes(lot))) : [];
          const batchId =
            candidates.length > 0
              ? pick(candidates).id
              : !sensible && chance(0.1)
                ? pick([0n, BigInt(lots.length + 1)])
                : active.length > 0 && chance(0.8)
                  ? pick(active).id
                  : BigInt(1 + Math.floor(random() * lots.length));
          const lot = lots[Number(batchId) - 1]; // undefined for an unknown ID
          target = lot;
          caller = sensible && lot !== undefined ? intendedCaller(functionName, lot) : pick(everyone);
          const min = lot?.minTempTenthsC ?? 20;
          const max = lot?.maxTempTenthsC ?? 80;

          args = {
            initiateTransfer: () => {
              const routes = (isDistributor(caller) ? [...distributors, ...pharmacies] : distributors).filter(
                (signer) => signer !== caller,
              );
              return [batchId, sensible ? pick(routes).address : pick([...everyone.map((s) => s.address), ZeroAddress])];
            },
            acceptTransfer: () => [batchId],
            cancelTransfer: () => [batchId],
            updateStatus: () => [
              batchId,
              sensible && lot !== undefined
                ? lot.status === Status.Stored
                  ? Status.InTransit
                  : Status.Stored
                : pick(Object.values(Status)),
            ],
            markDelivered: () => [batchId],
            issueCertificate: () => [batchId, documentArg()],
            recallBatch: () => [batchId, sensible ? REASON : pick([REASON, ""])],
            anchorSensorLog: () => [batchId, documentArg()],
            reportExcursion: () =>
              sensible
                ? [batchId, pick([min - 1, max + 1]), now, freshDocument()]
                : [
                    batchId,
                    pick([min - 1, max + 1, min, max, Math.trunc((min + max) / 2)]),
                    pick([now, 0n, now + 3600n]),
                    documentArg(),
                  ],
          }[functionName]();
        }

        const description = `${functionName}(${args.map(describeArg).join(", ")}) from ${nameOf(accounts, caller.address)}`;
        const expectedRejections = partyRejections(functionName, caller, target);
        try {
          const tx = registry.connect(caller)[functionName](...args);
          let rejection = null;
          try {
            await (await tx).wait();
          } catch (error) {
            const decoded = decodeDeclaredError(registry, error.data);
            // A panic, a revert string or a failure of the test itself is not
            // an expected rejection: report it as it is.
            if (decoded === null) throw error;
            rejection = [decoded.name, decoded.args.map(String)];
          }
          if (expectedRejections !== null) {
            expect(rejection, "a party the lot does not name must be rejected").to.not.equal(null);
            const allowed = expectedRejections.map(([name, values]) => [name, values.map(String)]);
            expect(allowed, "the custody error of the party rule").to.deep.include(rejection);
            partyChecks[functionName] += 1;
          }
          if (rejection === null) {
            await expectOnlyEvent(tx, registry, eventOf[functionName]);
            successes[functionName] += 1;
          }
          lots = await expectInvariants(registry, lots);
        } catch (error) {
          error.message = `step ${step}, ${description}: ${error.message}`;
          throw error;
        }
        await probePartyRule(step, lots);
      }

      for (const [functionName, count] of Object.entries(successes)) {
        expect(count, `successful ${functionName} calls in the walk`).to.be.greaterThan(0);
      }
      for (const [functionName, count] of Object.entries(partyChecks)) {
        expect(count, `rejected ${functionName} calls by a party the lot does not name`).to.be.greaterThan(0);
      }
    });
  });
});
