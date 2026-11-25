// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RegistryBase} from "../base/RegistryBase.sol";
import {IProvenanceRegistry} from "../interfaces/IProvenanceRegistry.sol";

/**
 * @title CertificationModule
 * @notice The certification part of the registry: the regulator attaches
 *         certificates to lots and recalls lots (data flow 4, "Oversee").
 *
 * @dev Functions (both REGULATOR only):
 *        issueCertificate  attach or replace a lot's certificate; the status
 *                          is unchanged
 *        recallBatch       move a lot to Recalled, from any other status
 *
 *      The regulator's third duty in data flow 4, onboarding organizations,
 *      needs no code here. It is grantRole and revokeRole, inherited from
 *      OpenZeppelin AccessControl, with REGULATOR_ROLE set as the admin of the
 *      organization roles in the RegistryBase constructor.
 *
 *      Unlike the custody functions, these do not depend on who holds the
 *      lot. Oversight has to work at any stage, including against the
 *      custodian's wishes, so the regulator never needs custody.
 *
 *      Trust assumption: the regulator key is trusted (proposal section 2).
 *      The contract accepts its certificates and recalls without a second
 *      opinion. A recall is final: no function lifts it, so a recalled lot can
 *      never be made to look valid again.
 *
 *      This module is abstract. It shares its storage and guards with the
 *      other modules through RegistryBase and is deployed as part of
 *      ProvenanceRegistry.
 */
abstract contract CertificationModule is RegistryBase {
    // =====================================================================
    //                      REGULATOR (journey stage: all)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    /// @dev Design decision C6: only the newest certificate is stored and a
    ///      new one overwrites it. Earlier certificates remain in the
    ///      CertificateIssued events, so the full history can be audited
    ///      without an array that grows in storage. The certificate is a
    ///      statement about the lot, not a gate: the custody functions do not
    ///      require one.
    function issueCertificate(uint256 batchId, DocumentRef calldata certificate)
        external
        onlyRole(REGULATOR_ROLE)
    {
        Batch storage batch = _loadBatch(batchId);
        _requireNotRecalled(batchId, batch);
        _requireDocument(certificate);

        batch.certificate = certificate;

        emit CertificateIssued(batchId, msg.sender, certificate.cid, certificate.contentHash);
    }

    /// @inheritdoc IProvenanceRegistry
    /// @dev The reason must not be empty, because the BatchRecalled event is
    ///      the only place it is recorded: it is the explanation that a reader
    ///      of the lot's history finds. It is not stored in the lot record.
    function recallBatch(uint256 batchId, string calldata reason)
        external
        onlyRole(REGULATOR_ROLE)
    {
        Batch storage batch = _loadBatch(batchId);
        _requireNotRecalled(batchId, batch);
        if (bytes(reason).length == 0) revert EmptyReason();

        // A recalled lot must not change hands. Clearing the hand-off stops
        // the named recipient from accepting it afterwards and keeps the lot
        // with the custodian that held it when it was recalled.
        _clearPendingTransfer(batch);
        batch.status = Status.Recalled;

        emit BatchRecalled(batchId, msg.sender, reason);
    }
}
