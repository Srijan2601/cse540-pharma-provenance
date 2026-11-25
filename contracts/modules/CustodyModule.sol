// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RegistryBase} from "../base/RegistryBase.sol";
import {IProvenanceRegistry} from "../interfaces/IProvenanceRegistry.sol";

/**
 * @title CustodyModule
 * @notice The custody part of the registry: a manufacturer registers a lot,
 *         and the lot then moves from organization to organization until a
 *         pharmacy marks it delivered (data flows 1 "Register" and 2 "Hand off").
 *
 * @dev Functions and the roles that may call them:
 *        registerBatch     MANUFACTURER
 *        initiateTransfer  MANUFACTURER or DISTRIBUTOR, custodian of the lot
 *        acceptTransfer    DISTRIBUTOR or RETAILER, named recipient of the hand-off
 *        cancelTransfer    MANUFACTURER or DISTRIBUTOR, custodian of the lot
 *        updateStatus      DISTRIBUTOR, custodian of the lot
 *        markDelivered     RETAILER, custodian of the lot
 *
 *      Two rules shape this module.
 *
 *      Role AND custodianship (design decision C4). A role says what kind of
 *      organization the caller is; it does not say which lots are theirs. So
 *      every function that acts on an existing lot checks the role first and
 *      then that the caller is that lot's custodian (or, for acceptTransfer,
 *      the recipient the custodian named). Rival distributors share this
 *      registry, and neither can touch the other's lots.
 *
 *      Two signatures per hand-off (design decision C3). Custody moves only
 *      when the sender has named the recipient (initiateTransfer) and the
 *      recipient has agreed (acceptTransfer). The sender cannot push a lot
 *      onto an organization that never received it, and the recipient cannot
 *      take a lot that was not offered. Each half leaves its own event
 *      (TransferInitiated, CustodyTransferred) in a transaction signed by
 *      that party.
 *
 *      This module is abstract. It shares its storage and guards with the
 *      other modules through RegistryBase and is deployed as part of
 *      ProvenanceRegistry.
 */
