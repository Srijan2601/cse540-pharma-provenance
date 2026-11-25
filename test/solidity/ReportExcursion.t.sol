// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProvenanceRegistry} from "../../contracts/interfaces/IProvenanceRegistry.sol";
import {RegistryTestBase, Vm} from "./RegistryTestBase.sol";

/**
 * @title ReportExcursionPropertiesTest
 * @notice Property: reportExcursion succeeds exactly when the reading lies
 *         outside the lot's registered range [min, max] (both bounds count as
 *         in range). On success the lot is Compromised, has no open hand-off,
 *         stays with its custodian, and the report becomes the lot's next
 *         sensor log. On failure the call reverts ReadingWithinRange and
 *         changes nothing.
 *
 * @dev Each run registers a lot with a fuzzed range and brings it into one
 *      of the four active situations an oracle can meet (fuzzed too):
 *        Created             still at the factory
 *        HandOffOpen         InTransit with an open hand-off to a distributor
 *        Stored              accepted by the distributor, one log anchored
 *        MovedByDistributor  set InTransit by the distributor with
 *                            updateStatus (no hand-off), one log anchored
 *      Every other input is valid, so the reading alone decides the outcome.
 *
 *      Two of the four reading modes keep the raw fuzzed reading, which can
 *      fall on either side of the fuzzed range. The other two place it on or
 *      next to a bound (min - 1, min, min + 1, max - 1, max, max + 1), where
 *      an off-by-one error would show.
 *
 *      Runs: 512 (set inline below).
 */
