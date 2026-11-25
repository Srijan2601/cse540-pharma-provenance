// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IProvenanceRegistry} from "../../contracts/interfaces/IProvenanceRegistry.sol";
import {RegistryTestBase, Vm} from "./RegistryTestBase.sol";

/**
 * @title RandomWalkInvariantTest
 * @notice Stateful property: whatever sequence of calls the stakeholders
 *         make, invariants I1-I5 of the specification hold after every call.
 *
 * @dev One fuzz run is one walk of STEPS steps over up to MAX_LOTS lots,
 *      fully determined by the fuzzed `seed`. Each step picks one action,
 *      weighted roughly like a real supply chain (hand-offs and sensor logs
 *      often, recalls and excursions rarely):
 *        registerBatch, initiateTransfer, acceptTransfer, cancelTransfer,
 *        updateStatus, markDelivered, issueCertificate, recallBatch,
 *        anchorSensorLog, reportExcursion, grantRole/revokeRole, or letting
 *        time pass.
 *      Calls may revert, and many do. To get deep into each lot's life
 *      anyway, the walk is steered: three times in four an action picks a
 *      lot it can apply to (a lot with an open hand-off for acceptTransfer,
 *      a lot Stored at a pharmacy for markDelivered, ...), and three calls in
 *      four come from the actor the action belongs to (the lot's custodian,
 *      the named recipient, the regulator, the oracle). The rest pick any lot
 *      (now and then a missing one) and any of the eight actors, the
 *      outsider included. Recipients, statuses, readings, times and
 *      documents are drawn the same way: mostly plausible, sometimes invalid
 *      (the zero address, an empty document, a future time). Role changes
 *      offboard and re-onboard organizations in the middle of journeys.
 *
 *      After every step the test checks, for every lot:
 *        I1  an open hand-off implies InTransit
 *        I2  Delivered, Compromised or Recalled implies no open hand-off
 *        I3  the IDs are exactly 1..totalBatches(), batchIdOf maps each
 *            lot's hash back to it, IDs 0 and totalBatches() + 1 do not
 *            exist, and hashes whose registration was rejected stay unmapped
 *        I4  a non-zero custodian and manufacturer
 *        I5  Recalled never changes; Delivered and Compromised change only
 *            to Recalled
 *      plus properties that follow from the specification and design
 *      decisions C3/C4, observed from one step to the next:
 *        - every status change is an edge of the state machine documented
 *          on IProvenanceRegistry.Status;
 *        - a hand-off only opens along an allowed route (to a
 *          distributor, or to a pharmacy from a distributor), never to the
 *          custodian itself;
 *        - custody only ever moves to the recipient the custodian had
 *          named, and the lot is then Stored;
 *        - a Created lot is still with its manufacturer;
 *        - only a pharmacy (RETAILER) makes a lot Delivered;
 *        - a terminal lot is frozen: a Recalled record never changes at
 *          all, and a Delivered or Compromised lot keeps its custodian, its
 *          (empty) hand-off and its sensor logs; only a certificate or a
 *          recall can still change it;
 *        - the fields fixed at registration never change, and
 *          sensorLogCount never decreases.
 *      Every successful registry call must emit exactly one event, of the
 *      right kind and about the right lot.
 *
 *      Steering reads the registry, but the checks do not trust it: the
 *      ghost state they compare against (`_lotCount`, `_origin`, ...) holds
 *      only what the test itself sent, so a wrong record cannot hide behind
 *      a wrong expectation.
 *
 *      Runs: 64 walks of 150 steps, so 9,600 steps per test run (set inline
 *      below; the runner's default seed is fixed, so runs are repeatable).
 *      With these settings roughly 30% of the calls succeed, and the walks
 *      reach every status and make every write function succeed.
 */
