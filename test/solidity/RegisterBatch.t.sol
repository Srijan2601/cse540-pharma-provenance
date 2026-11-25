// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProvenanceRegistry} from "../../contracts/interfaces/IProvenanceRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/**
 * @title RegisterBatchPropertiesTest
 * @notice Property: registerBatch succeeds exactly when its inputs are valid,
 *         and a successful call stores exactly the inputs it was given.
 *
 * @dev Valid means (specification E): a non-zero product hash that is not
 *      registered yet, 0 < manufactureDate <= block.timestamp,
 *      minTempTenthsC < maxTempTenthsC, and metadata with a non-empty CID and
 *      a non-zero content hash.
 *
 *      Uniform random inputs would almost never be valid (a random uint64
 *      date lies in the future), so each run first shapes the raw fuzz
 *      values: for each of the five rules, two bits of `shape` decide whether
 *      the run breaks that rule (one value of the two bits in four) or moves
 *      the raw value into the valid domain. For a uniformly random `shape`
 *      that makes 0.75^5, about 24%, of the runs fully valid; the others
 *      break one or more rules in every combination. The expected outcome is
 *      then computed from the final values alone, never from `shape`, so the
 *      shaping can only change how often each case occurs, not what the test
 *      asserts.
 *
 *      The specification leaves the order of registerBatch's checks open. When
 *      a run breaks several rules, the revert must name one of them, and the
 *      test does not care which.
 *
 *      Runs: 512 (set inline below; the project default is 256).
 */
