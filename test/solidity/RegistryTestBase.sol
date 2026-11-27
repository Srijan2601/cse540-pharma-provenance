// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvenanceRegistry} from "../../contracts/ProvenanceRegistry.sol";
import {IProvenanceRegistry} from "../../contracts/interfaces/IProvenanceRegistry.sol";

/**
 * @title Vm
 * @notice The cheatcodes used by the property tests in this folder.
 * @dev Hardhat 3 runs Solidity tests on EDR, which answers Foundry-compatible
 *      cheatcodes at a fixed address (see `RegistryTestBase.vm`). The project
 *      does not depend on forge-std, so only the few cheatcodes used here are
 *      declared, with the signatures Foundry defines for them.
 */
interface Vm {
    /// @dev One log captured between recordLogs() and getRecordedLogs().
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    /// @dev The next external call is sent with msg.sender = `msgSender`.
    function prank(address msgSender) external;

    /// @dev Sets block.timestamp.
    function warp(uint256 newTimestamp) external;

    /// @dev Discards the current fuzz input (it does not count as a run) unless `condition` holds.
    function assume(bool condition) external pure;

    /// @dev Starts capturing every log emitted from now on.
    function recordLogs() external;

    /// @dev Returns the logs captured since recordLogs() and clears the buffer.
    function getRecordedLogs() external returns (Log[] memory logs);

    // Assertions. On failure the runner prints `message` with both values.
    function assertTrue(bool condition, string calldata message) external pure;
    function assertEq(uint256 left, uint256 right, string calldata message) external pure;
    function assertEq(int256 left, int256 right, string calldata message) external pure;
    function assertEq(address left, address right, string calldata message) external pure;
    function assertEq(bytes32 left, bytes32 right, string calldata message) external pure;
    function assertEq(string calldata left, string calldata right, string calldata message) external pure;
    function assertEq(bytes calldata left, bytes calldata right, string calldata message) external pure;
}

/**
 * @title RegistryTestBase
 * @notice Shared set-up for the Solidity property tests: a fresh
 *         ProvenanceRegistry with every proposal role onboarded, named actor
 *         accounts, and the checks for invariants I1-I4 that several tests
 *         reuse (I5 needs the previous status, so the stateful test checks it).
 *
 * @dev Actors are plain addresses. `vm.prank` makes the next call come from
 *      one of them, so no keys and no actor contracts are needed. A prank is
 *      used up by the next external call, including a view call, so helpers
 *      always evaluate registry views before they prank.
 *
 *      The runner restores the state left by setUp() before every fuzz run,
 *      so each run starts from the same onboarded registry.
 */
