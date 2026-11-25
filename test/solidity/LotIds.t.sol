// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProvenanceRegistry} from "../../contracts/interfaces/IProvenanceRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/**
 * @title LotIdPropertiesTest
 * @notice Property (invariant I3): lot IDs are sequential from 1, rejected
 *         registrations never consume an ID, and batchIdOf and verifyBatch
 *         agree for every registered lot.
 *
 * @dev Each run registers between 1 and 16 lots whose product hashes derive
 *      from the fuzzed `seed`, alternating between the two manufacturers as
 *      `pattern` dictates, because IDs are global and not per manufacturer.
 *      Before some registrations (again chosen by `pattern`) the other
 *      manufacturer tries to register an earlier lot's hash again. That must
 *      revert DuplicateProduct naming the earlier lot, and the next
 *      successful registration must still get the next ID.
 *
 *      Runs: 128 (set inline below). A run makes at most 31 registration
 *      attempts (16 lots and 15 duplicates).
 */
contract LotIdPropertiesTest is RegistryTestBase {
    uint256 private constant MAX_LOTS = 16;

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_lotIdsAreSequentialAndLookupsAgree(bytes32 seed, uint8 rawCount, uint256 pattern) public {
        uint256 count = 1 + uint256(rawCount) % MAX_LOTS;

        for (uint256 i = 0; i < count; i++) {
            address manufacturer = _manufacturerFor(pattern, i);
            if (i > 0 && (pattern >> (MAX_LOTS + i)) & 1 == 1) {
                _assertDuplicateRejected(seed, (pattern >> 128) % i, _otherManufacturer(manufacturer));
            }

            uint256 batchId = _register(manufacturer, _hashOf(seed, i));
            vm.assertEq(batchId, i + 1, "lot IDs are not sequential from 1");
            vm.assertEq(registry.totalBatches(), i + 1, "totalBatches() is not the number of lots");
        }

        // Every ID resolves to the lot registered with that hash, and back.
        for (uint256 batchId = 1; batchId <= count; batchId++) {
            IProvenanceRegistry.Batch memory batch = registry.verifyBatch(batchId);
            vm.assertEq(batch.productHash, _hashOf(seed, batchId - 1), "verifyBatch returned another lot's hash");
            vm.assertEq(batch.manufacturer, _manufacturerFor(pattern, batchId - 1), "verifyBatch returned another origin");
        }
        _assertIdInvariants(count);

        // A hash nobody registered maps to no lot.
        vm.assertEq(registry.batchIdOf(_hashOf(seed, count)), 0, "an unregistered hash maps to a lot");
    }

    function _hashOf(bytes32 seed, uint256 index) private pure returns (bytes32) {
        return keccak256(abi.encode(seed, index));
    }

    function _manufacturerFor(uint256 pattern, uint256 index) private pure returns (address) {
        return (pattern >> index) & 1 == 0 ? MANUFACTURER_A : MANUFACTURER_B;
    }

    function _otherManufacturer(address manufacturer) private pure returns (address) {
        return manufacturer == MANUFACTURER_A ? MANUFACTURER_B : MANUFACTURER_A;
    }

    /// @dev Re-registering the hash of lot `earlierIndex + 1` reverts with
    ///      exactly DuplicateProduct(hash, earlierIndex + 1), because every
    ///      other input is valid, and consumes no ID.
    function _assertDuplicateRejected(bytes32 seed, uint256 earlierIndex, address manufacturer) private {
        bytes32 productHash = _hashOf(seed, earlierIndex);
        uint256 countBefore = registry.totalBatches();
        IProvenanceRegistry.DocumentRef memory metadata = _doc("duplicate-metadata");

        vm.prank(manufacturer);
        try registry.registerBatch(productHash, uint64(block.timestamp), MIN_TEMP, MAX_TEMP, metadata) returns (uint256) {
            vm.assertTrue(false, "a duplicate product hash was registered");
        } catch (bytes memory reason) {
            vm.assertEq(
                reason,
                abi.encodeWithSelector(IProvenanceRegistry.DuplicateProduct.selector, productHash, earlierIndex + 1),
                "a duplicate did not revert DuplicateProduct(hash, existing lot)"
            );
        }
        vm.assertEq(registry.totalBatches(), countBefore, "a rejected duplicate consumed a lot ID");
    }
}