contract RegisterBatchPropertiesTest is RegistryTestBase {
    /// @dev The inputs of one call, kept together to stay within the EVM stack limit.
    struct Input {
        bytes32 productHash;
        uint64 manufactureDate;
        int16 minTempTenthsC;
        int16 maxTempTenthsC;
        IProvenanceRegistry.DocumentRef metadata;
    }

    /// @dev Registered by MANUFACTURER_A in setUp(), so that runs can hit DuplicateProduct.
    bytes32 private constant EXISTING_HASH = keccak256(abi.encode("NDC-0000-0000-00", "LOT-EXISTING"));

    /// @dev Every run registers as MANUFACTURER_B. A duplicate of EXISTING_HASH
    ///      is therefore another firm's lot, which design decision C5 also rejects.
    address private constant CALLER = MANUFACTURER_B;

    function setUp() public override {
        super.setUp();
        _register(MANUFACTURER_A, EXISTING_HASH);
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_registerBatchSucceedsExactlyWhenInputsAreValid(
        bytes32 productHash,
        uint64 manufactureDate,
        int16 minTempTenthsC,
        int16 maxTempTenthsC,
        string memory cid,
        bytes32 contentHash,
        uint256 shape
    ) public {
        Input memory input = _shape(
            Input(productHash, manufactureDate, minTempTenthsC, maxTempTenthsC, IProvenanceRegistry.DocumentRef(cid, contentHash)),
            shape
        );
        (bytes[] memory brokenRules, uint256 brokenCount) = _brokenRules(input);

        uint256 countBefore = registry.totalBatches();
        uint256 lookupBefore = registry.batchIdOf(input.productHash);

        vm.recordLogs();
        vm.prank(CALLER);
        try registry.registerBatch(
            input.productHash, input.manufactureDate, input.minTempTenthsC, input.maxTempTenthsC, input.metadata
        ) returns (uint256 batchId) {
            vm.assertEq(brokenCount, 0, "registerBatch accepted an invalid input");
            _assertRegistered(batchId, countBefore, input);
        } catch (bytes memory reason) {
            vm.assertTrue(brokenCount > 0, "registerBatch rejected a valid input");
            vm.assertTrue(_contains(brokenRules, brokenCount, reason), "the revert names none of the broken rules");
            // A rejected call changes nothing and consumes no ID (I3).
            vm.assertEq(registry.totalBatches(), countBefore, "a rejected registration consumed a lot ID");
            vm.assertEq(registry.batchIdOf(input.productHash), lookupBefore, "a rejected registration changed batchIdOf");
        }
    }

    // =====================================================================
    //                               HELPERS
    // =====================================================================

    /// @dev Rule `rule` (0-4) is broken when its two bits of `shape` are both 0.
    function _breaks(uint256 shape, uint256 rule) private pure returns (bool) {
        return (shape >> (2 * rule)) & 3 == 0;
    }

    /// @dev One more independent bit of `shape`, above the ten rule bits, for
    ///      choosing between variants of a case.
    function _bit(uint256 shape, uint256 index) private pure returns (bool) {
        return (shape >> index) & 1 == 1;
    }

    /// @dev Break or repair each rule as described in the contract comment.
    function _shape(Input memory input, uint256 shape) private view returns (Input memory) {
        // Rules 0 and 1, the product hash: zero, already registered, or fresh.
        if (_breaks(shape, 0)) {
            input.productHash = bytes32(0);
        } else if (_breaks(shape, 1)) {
            input.productHash = EXISTING_HASH;
        } else if (input.productHash == bytes32(0)) {
            input.productHash = keccak256(abi.encode(shape));
        }

        // Rule 2, the manufacture date: valid is 1..now. The boundary value
        // `now` gets a quarter of the valid runs because it is the one an
        // off-by-one in the contract would get wrong.
        uint256 currentTime = block.timestamp;
        if (_breaks(shape, 2)) {
            input.manufactureDate = _bit(shape, 20)
                ? 0
                : uint64(currentTime + 1 + uint256(input.manufactureDate) % (type(uint64).max - currentTime));
        } else if (_bit(shape, 21) && _bit(shape, 22)) {
            input.manufactureDate = uint64(currentTime);
        } else {
            input.manufactureDate = uint64(1 + uint256(input.manufactureDate) % currentTime);
        }

        // Rule 3, the temperature range: broken is an empty (min == max) or
        // inverted (min > max) range; repairing swaps or widens it by one.
        if (_breaks(shape, 3)) {
            if (_bit(shape, 23)) {
                input.maxTempTenthsC = input.minTempTenthsC;
            } else if (input.minTempTenthsC < input.maxTempTenthsC) {
                (input.minTempTenthsC, input.maxTempTenthsC) = (input.maxTempTenthsC, input.minTempTenthsC);
            }
        } else if (input.minTempTenthsC == input.maxTempTenthsC) {
            if (input.maxTempTenthsC == type(int16).max) input.minTempTenthsC -= 1;
            else input.maxTempTenthsC += 1;
        } else if (input.minTempTenthsC > input.maxTempTenthsC) {
            (input.minTempTenthsC, input.maxTempTenthsC) = (input.maxTempTenthsC, input.minTempTenthsC);
        }

        // Rule 4, the metadata reference: broken is a missing CID or a
        // missing content hash; repairing fills in whichever half is empty.
        if (_breaks(shape, 4)) {
            if (_bit(shape, 24)) input.metadata.cid = "";
            else input.metadata.contentHash = bytes32(0);
        } else {
            if (bytes(input.metadata.cid).length == 0) input.metadata.cid = "bafkrei-fuzz-metadata";
            if (input.metadata.contentHash == bytes32(0)) input.metadata.contentHash = keccak256(bytes(input.metadata.cid));
        }
        return input;
    }

    /// @dev The encoded error of every rule that `input` breaks, judged from
    ///      the values themselves. The first `count` entries are used.
    function _brokenRules(Input memory input) private view returns (bytes[] memory errors, uint256 count) {
        errors = new bytes[](5);
        if (input.productHash == bytes32(0)) {
            errors[count++] = abi.encodeWithSelector(IProvenanceRegistry.ZeroProductHash.selector);
        }
        if (input.manufactureDate == 0 || input.manufactureDate > block.timestamp) {
            errors[count++] = abi.encodeWithSelector(IProvenanceRegistry.InvalidTimestamp.selector, input.manufactureDate);
        }
        if (input.minTempTenthsC >= input.maxTempTenthsC) {
            errors[count++] = abi.encodeWithSelector(
                IProvenanceRegistry.InvalidTemperatureRange.selector, input.minTempTenthsC, input.maxTempTenthsC
            );
        }
        if (bytes(input.metadata.cid).length == 0 || input.metadata.contentHash == bytes32(0)) {
            errors[count++] = abi.encodeWithSelector(IProvenanceRegistry.EmptyDocument.selector);
        }
        uint256 existingBatchId = registry.batchIdOf(input.productHash);
        if (existingBatchId != 0) {
            errors[count++] = abi.encodeWithSelector(
                IProvenanceRegistry.DuplicateProduct.selector, input.productHash, existingBatchId
            );
        }
    }

    function _contains(bytes[] memory errors, uint256 count, bytes memory reason) private pure returns (bool) {
        for (uint256 i = 0; i < count; i++) {
            if (keccak256(errors[i]) == keccak256(reason)) return true;
        }
        return false;
    }

    /// @dev A successful call took the next ID, stored every input unchanged
    ///      with the documented defaults, and emitted one BatchRegistered.
    function _assertRegistered(uint256 batchId, uint256 countBefore, Input memory input) private {
        _assertSingleRegistryEvent(vm.getRecordedLogs(), IProvenanceRegistry.BatchRegistered.selector, batchId);

        vm.assertEq(batchId, countBefore + 1, "the new lot did not get the next ID");
        vm.assertEq(registry.totalBatches(), batchId, "totalBatches() did not grow by one");
        vm.assertEq(registry.batchIdOf(input.productHash), batchId, "batchIdOf does not return the new lot");

        IProvenanceRegistry.Batch memory batch = registry.verifyBatch(batchId);
        vm.assertEq(batch.id, batchId, "stored id");
        vm.assertEq(batch.productHash, input.productHash, "stored productHash");
        vm.assertEq(batch.manufacturer, CALLER, "stored manufacturer is not the caller");
        vm.assertEq(batch.custodian, CALLER, "first custodian is not the caller");
        vm.assertEq(batch.pendingCustodian, address(0), "a new lot has an open hand-off");
        vm.assertEq(uint256(batch.manufactureDate), uint256(input.manufactureDate), "stored manufactureDate");
        vm.assertEq(uint256(batch.registeredAt), block.timestamp, "registeredAt is not the block timestamp");
        vm.assertEq(uint256(batch.status), uint256(IProvenanceRegistry.Status.Created), "a new lot is not Created");
        vm.assertEq(int256(batch.minTempTenthsC), int256(input.minTempTenthsC), "stored minTempTenthsC");
        vm.assertEq(int256(batch.maxTempTenthsC), int256(input.maxTempTenthsC), "stored maxTempTenthsC");
        vm.assertEq(uint256(batch.sensorLogCount), 0, "a new lot has sensor logs");
        vm.assertEq(batch.metadata.cid, input.metadata.cid, "stored metadata cid");
        vm.assertEq(batch.metadata.contentHash, input.metadata.contentHash, "stored metadata contentHash");
        vm.assertEq(bytes(batch.certificate.cid).length, 0, "a new lot is already certified");
        vm.assertEq(batch.certificate.contentHash, bytes32(0), "a new lot has a certificate hash");
        vm.assertEq(bytes(batch.latestSensorLog.cid).length, 0, "a new lot has a latest sensor log");
        vm.assertEq(batch.latestSensorLog.contentHash, bytes32(0), "a new lot has a sensor log hash");
    }
}