abstract contract RegistryTestBase {
    /// @dev The cheatcode address: address(bytes20(keccak256("hevm cheat code"))).
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Role identifiers, recomputed from their names. setUp() checks them
    // against the registry's own constants (RegistryBase.sol), so the tests
    // never need a view call to learn a role, which would use up a prank.
    bytes32 internal constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 internal constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 internal constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 internal constant RETAILER_ROLE = keccak256("RETAILER_ROLE");
    bytes32 internal constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // One account per organization in proposal Table I, plus a second
    // manufacturer and distributor (rival firms sharing the registry) and an
    // account with no role. The values are arbitrary and hold no funds.
    address internal constant REGULATOR = address(0x1001);
    address internal constant MANUFACTURER_A = address(0x2001);
    address internal constant MANUFACTURER_B = address(0x2002);
    address internal constant DISTRIBUTOR_A = address(0x3001);
    address internal constant DISTRIBUTOR_B = address(0x3002);
    address internal constant RETAILER = address(0x4001);
    address internal constant ORACLE = address(0x5001);
    address internal constant OUTSIDER = address(0x6001);

    /// @dev 2026-01-01T00:00:00Z. The runner starts at timestamp 1, which
    ///      would leave 1 as the only valid manufactureDate or observedAt.
    uint256 internal constant START_TIME = 1_767_225_600;

    /// @dev Default allowed range, 2.0 C to 8.0 C in tenths of a degree (C7).
    int16 internal constant MIN_TEMP = 20;
    int16 internal constant MAX_TEMP = 80;

    ProvenanceRegistry internal registry;

    function setUp() public virtual {
        vm.warp(START_TIME);
        registry = new ProvenanceRegistry(REGULATOR);

        vm.assertEq(registry.REGULATOR_ROLE(), REGULATOR_ROLE, "REGULATOR_ROLE is not keccak256 of its name");
        vm.assertEq(registry.MANUFACTURER_ROLE(), MANUFACTURER_ROLE, "MANUFACTURER_ROLE is not keccak256 of its name");
        vm.assertEq(registry.DISTRIBUTOR_ROLE(), DISTRIBUTOR_ROLE, "DISTRIBUTOR_ROLE is not keccak256 of its name");
        vm.assertEq(registry.RETAILER_ROLE(), RETAILER_ROLE, "RETAILER_ROLE is not keccak256 of its name");
        vm.assertEq(registry.ORACLE_ROLE(), ORACLE_ROLE, "ORACLE_ROLE is not keccak256 of its name");

        // Data flow 4 ("Oversee"): the regulator onboards each organization.
        _grant(MANUFACTURER_ROLE, MANUFACTURER_A);
        _grant(MANUFACTURER_ROLE, MANUFACTURER_B);
        _grant(DISTRIBUTOR_ROLE, DISTRIBUTOR_A);
        _grant(DISTRIBUTOR_ROLE, DISTRIBUTOR_B);
        _grant(RETAILER_ROLE, RETAILER);
        _grant(ORACLE_ROLE, ORACLE);
    }

    // =====================================================================
    //                            ACTION HELPERS
    // =====================================================================

    function _grant(bytes32 role, address account) internal {
        vm.prank(REGULATOR);
        registry.grantRole(role, account);
    }

    /// @dev A well-formed document reference: a CID-like string and the
    ///      keccak256 of some bytes. The registry checks only that both
    ///      halves are present (O1), so their exact values do not matter.
    function _doc(string memory label) internal pure returns (IProvenanceRegistry.DocumentRef memory) {
        return IProvenanceRegistry.DocumentRef({cid: string.concat("bafkrei", label), contentHash: keccak256(bytes(label))});
    }

    /// @dev Register a lot with the default range, made "now" (valid inputs).
    function _register(address manufacturer, bytes32 productHash) internal returns (uint256 batchId) {
        return _registerWithRange(manufacturer, productHash, MIN_TEMP, MAX_TEMP);
    }

    function _registerWithRange(address manufacturer, bytes32 productHash, int16 minTempTenthsC, int16 maxTempTenthsC)
        internal
        returns (uint256 batchId)
    {
        IProvenanceRegistry.DocumentRef memory metadata = _doc("lot-metadata");
        vm.prank(manufacturer);
        batchId = registry.registerBatch(productHash, uint64(block.timestamp), minTempTenthsC, maxTempTenthsC, metadata);
    }

    /// @dev Both halves of a hand-off: `from` names `to`, then `to` accepts.
    function _handOff(uint256 batchId, address from, address to) internal {
        vm.prank(from);
        registry.initiateTransfer(batchId, to);
        vm.prank(to);
        registry.acceptTransfer(batchId);
    }

    // =====================================================================
    //                         INVARIANT CHECKS
    // =====================================================================

    /// @dev Delivered, Compromised and Recalled end a lot's custody journey (design decision C2).
    function _isTerminal(IProvenanceRegistry.Status status) internal pure returns (bool) {
        return status == IProvenanceRegistry.Status.Delivered || status == IProvenanceRegistry.Status.Compromised
            || status == IProvenanceRegistry.Status.Recalled;
    }

    /// @dev I1, I2 and I4 hold for one lot record.
    function _assertRecordInvariants(IProvenanceRegistry.Batch memory batch) internal pure {
        if (batch.pendingCustodian != address(0)) {
            vm.assertEq(
                uint256(batch.status),
                uint256(IProvenanceRegistry.Status.InTransit),
                "I1: a lot with an open hand-off is not InTransit"
            );
        }
        if (_isTerminal(batch.status)) {
            vm.assertEq(batch.pendingCustodian, address(0), "I2: a terminal lot still has an open hand-off");
        }
        vm.assertTrue(batch.custodian != address(0), "I4: a lot has no custodian");
        vm.assertTrue(batch.manufacturer != address(0), "I4: a lot has no manufacturer");
    }

    /// @dev I3: the lot IDs are exactly 1..expectedCount, each record carries
    ///      its own ID, and batchIdOf maps each record's product hash back to
    ///      it. IDs 0 and expectedCount + 1 must not exist.
    function _assertIdInvariants(uint256 expectedCount) internal view {
        vm.assertEq(registry.totalBatches(), expectedCount, "I3: totalBatches() is not the number of registered lots");
        for (uint256 batchId = 1; batchId <= expectedCount; batchId++) {
            IProvenanceRegistry.Batch memory batch = registry.verifyBatch(batchId);
            vm.assertEq(batch.id, batchId, "I3: a record carries another lot's ID");
            vm.assertEq(registry.batchIdOf(batch.productHash), batchId, "I3: batchIdOf does not return the lot");
        }
        _assertBatchNotFound(0);
        _assertBatchNotFound(expectedCount + 1);
        vm.assertEq(registry.batchIdOf(bytes32(0)), 0, "I3: the zero product hash maps to a lot");
    }

    /// @dev verifyBatch(batchId) must revert with exactly BatchNotFound(batchId).
    function _assertBatchNotFound(uint256 batchId) internal view {
        try registry.verifyBatch(batchId) returns (IProvenanceRegistry.Batch memory) {
            vm.assertTrue(false, "verifyBatch returned a lot outside 1..totalBatches()");
        } catch (bytes memory reason) {
            vm.assertEq(
                reason,
                abi.encodeWithSelector(IProvenanceRegistry.BatchNotFound.selector, batchId),
                "verifyBatch of a missing lot did not revert BatchNotFound(batchId)"
            );
        }
    }

    /// @dev `logs` holds exactly one log: `eventSelector` from the registry,
    ///      with `batchId` as its first indexed topic. This is the "one event
    ///      per write" rule that the verify page's history relies on.
    function _assertSingleRegistryEvent(Vm.Log[] memory logs, bytes32 eventSelector, uint256 batchId) internal view {
        vm.assertEq(logs.length, 1, "a successful write did not emit exactly one event");
        vm.assertEq(logs[0].emitter, address(registry), "the event was not emitted by the registry");
        vm.assertEq(logs[0].topics[0], eventSelector, "a successful write emitted the wrong event");
        vm.assertEq(logs[0].topics[1], bytes32(batchId), "the event's batchId topic names another lot");
    }
}