contract ReportExcursionPropertiesTest is RegistryTestBase {
    enum Situation {
        Created,
        HandOffOpen,
        Stored,
        MovedByDistributor
    }

    bytes32 private constant PRODUCT_HASH = keccak256(abi.encode("NDC-0000-0000-00", "LOT-EXCURSION"));

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_reportExcursionSucceedsExactlyWhenReadingIsOutsideRange(
        int16 minTempTenthsC,
        int16 maxTempTenthsC,
        int16 readingTenthsC,
        uint8 readingMode,
        uint8 situation,
        uint64 observedAt
    ) public {
        (minTempTenthsC, maxTempTenthsC) = _validRange(minTempTenthsC, maxTempTenthsC);
        uint256 batchId = _registerWithRange(MANUFACTURER_A, PRODUCT_HASH, minTempTenthsC, maxTempTenthsC);
        _bringTo(batchId, Situation(situation % 4));

        readingTenthsC = _shapeReading(readingTenthsC, minTempTenthsC, maxTempTenthsC, readingMode);
        // Any time from 1 up to the current block is a valid observation time.
        observedAt = uint64(1 + uint256(observedAt) % block.timestamp);

        _checkReport(batchId, readingTenthsC, observedAt);
    }

    // =====================================================================
    //                               HELPERS
    // =====================================================================

    /// @dev Turn two arbitrary values into a valid range (min < max).
    function _validRange(int16 a, int16 b) private pure returns (int16 minTempTenthsC, int16 maxTempTenthsC) {
        if (a == b) {
            if (a == type(int16).max) return (a - 1, a);
            return (a, a + 1);
        }
        if (a < b) return (a, b);
        return (b, a);
    }

    function _bringTo(uint256 batchId, Situation situation) private {
        if (situation == Situation.Created) return;

        if (situation == Situation.HandOffOpen) {
            vm.prank(MANUFACTURER_A);
            registry.initiateTransfer(batchId, DISTRIBUTOR_A);
            return;
        }

        _handOff(batchId, MANUFACTURER_A, DISTRIBUTOR_A);
        if (situation == Situation.MovedByDistributor) {
            vm.prank(DISTRIBUTOR_A);
            registry.updateStatus(batchId, IProvenanceRegistry.Status.InTransit);
        }
        // A routine log first, so the excursion must become log number 2:
        // both oracle functions number their logs in one sequence.
        IProvenanceRegistry.DocumentRef memory routineLog = _doc("routine-log");
        vm.prank(ORACLE);
        registry.anchorSensorLog(batchId, routineLog);
    }

    /// @dev Keep the raw reading (modes 0 and 3), or move it onto or next to
    ///      the lower (mode 1) or upper (mode 2) bound. The upper bits of
    ///      `mode` pick the offset -1, 0 or +1. An offset that would leave the
    ///      int16 range keeps the raw reading.
    function _shapeReading(int16 reading, int16 minTempTenthsC, int16 maxTempTenthsC, uint8 mode)
        private
        pure
        returns (int16)
    {
        uint256 kind = mode % 4;
        if (kind == 0 || kind == 3) return reading;

        int256 bound = kind == 1 ? int256(minTempTenthsC) : int256(maxTempTenthsC);
        int256 shaped = bound + int256(uint256(mode >> 2) % 3) - 1;
        if (shaped < type(int16).min || shaped > type(int16).max) return reading;
        return int16(shaped);
    }

    function _checkReport(uint256 batchId, int16 reading, uint64 observedAt) private {
        IProvenanceRegistry.Batch memory before = registry.verifyBatch(batchId);
        IProvenanceRegistry.DocumentRef memory sensorLog = _doc("excursion-log");
        bool outside = reading < before.minTempTenthsC || reading > before.maxTempTenthsC;

        vm.recordLogs();
        vm.prank(ORACLE);
        try registry.reportExcursion(batchId, reading, observedAt, sensorLog) {
            vm.assertTrue(outside, "reportExcursion accepted a reading inside the range");
            _assertCompromised(batchId, before, reading, observedAt, sensorLog);
        } catch (bytes memory reason) {
            vm.assertTrue(!outside, "reportExcursion rejected a reading outside the range");
            vm.assertEq(
                reason,
                abi.encodeWithSelector(
                    IProvenanceRegistry.ReadingWithinRange.selector, reading, before.minTempTenthsC, before.maxTempTenthsC
                ),
                "an in-range reading did not revert ReadingWithinRange(reading, min, max)"
            );
            IProvenanceRegistry.Batch memory unchanged = registry.verifyBatch(batchId);
            vm.assertEq(uint256(unchanged.status), uint256(before.status), "a rejected report changed the status");
            vm.assertEq(unchanged.pendingCustodian, before.pendingCustodian, "a rejected report changed the hand-off");
            vm.assertEq(uint256(unchanged.sensorLogCount), uint256(before.sensorLogCount), "a rejected report was counted");
        }
    }

    function _assertCompromised(
        uint256 batchId,
        IProvenanceRegistry.Batch memory before,
        int16 reading,
        uint64 observedAt,
        IProvenanceRegistry.DocumentRef memory sensorLog
    ) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertSingleRegistryEvent(logs, IProvenanceRegistry.ExcursionReported.selector, batchId);
        (uint32 logIndex, int16 loggedReading, uint64 loggedAt, string memory logCid, bytes32 logHash) =
            abi.decode(logs[0].data, (uint32, int16, uint64, string, bytes32));
        vm.assertEq(uint256(logIndex), uint256(before.sensorLogCount) + 1, "the excursion log is not the next log");
        vm.assertEq(int256(loggedReading), int256(reading), "ExcursionReported carries another reading");
        vm.assertEq(uint256(loggedAt), uint256(observedAt), "ExcursionReported carries another time");
        vm.assertEq(logCid, sensorLog.cid, "ExcursionReported carries another log CID");
        vm.assertEq(logHash, sensorLog.contentHash, "ExcursionReported carries another log hash");

        IProvenanceRegistry.Batch memory batch = registry.verifyBatch(batchId);
        vm.assertEq(uint256(batch.status), uint256(IProvenanceRegistry.Status.Compromised), "the lot is not Compromised");
        vm.assertEq(batch.pendingCustodian, address(0), "the open hand-off was not cleared");
        vm.assertEq(batch.custodian, before.custodian, "an excursion moved custody");
        vm.assertEq(uint256(batch.sensorLogCount), uint256(logIndex), "sensorLogCount is not the new log number");
        vm.assertEq(batch.latestSensorLog.cid, sensorLog.cid, "latestSensorLog cid is not the excursion log");
        vm.assertEq(batch.latestSensorLog.contentHash, sensorLog.contentHash, "latestSensorLog hash is not the excursion log");
        vm.assertEq(int256(batch.minTempTenthsC), int256(before.minTempTenthsC), "an excursion changed the range");
        vm.assertEq(int256(batch.maxTempTenthsC), int256(before.maxTempTenthsC), "an excursion changed the range");
    }
}
