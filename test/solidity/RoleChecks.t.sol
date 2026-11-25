// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IProvenanceRegistry} from "../../contracts/interfaces/IProvenanceRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/**
 * @title RoleCheckPropertiesTest
 * @notice Property (specification B): on every write function the role check
 *         runs first. A caller that holds none of the function's roles gets
 *         the role error, whatever lot and argument values it passes, valid
 *         or not. The calldata itself is always well-formed (abi.encodeCall):
 *         calldata the ABI decoder rejects fails before any check runs.
 *
 * @dev Single-role functions revert AccessControlUnauthorizedAccount(caller,
 *      role) and two-role functions MissingEitherRole(caller, roleA, roleB).
 *      The fuzzer picks the function, the caller, the lot ID and an `entropy`
 *      word from which every other argument is derived, including empty
 *      documents, inverted ranges, future timestamps and the zero address.
 *      Bits of `selector` make half of the runs use one of the named actors
 *      (an organization with the wrong role, the regulator, or the
 *      outsider) and half name the lot that exists, so the role error has to
 *      win over checks that would otherwise pass or fail. Callers that do
 *      hold a required role are discarded with vm.assume.
 *
 *      updateStatus gets a valid Status value: an out-of-range enum value is
 *      rejected by the ABI decoder before any check of the contract runs (see
 *      the NatSpec of updateStatus).
 *
 *      Runs: 512 (set inline below).
 */
contract RoleCheckPropertiesTest is RegistryTestBase {
    /// @dev The ten write functions of IProvenanceRegistry, numbered 0-9 in `_callData`.
    uint256 private constant WRITE_FUNCTIONS = 10;

    uint256 private _existingLot;

    function setUp() public override {
        super.setUp();
        _existingLot = _register(MANUFACTURER_A, keccak256(abi.encode("NDC-0000-0000-00", "LOT-ROLES")));
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_callerWithoutTheRoleGetsTheRoleErrorWhateverTheArguments(
        address caller,
        uint8 selector,
        uint256 batchId,
        bytes32 entropy
    ) public {
        if (selector & 0x80 != 0) caller = _namedActor(uint160(caller));
        if (selector & 0x40 != 0) batchId = _existingLot;
        uint256 functionIndex = (selector & 0x3f) % WRITE_FUNCTIONS;

        (bytes32 roleA, bytes32 roleB) = _requiredRoles(functionIndex);
        bool hasEither = roleB != bytes32(0);
        vm.assume(!registry.hasRole(roleA, caller) && !(hasEither && registry.hasRole(roleB, caller)));

        bytes memory expected = hasEither
            ? abi.encodeWithSelector(IProvenanceRegistry.MissingEitherRole.selector, caller, roleA, roleB)
            : abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, roleA);
        bytes memory callData = _callData(functionIndex, batchId, uint256(entropy));

        vm.prank(caller);
        (bool ok, bytes memory reason) = address(registry).call(callData);
        vm.assertTrue(!ok, "a caller without the role got past the role check");
        vm.assertEq(reason, expected, "a check ran before the role check");
    }

    /// @dev Proposal Table I, plus cancelTransfer (design decision C3).
    ///      `roleB` is zero for the functions that accept a single role.
    function _requiredRoles(uint256 functionIndex) private pure returns (bytes32 roleA, bytes32 roleB) {
        if (functionIndex == 0) return (MANUFACTURER_ROLE, bytes32(0)); // registerBatch
        if (functionIndex == 1 || functionIndex == 3) return (MANUFACTURER_ROLE, DISTRIBUTOR_ROLE); // initiate, cancel
        if (functionIndex == 2) return (DISTRIBUTOR_ROLE, RETAILER_ROLE); // acceptTransfer
        if (functionIndex == 4) return (DISTRIBUTOR_ROLE, bytes32(0)); // updateStatus
        if (functionIndex == 5) return (RETAILER_ROLE, bytes32(0)); // markDelivered
        if (functionIndex == 6 || functionIndex == 7) return (REGULATOR_ROLE, bytes32(0)); // issueCertificate, recallBatch
        return (ORACLE_ROLE, bytes32(0)); // anchorSensorLog, reportExcursion
    }

    /// @dev Encode a call to write function `functionIndex`. Every argument
    ///      other than the lot ID is cut from `entropy`, and two of its bits
    ///      blank one half of the document reference each.
    function _callData(uint256 functionIndex, uint256 batchId, uint256 entropy) private pure returns (bytes memory) {
        IProvenanceRegistry.DocumentRef memory document = IProvenanceRegistry.DocumentRef({
            cid: entropy & 1 == 0 ? "" : "bafkrei-arbitrary",
            contentHash: entropy & 2 == 0 ? bytes32(0) : bytes32(entropy)
        });
        int16 low = int16(uint16(entropy >> 8));
        int16 high = int16(uint16(entropy >> 24));
        uint64 timestamp = uint64(entropy >> 40);
        address recipient = address(uint160(entropy >> 96));
        IProvenanceRegistry.Status newStatus = IProvenanceRegistry.Status((entropy >> 104) % 6);

        if (functionIndex == 0) {
            return abi.encodeCall(IProvenanceRegistry.registerBatch, (bytes32(entropy), timestamp, low, high, document));
        }
        if (functionIndex == 1) return abi.encodeCall(IProvenanceRegistry.initiateTransfer, (batchId, recipient));
        if (functionIndex == 2) return abi.encodeCall(IProvenanceRegistry.acceptTransfer, (batchId));
        if (functionIndex == 3) return abi.encodeCall(IProvenanceRegistry.cancelTransfer, (batchId));
        if (functionIndex == 4) return abi.encodeCall(IProvenanceRegistry.updateStatus, (batchId, newStatus));
        if (functionIndex == 5) return abi.encodeCall(IProvenanceRegistry.markDelivered, (batchId));
        if (functionIndex == 6) return abi.encodeCall(IProvenanceRegistry.issueCertificate, (batchId, document));
        if (functionIndex == 7) return abi.encodeCall(IProvenanceRegistry.recallBatch, (batchId, document.cid));
        if (functionIndex == 8) return abi.encodeCall(IProvenanceRegistry.anchorSensorLog, (batchId, document));
        return abi.encodeCall(IProvenanceRegistry.reportExcursion, (batchId, low, timestamp, document));
    }

    function _namedActor(uint256 index) private pure returns (address) {
        address[8] memory actors = [
            REGULATOR, MANUFACTURER_A, MANUFACTURER_B, DISTRIBUTOR_A, DISTRIBUTOR_B, RETAILER, ORACLE, OUTSIDER
        ];
        return actors[index % actors.length];
    }
}