contract RandomWalkInvariantTest is RegistryTestBase {
    uint256 private constant STEPS = 150;

    /// @dev Few lots, so that each one gets many steps and reaches the late
    ///      and terminal statuses. Registrations beyond this cap reuse a
    ///      registered hash (or zero) and must fail.
    uint256 private constant MAX_LOTS = 6;

    /// @dev What an action needs from a lot to have a chance of succeeding.
    enum Need {
        NotRecalled, // issueCertificate, recallBatch
        Resting, // initiateTransfer: Created or Stored
        OpenHandOff, // acceptTransfer, cancelTransfer
        Movable, // updateStatus: Stored, or InTransit without an open hand-off
        AtPharmacy, // markDelivered: Stored, held by a RETAILER
        Active // anchorSensorLog, reportExcursion
    }

    /// @dev The fields of a lot that are fixed at registration, as sent by the test.
    struct Origin {
        bytes32 productHash;
        address manufacturer;
        uint64 manufactureDate;
        uint64 registeredAt;
        int16 minTempTenthsC;
        int16 maxTempTenthsC;
    }

    /// @dev Pseudo-random state; see `_draw`.
    uint256 private _entropy;

    /// @dev REGULATOR first, then the six organizations, then OUTSIDER.
    address[] private _actors;

    // Ghost state.
    uint256 private _lotCount;
    mapping(uint256 batchId => Origin) private _origin;
    mapping(uint256 batchId => IProvenanceRegistry.Status) private _lastStatus;
    mapping(uint256 batchId => uint32) private _lastLogCount;
    mapping(uint256 batchId => address) private _lastCustodian;
    mapping(uint256 batchId => address) private _lastPendingCustodian;
    mapping(uint256 batchId => bytes32) private _lastRecordHash;
    mapping(uint256 batchId => bytes32) private _lastCustodyAndConditionHash;
    bytes32[] private _rejectedHashes;

    function setUp() public override {
        super.setUp();
        _actors.push(REGULATOR);
        _actors.push(MANUFACTURER_A);
        _actors.push(MANUFACTURER_B);
        _actors.push(DISTRIBUTOR_A);
        _actors.push(DISTRIBUTOR_B);
        _actors.push(RETAILER);
        _actors.push(ORACLE);
        _actors.push(OUTSIDER);
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_randomWalkPreservesInvariants(uint256 seed) public {
        _entropy = seed;
        for (uint256 step = 0; step < STEPS; step++) {
            _takeStep();
            _assertInvariants();
        }
    }

    // =====================================================================
    //                              ONE STEP
    // =====================================================================

    /// @dev Pick and attempt one action. The thresholds are cumulative
    ///      percentages; the first step always registers a lot.
    function _takeStep() private {
        uint256 roll = _draw(100);
        if (_lotCount == 0 || roll < 8) {
            _tryRegister();
            return;
        }
        if (roll < 24) _tryInitiate(_pickLot(Need.Resting));
        else if (roll < 38) _tryAccept(_pickLot(Need.OpenHandOff));
        else if (roll < 42) _tryCancel(_pickLot(Need.OpenHandOff));
        else if (roll < 52) _tryUpdateStatus(_pickLot(Need.Movable));
        else if (roll < 60) _tryMarkDelivered(_pickLot(Need.AtPharmacy));
        else if (roll < 66) _tryIssueCertificate(_pickLot(Need.NotRecalled));
        else if (roll < 68) _tryRecall(_pickLot(Need.NotRecalled));
        else if (roll < 82) _tryAnchor(_pickLot(Need.Active));
        else if (roll < 85) _tryReportExcursion(_pickLot(Need.Active));
        else if (roll < 91) _tryChangeRole();
        else vm.warp(block.timestamp + 1 + _draw(2 days));
    }

    function _tryRegister() private {
        address actor = _pickActor(_draw(2) == 0 ? MANUFACTURER_A : MANUFACTURER_B);
        (bytes32 productHash, bool fresh) = _pickProductHash();
        uint64 manufactureDate = _pickTime();
        (int16 minTempTenthsC, int16 maxTempTenthsC) = _pickRange();
        IProvenanceRegistry.DocumentRef memory metadata = _pickDocument("metadata");

        uint256 nextId = _lotCount + 1;
        bytes memory callData = abi.encodeCall(
            IProvenanceRegistry.registerBatch, (productHash, manufactureDate, minTempTenthsC, maxTempTenthsC, metadata)
        );
        if (_execute(actor, callData, IProvenanceRegistry.BatchRegistered.selector, nextId)) {
            _lotCount = nextId;
            _origin[nextId] = Origin({
                productHash: productHash,
                manufacturer: actor,
                manufactureDate: manufactureDate,
                registeredAt: uint64(block.timestamp),
                minTempTenthsC: minTempTenthsC,
                maxTempTenthsC: maxTempTenthsC
            });
            _lastStatus[nextId] = IProvenanceRegistry.Status.Created;
            _lastCustodian[nextId] = actor;
        } else if (fresh) {
            _rejectedHashes.push(productHash);
        }
    }

    function _tryInitiate(uint256 batchId) private {
        address actor = _pickActor(_custodianOf(batchId));
        address to = _pickRecipient(actor);
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.initiateTransfer, (batchId, to)),
            IProvenanceRegistry.TransferInitiated.selector,
            batchId
        );
    }

    function _tryAccept(uint256 batchId) private {
        address actor = _pickActor(_pendingCustodianOf(batchId));
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.acceptTransfer, (batchId)),
            IProvenanceRegistry.CustodyTransferred.selector,
            batchId
        );
    }

    function _tryCancel(uint256 batchId) private {
        address actor = _pickActor(_custodianOf(batchId));
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.cancelTransfer, (batchId)),
            IProvenanceRegistry.TransferCancelled.selector,
            batchId
        );
    }

    /// @dev Half of the attempts on an existing lot ask for the natural flip
    ///      (InTransit <-> Stored); the rest ask for any of the six statuses.
    function _tryUpdateStatus(uint256 batchId) private {
        address actor = _pickActor(_custodianOf(batchId));
        IProvenanceRegistry.Status newStatus;
        if (_exists(batchId) && _draw(2) == 0) {
            newStatus = registry.verifyBatch(batchId).status == IProvenanceRegistry.Status.InTransit
                ? IProvenanceRegistry.Status.Stored
                : IProvenanceRegistry.Status.InTransit;
        } else {
            newStatus = IProvenanceRegistry.Status(_draw(6));
        }
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.updateStatus, (batchId, newStatus)),
            IProvenanceRegistry.StatusUpdated.selector,
            batchId
        );
    }

    function _tryMarkDelivered(uint256 batchId) private {
        address actor = _pickActor(_custodianOf(batchId));
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.markDelivered, (batchId)),
            IProvenanceRegistry.StatusUpdated.selector,
            batchId
        );
    }

    function _tryIssueCertificate(uint256 batchId) private {
        address actor = _pickActor(REGULATOR);
        IProvenanceRegistry.DocumentRef memory certificate = _pickDocument("certificate");
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.issueCertificate, (batchId, certificate)),
            IProvenanceRegistry.CertificateIssued.selector,
            batchId
        );
    }

    function _tryRecall(uint256 batchId) private {
        address actor = _pickActor(REGULATOR);
        string memory reason = _draw(16) == 0 ? "" : "walk: recall by the regulator";
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.recallBatch, (batchId, reason)),
            IProvenanceRegistry.BatchRecalled.selector,
            batchId
        );
    }

    function _tryAnchor(uint256 batchId) private {
        address actor = _pickActor(ORACLE);
        IProvenanceRegistry.DocumentRef memory sensorLog = _pickDocument("sensor-log");
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.anchorSensorLog, (batchId, sensorLog)),
            IProvenanceRegistry.SensorLogAnchored.selector,
            batchId
        );
    }

    function _tryReportExcursion(uint256 batchId) private {
        address actor = _pickActor(ORACLE);
        int16 reading = _pickReading(batchId);
        uint64 observedAt = _pickTime();
        IProvenanceRegistry.DocumentRef memory sensorLog = _pickDocument("excursion-log");
        _execute(
            actor,
            abi.encodeCall(IProvenanceRegistry.reportExcursion, (batchId, reading, observedAt, sensorLog)),
            IProvenanceRegistry.ExcursionReported.selector,
            batchId
        );
    }

    /// @dev The regulator (usually) grants or revokes an organization role.
    ///      Grants mostly restore an actor's own role and revokes mostly
    ///      remove it, so organizations drop out and come back during the
    ///      walk instead of the registry slowly running out of role holders.
    ///      The regulator's own roles are never touched.
    function _tryChangeRole() private {
        address account = _actors[1 + _draw(_actors.length - 1)];
        bytes32 role = _draw(4) == 0 ? _randomOrganizationRole() : _homeRole(account);
        bool grant = _draw(3) != 0;
        address actor = _pickActor(REGULATOR);
        bytes memory callData = grant
            ? abi.encodeCall(IAccessControl.grantRole, (role, account))
            : abi.encodeCall(IAccessControl.revokeRole, (role, account));

        vm.recordLogs();
        vm.prank(actor);
        (bool ok,) = address(registry).call(callData);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) return;

        // AccessControl emits only when the role actually changes, so a
        // successful grant or revoke leaves zero or one log.
        vm.assertTrue(logs.length <= 1, "a role change emitted more than one event");
        if (logs.length == 1) {
            bytes32 expected = grant ? IAccessControl.RoleGranted.selector : IAccessControl.RoleRevoked.selector;
            vm.assertEq(logs[0].topics[0], expected, "a role change emitted the wrong event");
        }
        vm.assertTrue(registry.hasRole(role, account) == grant, "a successful role change did not take effect");
    }

    /// @dev Send `callData` to the registry as `actor`. A revert is a legal
    ///      outcome: the invariants are checked after every step either way.
    ///      A success must leave exactly one log, `eventSelector` about lot
    ///      `batchId`.
    function _execute(address actor, bytes memory callData, bytes32 eventSelector, uint256 batchId)
        private
        returns (bool ok)
    {
        vm.recordLogs();
        vm.prank(actor);
        (ok,) = address(registry).call(callData);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (ok) _assertSingleRegistryEvent(logs, eventSelector, batchId);
    }

    // =====================================================================
    //                           INVARIANT CHECKS
    // =====================================================================

    function _assertInvariants() private {
        _assertIdInvariants(_lotCount);
        for (uint256 i = 0; i < _rejectedHashes.length; i++) {
            vm.assertEq(registry.batchIdOf(_rejectedHashes[i]), 0, "I3: a rejected registration left its hash mapped");
        }

        for (uint256 batchId = 1; batchId <= _lotCount; batchId++) {
            IProvenanceRegistry.Batch memory batch = registry.verifyBatch(batchId);
            _assertRecordInvariants(batch);

            IProvenanceRegistry.Status previous = _lastStatus[batchId];
            _assertI5(previous, batch.status);
            vm.assertTrue(_isStateMachineEdge(previous, batch.status), "a status change is not an edge of the state machine");
            _assertCustodyRules(batchId, batch, previous);
            _assertTerminalLotFrozen(batchId, batch, previous);

            _assertOriginUnchanged(batchId, batch);
            vm.assertTrue(batch.sensorLogCount >= _lastLogCount[batchId], "sensorLogCount decreased");

            _lastStatus[batchId] = batch.status;
            _lastLogCount[batchId] = batch.sensorLogCount;
            _lastCustodian[batchId] = batch.custodian;
            _lastPendingCustodian[batchId] = batch.pendingCustodian;
            _lastRecordHash[batchId] = keccak256(abi.encode(batch));
            _lastCustodyAndConditionHash[batchId] = _custodyAndConditionHash(batch);
        }
    }

    function _assertI5(IProvenanceRegistry.Status previous, IProvenanceRegistry.Status current) private pure {
        if (previous == IProvenanceRegistry.Status.Recalled) {
            vm.assertEq(uint256(current), uint256(IProvenanceRegistry.Status.Recalled), "I5: a Recalled lot changed status");
        } else if (previous == IProvenanceRegistry.Status.Delivered || previous == IProvenanceRegistry.Status.Compromised) {
            vm.assertTrue(
                current == previous || current == IProvenanceRegistry.Status.Recalled,
                "I5: a Delivered or Compromised lot changed to a status other than Recalled"
            );
        }
    }

    /// @dev Whether one step may take a lot from `previous` to `current`.
    ///      Each step makes at most one call, so every observed change must be
    ///      a single edge of the state machine in IProvenanceRegistry.Status.
    function _isStateMachineEdge(IProvenanceRegistry.Status previous, IProvenanceRegistry.Status current)
        private
        pure
        returns (bool)
    {
        if (previous == current) return true;
        if (current == IProvenanceRegistry.Status.Recalled) return true; // recallBatch, from any other status
        if (current == IProvenanceRegistry.Status.Compromised) return !_isTerminal(previous); // reportExcursion
        if (current == IProvenanceRegistry.Status.InTransit) {
            // initiateTransfer from Created or Stored; updateStatus from Stored
            return previous == IProvenanceRegistry.Status.Created || previous == IProvenanceRegistry.Status.Stored;
        }
        if (current == IProvenanceRegistry.Status.Stored || current == IProvenanceRegistry.Status.Created) {
            // acceptTransfer, updateStatus or cancelTransfer (Stored); cancelTransfer (Created)
            return previous == IProvenanceRegistry.Status.InTransit;
        }
        // Delivered: markDelivered
        return previous == IProvenanceRegistry.Status.Stored;
    }

    /// @dev The custody rules, comparing the record with the one seen after
    ///      the previous step. Roles cannot change in the same step as a
    ///      registry call, so checking roles now gives the roles the call saw.
    function _assertCustodyRules(
        uint256 batchId,
        IProvenanceRegistry.Batch memory batch,
        IProvenanceRegistry.Status previous
    ) private view {
        address recipient = batch.pendingCustodian;
        if (recipient != address(0) && _lastPendingCustodian[batchId] == address(0)) {
            // A hand-off opened in this step, by the custodian (who has not changed).
            vm.assertTrue(recipient != batch.custodian, "a custodian opened a hand-off to itself");
            bool toDistributor = registry.hasRole(DISTRIBUTOR_ROLE, recipient);
            bool distributorToPharmacy =
                registry.hasRole(RETAILER_ROLE, recipient) && registry.hasRole(DISTRIBUTOR_ROLE, batch.custodian);
            vm.assertTrue(toDistributor || distributorToPharmacy, "a hand-off opened along a route that is not allowed");
        }
        if (batch.custodian != _lastCustodian[batchId]) {
            vm.assertEq(batch.custodian, _lastPendingCustodian[batchId], "custody moved to an account nobody had named");
            vm.assertEq(
                uint256(batch.status), uint256(IProvenanceRegistry.Status.Stored), "custody moved but the lot is not Stored"
            );
        }
        if (batch.status == IProvenanceRegistry.Status.Created) {
            vm.assertEq(batch.custodian, _origin[batchId].manufacturer, "a Created lot has left its manufacturer");
        }
        if (batch.status == IProvenanceRegistry.Status.Delivered && previous != IProvenanceRegistry.Status.Delivered) {
            vm.assertTrue(registry.hasRole(RETAILER_ROLE, batch.custodian), "a lot was delivered by an account that is not a pharmacy");
        }
    }

    /// @dev Compares hashes of the record seen after the previous step, so
    ///      that every field is covered without listing each one.
    function _assertTerminalLotFrozen(
        uint256 batchId,
        IProvenanceRegistry.Batch memory batch,
        IProvenanceRegistry.Status previous
    ) private view {
        if (previous == IProvenanceRegistry.Status.Recalled) {
            vm.assertEq(keccak256(abi.encode(batch)), _lastRecordHash[batchId], "a Recalled lot's record changed");
        } else if (previous == IProvenanceRegistry.Status.Delivered || previous == IProvenanceRegistry.Status.Compromised) {
            vm.assertEq(
                _custodyAndConditionHash(batch),
                _lastCustodyAndConditionHash[batchId],
                "a Delivered or Compromised lot changed hands or gained a sensor log"
            );
        }
    }

    function _custodyAndConditionHash(IProvenanceRegistry.Batch memory batch) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                batch.custodian,
                batch.pendingCustodian,
                batch.sensorLogCount,
                batch.latestSensorLog.cid,
                batch.latestSensorLog.contentHash
            )
        );
    }

    function _assertOriginUnchanged(uint256 batchId, IProvenanceRegistry.Batch memory batch) private view {
        Origin storage origin = _origin[batchId];
        vm.assertEq(batch.productHash, origin.productHash, "a lot's productHash changed");
        vm.assertEq(batch.manufacturer, origin.manufacturer, "a lot's manufacturer changed");
        vm.assertEq(uint256(batch.manufactureDate), uint256(origin.manufactureDate), "a lot's manufactureDate changed");
        vm.assertEq(uint256(batch.registeredAt), uint256(origin.registeredAt), "a lot's registeredAt changed");
        vm.assertEq(int256(batch.minTempTenthsC), int256(origin.minTempTenthsC), "a lot's minimum temperature changed");
        vm.assertEq(int256(batch.maxTempTenthsC), int256(origin.maxTempTenthsC), "a lot's maximum temperature changed");
    }

    // =====================================================================
    //                         PSEUDO-RANDOM CHOICES
    // =====================================================================

    /// @dev Next pseudo-random number in [0, bound). Each draw re-hashes the
    ///      previous state, so a walk is a pure function of its seed and a
    ///      failing seed replays step for step.
    function _draw(uint256 bound) private returns (uint256) {
        _entropy = uint256(keccak256(abi.encode(_entropy)));
        return _entropy % bound;
    }

    /// @dev `natural` three times in four (when there is one), else any actor.
    function _pickActor(address natural) private returns (address) {
        if (natural != address(0) && _draw(4) != 0) return natural;
        return _actors[_draw(_actors.length)];
    }

    /// @dev Three times in four, a random lot that meets `need` (if any
    ///      does). Otherwise any lot, and one time in sixteen of those a
    ///      missing one (ID 0 or the next unused ID).
    function _pickLot(Need need) private returns (uint256) {
        if (_draw(4) != 0) {
            uint256[] memory candidates = new uint256[](_lotCount);
            uint256 count;
            for (uint256 batchId = 1; batchId <= _lotCount; batchId++) {
                if (_meets(registry.verifyBatch(batchId), need)) candidates[count++] = batchId;
            }
            if (count > 0) return candidates[_draw(count)];
        }
        if (_draw(16) == 0) return _draw(2) == 0 ? 0 : _lotCount + 1;
        return 1 + _draw(_lotCount);
    }

    function _meets(IProvenanceRegistry.Batch memory batch, Need need) private view returns (bool) {
        IProvenanceRegistry.Status status = batch.status;
        bool open = batch.pendingCustodian != address(0);
        if (need == Need.Resting) {
            return status == IProvenanceRegistry.Status.Created || status == IProvenanceRegistry.Status.Stored;
        }
        if (need == Need.OpenHandOff) return open;
        if (need == Need.Movable) {
            return status == IProvenanceRegistry.Status.Stored || (status == IProvenanceRegistry.Status.InTransit && !open);
        }
        if (need == Need.AtPharmacy) {
            return status == IProvenanceRegistry.Status.Stored && registry.hasRole(RETAILER_ROLE, batch.custodian);
        }
        if (need == Need.Active) return !_isTerminal(status);
        return status != IProvenanceRegistry.Status.Recalled;
    }

    function _exists(uint256 batchId) private view returns (bool) {
        return batchId != 0 && batchId <= _lotCount;
    }

    function _custodianOf(uint256 batchId) private view returns (address) {
        return _exists(batchId) ? registry.verifyBatch(batchId).custodian : address(0);
    }

    function _pendingCustodianOf(uint256 batchId) private view returns (address) {
        return _exists(batchId) ? registry.verifyBatch(batchId).pendingCustodian : address(0);
    }

    /// @dev A fresh hash, or (one time in eight, and always once MAX_LOTS lots
    ///      exist) a registered hash or the zero hash, which must be rejected.
    function _pickProductHash() private returns (bytes32 productHash, bool fresh) {
        if (_lotCount >= MAX_LOTS || _draw(8) == 0) {
            if (_lotCount == 0 || _draw(4) == 0) return (bytes32(0), false);
            return (_origin[1 + _draw(_lotCount)].productHash, false);
        }
        return (keccak256(abi.encode("walk-lot", _entropy)), true);
    }

    /// @dev Usually a time in the last 30 days; one time in sixteen 0 or a future time.
    function _pickTime() private returns (uint64) {
        if (_draw(16) == 0) return _draw(2) == 0 ? 0 : uint64(block.timestamp + 1 + _draw(1 days));
        return uint64(block.timestamp - _draw(30 days));
    }

    /// @dev One of three realistic ranges (fridge, frozen, room temperature),
    ///      or one time in sixteen an inverted range, which must be rejected.
    function _pickRange() private returns (int16, int16) {
        uint256 roll = _draw(16);
        if (roll == 0) return (MAX_TEMP, MIN_TEMP);
        if (roll < 9) return (MIN_TEMP, MAX_TEMP);
        if (roll < 13) return (-250, -150);
        return (150, 250);
    }

    /// @dev A unique, well-formed reference, or one time in sixteen a
    ///      reference with its CID or its hash missing.
    function _pickDocument(string memory label) private returns (IProvenanceRegistry.DocumentRef memory document) {
        document = IProvenanceRegistry.DocumentRef({
            cid: string.concat("bafkrei-walk-", label),
            contentHash: keccak256(abi.encode(label, _entropy))
        });
        if (_draw(16) == 0) {
            if (_draw(2) == 0) document.cid = "";
            else document.contentHash = bytes32(0);
        }
    }

    /// @dev For an existing lot: below, above or inside its range, a third
    ///      of the time each. For a missing lot: any small value.
    function _pickReading(uint256 batchId) private returns (int16) {
        if (!_exists(batchId)) return int16(int256(_draw(1000)) - 500);
        int256 low = _origin[batchId].minTempTenthsC;
        int256 high = _origin[batchId].maxTempTenthsC;
        uint256 roll = _draw(3);
        if (roll == 0) return int16(low - 1 - int256(_draw(100)));
        if (roll == 1) return int16(high + 1 + int256(_draw(100)));
        return int16(low + int256(_draw(uint256(high - low) + 1)));
    }

    /// @dev Usually (11 times in 16) the next custodian on the proposal's
    ///      route: a distributor, or the pharmacy when the sender is a
    ///      distributor. Otherwise any actor, or one time in sixteen the zero
    ///      address.
    function _pickRecipient(address sender) private returns (address) {
        uint256 roll = _draw(16);
        if (roll == 0) return address(0);
        if (roll >= 12) return _actors[_draw(_actors.length)];
        if (registry.hasRole(DISTRIBUTOR_ROLE, sender) && _draw(2) == 0) return RETAILER;
        return _draw(2) == 0 ? DISTRIBUTOR_A : DISTRIBUTOR_B;
    }

    function _homeRole(address account) private returns (bytes32) {
        if (account == MANUFACTURER_A || account == MANUFACTURER_B) return MANUFACTURER_ROLE;
        if (account == DISTRIBUTOR_A || account == DISTRIBUTOR_B) return DISTRIBUTOR_ROLE;
        if (account == RETAILER) return RETAILER_ROLE;
        if (account == ORACLE) return ORACLE_ROLE;
        return _randomOrganizationRole(); // OUTSIDER has no role of its own
    }

    function _randomOrganizationRole() private returns (bytes32) {
        uint256 roll = _draw(4);
        if (roll == 0) return MANUFACTURER_ROLE;
        if (roll == 1) return DISTRIBUTOR_ROLE;
        if (roll == 2) return RETAILER_ROLE;
        return ORACLE_ROLE;
    }
}