abstract contract CustodyModule is RegistryBase {
    // =====================================================================
    //                   MANUFACTURER (journey stage: Creation)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    /// @dev A zero product hash is rejected because it is the value of a
    ///      bytes32 that was never set. It points to a client that forgot to
    ///      compute the hash, not to the keccak256 of a real product code and
    ///      lot number.
    ///
    ///      The temperature range is fixed here for the life of the lot: no
    ///      function changes it, so an excursion is always judged against the
    ///      range the manufacturer declared at registration.
    function registerBatch(
        bytes32 productHash,
        uint64 manufactureDate,
        int16 minTempTenthsC,
        int16 maxTempTenthsC,
        DocumentRef calldata metadata
    ) external onlyRole(MANUFACTURER_ROLE) returns (uint256 batchId) {
        if (productHash == bytes32(0)) revert ZeroProductHash();
        _requirePastTimestamp(manufactureDate);
        if (minTempTenthsC >= maxTempTenthsC) {
            revert InvalidTemperatureRange(minTempTenthsC, maxTempTenthsC);
        }
        _requireDocument(metadata);

        uint256 existingBatchId = _batchIdByProductHash[productHash];
        if (existingBatchId != 0) revert DuplicateProduct(productHash, existingBatchId);

        // IDs are a simple counter starting at 1, so they are unique, never
        // reused, and a QR code only has to carry a small number.
        batchId = ++_batchCount;
        _batchIdByProductHash[productHash] = batchId;

        // The manufacturer is both the origin (fixed for good) and the first
        // custodian. pendingCustodian, sensorLogCount, certificate and
        // latestSensorLog keep their zero defaults: no hand-off is open, no
        // log is anchored and the lot is not certified yet.
        Batch storage batch = _batches[batchId];
        batch.id = batchId;
        batch.productHash = productHash;
        batch.manufacturer = msg.sender;
        batch.custodian = msg.sender;
        batch.manufactureDate = manufactureDate;
        batch.registeredAt = uint64(block.timestamp); // Unix seconds fit in 64 bits for ~584 billion years
        batch.status = Status.Created;
        batch.minTempTenthsC = minTempTenthsC;
        batch.maxTempTenthsC = maxTempTenthsC;
        batch.metadata = metadata;

        emit BatchRegistered(batchId, msg.sender, productHash, metadata.cid);
    }

    // =====================================================================
    //          CUSTODY HAND-OFF (journey stages: Shipment, Storage)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    /// @dev Custody stays with the caller until the recipient accepts, so the
    ///      sender remains accountable for a lot that is on the road.
    function initiateTransfer(uint256 batchId, address to)
        external
        onlyEitherRole(MANUFACTURER_ROLE, DISTRIBUTOR_ROLE)
    {
        Batch storage batch = _loadBatch(batchId);
        _requireCustodian(batchId, batch);
        _requireNoPendingTransfer(batchId, batch);

        // A lot leaves from a resting status: Created (first shipment from the
        // factory) or Stored (onward shipment). This rejects the three terminal
        // statuses, and also a lot that its distributor has set InTransit with
        // updateStatus; that lot has to be Stored again before it is handed on.
        Status current = batch.status;
        if (current != Status.Created && current != Status.Stored) {
            revert InvalidStatus(batchId, current);
        }

        if (to == address(0) || to == msg.sender || !_isAllowedRoute(to)) {
            revert InvalidRecipient(to);
        }

        // Remember where the lot was, so that cancelTransfer can put it back.
        _statusBeforeTransfer[batchId] = current;
        batch.pendingCustodian = to;
        batch.status = Status.InTransit;

        emit TransferInitiated(batchId, msg.sender, to);
    }

    /// @inheritdoc IProvenanceRegistry
    /// @dev No status check is needed: an open hand-off implies InTransit
    ///      (invariant I1), and a lot that became Compromised or Recalled has
    ///      had its hand-off cleared (I2), so it fails with NoPendingTransfer.
    ///
    ///      The route was validated when the hand-off was opened and is not
    ///      validated again here. The recipient only has to hold one of the two
    ///      receiving roles at the time it accepts.
    function acceptTransfer(uint256 batchId)
        external
        onlyEitherRole(DISTRIBUTOR_ROLE, RETAILER_ROLE)
    {
        Batch storage batch = _loadBatch(batchId);
        address pendingCustodian = _requirePendingTransfer(batchId, batch);
        if (pendingCustodian != msg.sender) revert NotPendingCustodian(batchId, msg.sender);

        address previousCustodian = batch.custodian;
        batch.custodian = msg.sender;
        _clearPendingTransfer(batch);
        batch.status = Status.Stored;

        emit CustodyTransferred(batchId, previousCustodian, msg.sender);
    }

    /// @inheritdoc IProvenanceRegistry
    /// @dev Only the custodian can cancel. The named recipient has no "reject"
    ///      call; it declines by not accepting, and the custodian cancels.
    function cancelTransfer(uint256 batchId)
        external
        onlyEitherRole(MANUFACTURER_ROLE, DISTRIBUTOR_ROLE)
    {
        Batch storage batch = _loadBatch(batchId);
        _requireCustodian(batchId, batch);
        address formerPendingCustodian = _requirePendingTransfer(batchId, batch);

        // Undo initiateTransfer exactly: the lot never left its custodian, so
        // it returns to the status it had (Created or Stored), not to a new one.
        _clearPendingTransfer(batch);
        batch.status = _statusBeforeTransfer[batchId];

        emit TransferCancelled(batchId, msg.sender, formerPendingCustodian);
    }

    /// @inheritdoc IProvenanceRegistry
    /// @dev This is a distributor's internal movement (warehouse to truck and
    ///      back) and never changes custody. It is blocked while a hand-off is
    ///      open, because that lot must stay InTransit until the hand-off is
    ///      accepted or cancelled (invariant I1).
    function updateStatus(uint256 batchId, Status newStatus) external onlyRole(DISTRIBUTOR_ROLE) {
        Batch storage batch = _loadBatch(batchId);
        _requireCustodian(batchId, batch);
        _requireNoPendingTransfer(batchId, batch);

        // Exactly two pairs are legal. Everything else falls through to the
        // revert: a no-op update, a jump to Delivered, Compromised or Recalled
        // (those belong to the pharmacy, the oracle and the regulator), and
        // any update of a Created or terminal lot.
        Status current = batch.status;
        bool toStored = current == Status.InTransit && newStatus == Status.Stored;
        bool toInTransit = current == Status.Stored && newStatus == Status.InTransit;
        if (!toStored && !toInTransit) {
            revert InvalidStatusTransition(batchId, current, newStatus);
        }

        batch.status = newStatus;

        emit StatusUpdated(batchId, current, newStatus, msg.sender);
    }

    /// @inheritdoc IProvenanceRegistry
    /// @dev Stored implies that no hand-off is open (invariant I1), so the
    ///      status check alone keeps I2 true for the new Delivered status.
    function markDelivered(uint256 batchId) external onlyRole(RETAILER_ROLE) {
        Batch storage batch = _loadBatch(batchId);
        _requireCustodian(batchId, batch);

        Status current = batch.status;
        if (current != Status.Stored) revert InvalidStatus(batchId, current);

        batch.status = Status.Delivered;

        emit StatusUpdated(batchId, Status.Stored, Status.Delivered, msg.sender);
    }

    // =====================================================================
    //                                INTERNAL
    // =====================================================================

    /// @dev Whether the caller may hand a lot to `to` (design decision C3).
    ///        to a DISTRIBUTOR: always. The role modifier has already
    ///                          established that the caller is a manufacturer
    ///                          or a distributor.
    ///        to a RETAILER:    only when the caller holds DISTRIBUTOR_ROLE.
    ///                          In the proposal's supply chain every lot
    ///                          reaches the pharmacy through a distributor, so
    ///                          an account that is only a manufacturer cannot
    ///                          ship straight to a pharmacy. The rule looks at
    ///                          roles, not organizations: a manufacturer that
    ///                          the regulator has also made a distributor acts
    ///                          as its own distributor and may.
    ///      Any other recipient is refused. That covers accounts with no
    ///      receiving role, which cannot call acceptTransfer. It also means a
    ///      mistyped address is refused unless it happens to belong to another
    ///      onboarded organization.
    function _isAllowedRoute(address to) private view returns (bool) {
        if (hasRole(DISTRIBUTOR_ROLE, to)) return true;
        return hasRole(RETAILER_ROLE, to) && hasRole(DISTRIBUTOR_ROLE, msg.sender);
    }
}
