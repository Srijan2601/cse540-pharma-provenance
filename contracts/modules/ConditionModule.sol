// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RegistryBase} from "../base/RegistryBase.sol";
import {IProvenanceRegistry} from "../interfaces/IProvenanceRegistry.sol";

/**
 * @title ConditionModule
 * @notice The condition part of the registry: the IoT oracle anchors
 *         temperature-sensor logs to a lot and reports excursions, which flag
 *         the lot Compromised (data flow 3, "Monitor").
 *
 * @dev Functions (both ORACLE only, both on active lots only):
 *        anchorSensorLog   record a routine sensor log; the status is unchanged
 *        reportExcursion   record the log with an out-of-range reading; the
 *                          lot becomes Compromised
 *
 *      Only the latest log is stored (design decision C7). A lot can collect
 *      any number of logs on its journey. Keeping them all in an array would
 *      make the record grow without limit and make verifyBatch more expensive
 *      to return with every log. The contract keeps the newest reference and a
 *      counter instead. Every earlier log is still recoverable, because each
 *      call emits an event that carries the log's index, CID and content hash,
 *      and a lot's history is read from its events in any case (data flow 5).
 *
 *      Trust assumption: the oracle key is trusted for sensor data. The
 *      contract can compare a REPORTED reading with the lot's registered
 *      range, but it cannot see the sensor, so it cannot tell a true reading
 *      from an invented one. What it does guarantee is narrower: only the
 *      ORACLE role can write here, an excursion must name a reading that lies
 *      outside the registered range, and each report is tied to a log file
 *      whose hash is on-chain, so the claim can be audited afterwards.
 *
 *      This module is abstract. It shares its storage and guards with the
 *      other modules through RegistryBase and is deployed as part of
 *      ProvenanceRegistry.
 */
abstract contract ConditionModule is RegistryBase {
    // =====================================================================
    //           IoT ORACLE (journey stages: Shipment, Storage)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    /// @dev Logs are accepted for active lots only. After delivery, an
    ///      excursion or a recall, the monitored journey is over and the record
    ///      of it is closed.
    function anchorSensorLog(uint256 batchId, DocumentRef calldata sensorLog)
        external
        onlyRole(ORACLE_ROLE)
    {
        Batch storage batch = _loadBatch(batchId);
        _requireActive(batchId, batch);
        _requireDocument(sensorLog);

        uint32 logIndex = _recordSensorLog(batch, sensorLog);

        emit SensorLogAnchored(batchId, logIndex, sensorLog.cid, sensorLog.contentHash);
    }

    /// @inheritdoc IProvenanceRegistry
    /// @dev The range check is inclusive: a reading equal to the minimum or
    ///      the maximum is still within the allowed range and is rejected.
    ///
    ///      The off-chain rule for when a reading counts as an excursion (for
    ///      example, several out-of-range samples in a row) belongs to the
    ///      oracle. This function only refuses reports that contradict the
    ///      lot's own range.
    function reportExcursion(
        uint256 batchId,
        int16 readingTenthsC,
        uint64 observedAt,
        DocumentRef calldata sensorLog
    ) external onlyRole(ORACLE_ROLE) {
        Batch storage batch = _loadBatch(batchId);
        _requireActive(batchId, batch);
        _requirePastTimestamp(observedAt);

        int16 minTempTenthsC = batch.minTempTenthsC;
        int16 maxTempTenthsC = batch.maxTempTenthsC;
        if (readingTenthsC >= minTempTenthsC && readingTenthsC <= maxTempTenthsC) {
            revert ReadingWithinRange(readingTenthsC, minTempTenthsC, maxTempTenthsC);
        }
        _requireDocument(sensorLog);

        uint32 logIndex = _recordSensorLog(batch, sensorLog);

        // A compromised lot must not change hands. Clearing the hand-off stops
        // the named recipient from accepting it afterwards and keeps the lot
        // with the custodian that held it when the excursion was reported.
        _clearPendingTransfer(batch);
        batch.status = Status.Compromised;

        emit ExcursionReported(
            batchId,
            logIndex,
            readingTenthsC,
            observedAt,
            sensorLog.cid,
            sensorLog.contentHash
        );
    }

    // =====================================================================
    //                                INTERNAL
    // =====================================================================

    /// @dev Make `sensorLog` the lot's latest log and count it. Shared by both
    ///      oracle functions, so routine logs and excursion logs are numbered
    ///      in one sequence, starting at 1. The caller has already validated
    ///      the reference and emits the event that carries `logIndex`.
    ///
    ///      The counter is a uint32 that shares a storage slot with the lot's
    ///      status. It allows about 4.29 billion logs per lot; the checked
    ///      addition would revert rather than wrap around.
    /// @return logIndex The number of this log within the lot (the new sensorLogCount).
    function _recordSensorLog(Batch storage batch, DocumentRef calldata sensorLog)
        private
        returns (uint32 logIndex)
    {
        logIndex = batch.sensorLogCount + 1;
        batch.sensorLogCount = logIndex;
        batch.latestSensorLog = sensorLog;
    }
}
