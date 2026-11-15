// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IProvenanceRegistry} from "./interfaces/IProvenanceRegistry.sol";

/**
 * @title ProvenanceRegistry (DRAFT, Smart Contract Draft deliverable, 11/01)
 * @notice One shared, tamper-evident record per drug lot. Rival supply-chain
 *         organizations can write to it and anyone can verify it. See
 *         IProvenanceRegistry for the data model, events and full function docs.
 *
 * @dev Draft status:
 *      DONE  - roles and role administration (constructor + inherited AccessControl)
 *      DONE  - storage layout
 *      DONE  - read-only views (verifyBatch, totalBatches, batchIdOf)
 *      DONE  - access control on every write (role modifiers)
 *      TODO  - write-function bodies. Each one lists its steps as comments and
 *              reverts with NotImplemented() until it is written (target: the
 *              11/15 Amoy prototype).
 *
 *      Who can do what (proposal Table I; cancelTransfer is PROPOSED (C3), and
 *      revokeRole is the inherited counterpart of Table I's "grant roles"):
 *        MANUFACTURER  registerBatch, initiateTransfer, cancelTransfer
 *        DISTRIBUTOR   acceptTransfer, updateStatus, initiateTransfer, cancelTransfer
 *        RETAILER      acceptTransfer, markDelivered (+ verifyBatch, which is public)
 *        REGULATOR     grantRole/revokeRole for the four roles above, issueCertificate, recallBatch
 *        ORACLE        anchorSensorLog, reportExcursion
 *        anyone        verifyBatch, totalBatches, batchIdOf (patients need no wallet)
 */
contract ProvenanceRegistry is AccessControl, IProvenanceRegistry {
    // =====================================================================
    //                                 ROLES
    // =====================================================================
    // Each organization uses one wallet (proposal Fig. 1). The REGULATOR is
    // the admin of the four organization roles, so it onboards organizations
    // with grantRole(role, account) and offboards them with revokeRole.

    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant RETAILER_ROLE = keccak256("RETAILER_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @notice Draft only: thrown by write functions that are not written yet.
    error NotImplemented();

    // =====================================================================
    //                                STORAGE
    // =====================================================================

    /// @dev Number of lots registered. The next lot gets ID _batchCount + 1.
    uint256 private _batchCount;

    /// @dev Lot ID => record. IDs start at 1; ID 0 never exists.
    mapping(uint256 => Batch) private _batches;

    /// @dev productHash => lot ID. Used to reject duplicate registrations (C5).
    mapping(bytes32 => uint256) private _batchIdByProductHash;

    /// @dev Lot ID => the status before initiateTransfer set it to InTransit,
    ///      so cancelTransfer can restore it (C3).
    mapping(uint256 => Status) private _statusBeforeTransfer;

    /// @dev Draft only. Lets _notImplemented() be a state-changing function,
    ///      which keeps the compile free of "can be restricted to view" warnings.
    ///      Delete it together with _notImplemented().
    uint256 private _draftOnly;

    // =====================================================================
    //                              CONSTRUCTOR
    // =====================================================================

    /**
     * @param regulator The regulator's wallet. It receives REGULATOR_ROLE and
     *        DEFAULT_ADMIN_ROLE and becomes the admin of the MANUFACTURER,
     *        DISTRIBUTOR, RETAILER and ORACLE roles. This is PROPOSED (C4): our
     *        mapping of the proposal's "REGULATOR (admin)" onto OpenZeppelin.
     *        The deployer gets no role unless it is also the regulator.
     */
    constructor(address regulator) {
        if (regulator == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, regulator);
        _grantRole(REGULATOR_ROLE, regulator);

        _setRoleAdmin(MANUFACTURER_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(DISTRIBUTOR_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(RETAILER_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(ORACLE_ROLE, REGULATOR_ROLE);
    }

    // =====================================================================
    //                               MODIFIERS
    // =====================================================================

    /// @dev For functions that two roles may call, e.g. initiateTransfer
    ///      (MANUFACTURER or DISTRIBUTOR).
    modifier onlyEitherRole(bytes32 roleA, bytes32 roleB) {
        if (!hasRole(roleA, msg.sender) && !hasRole(roleB, msg.sender)) {
            revert MissingEitherRole(msg.sender, roleA, roleB);
        }
        _;
    }

    // =====================================================================
    //                   MANUFACTURER (journey stage: Creation)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    function registerBatch(
        bytes32 productHash,
        uint64 manufactureDate,
        int16 minTempTenthsC,
        int16 maxTempTenthsC,
        DocumentRef calldata metadata
    ) external onlyRole(MANUFACTURER_ROLE) returns (uint256 batchId) {
        // Validate inputs
        if (minTempTenthsC >= maxTempTenthsC) {
            revert InvalidTemperatureRange(minTempTenthsC, maxTempTenthsC);
        }
        _requireDocument(metadata);

        // One lot per product hash
        uint256 existing = _batchIdByProductHash[productHash];
        if (existing != 0) revert DuplicateProduct(productHash, existing);

        // New ID, starting at 1
        batchId = ++_batchCount;
        _batchIdByProductHash[productHash] = batchId;

        // Save the lot; the manufacturer is the first custodian
        Batch storage batch = _batches[batchId];
        batch.id = batchId;
        batch.productHash = productHash;
        batch.manufacturer = msg.sender;
        batch.custodian = msg.sender;
        batch.manufactureDate = manufactureDate;
        batch.registeredAt = uint64(block.timestamp);
        batch.status = Status.Created;
        batch.minTempTenthsC = minTempTenthsC;
        batch.maxTempTenthsC = maxTempTenthsC;
        batch.metadata.cid = metadata.cid;
        batch.metadata.contentHash = metadata.contentHash;

        emit BatchRegistered(batchId, msg.sender, productHash, metadata.cid);
    }

    // =====================================================================
    //          CUSTODY HAND-OFF (journey stages: Shipment, Storage)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    function initiateTransfer(uint256 batchId, address to)
        external
        onlyEitherRole(MANUFACTURER_ROLE, DISTRIBUTOR_ROLE)
    {
        Batch storage batch = _requireBatch(batchId);
        if (batch.custodian != msg.sender) revert NotCustodian(batchId, msg.sender);

        // Only one open hand-off per lot
        if (batch.pendingCustodian != address(0)) {
            revert TransferAlreadyPending(batchId, batch.pendingCustodian);
        }
        if (batch.status != Status.Created && batch.status != Status.Stored) {
            revert InvalidStatus(batchId, batch.status);
        }

        // Allowed routes: anyone -> distributor, distributor -> pharmacy
        if (to == address(0) || to == msg.sender) revert InvalidRecipient(to);
        bool toDistributor = hasRole(DISTRIBUTOR_ROLE, to);
        bool toPharmacy = hasRole(RETAILER_ROLE, to) && hasRole(DISTRIBUTOR_ROLE, msg.sender);
        if (!toDistributor && !toPharmacy) revert InvalidRecipient(to);

        // Open the hand-off
        _statusBeforeTransfer[batchId] = batch.status;
        batch.pendingCustodian = to;
        batch.status = Status.InTransit;

        emit TransferInitiated(batchId, msg.sender, to);
    }

    /// @inheritdoc IProvenanceRegistry
    function acceptTransfer(uint256 batchId)
        external
        onlyEitherRole(DISTRIBUTOR_ROLE, RETAILER_ROLE)
    {
        Batch storage batch = _requireBatch(batchId);

        // There must be a hand-off waiting, addressed to the caller
        if (batch.pendingCustodian == address(0)) revert NoPendingTransfer(batchId);
        if (batch.status != Status.InTransit) revert InvalidStatus(batchId, batch.status);
        if (batch.pendingCustodian != msg.sender) revert NotPendingCustodian(batchId, msg.sender);

        // Custody moves to the caller
        address previous = batch.custodian;
        batch.custodian = msg.sender;
        batch.pendingCustodian = address(0);
        batch.status = Status.Stored;

        emit CustodyTransferred(batchId, previous, msg.sender);
    }

    /// @inheritdoc IProvenanceRegistry
    function cancelTransfer(uint256 batchId)
        external
        onlyEitherRole(MANUFACTURER_ROLE, DISTRIBUTOR_ROLE)
    {
        // TODO(contract): implement
        // 1. Load the lot; msg.sender must be the custodian (NotCustodian); there
        //    must be an open hand-off (NoPendingTransfer).
        // 2. to = pendingCustodian; pendingCustodian = address(0);
        //    status = _statusBeforeTransfer[batchId].
        // 3. emit TransferCancelled(batchId, msg.sender, to).
        (batchId);
        _notImplemented();
    }

    /// @inheritdoc IProvenanceRegistry
    function updateStatus(uint256 batchId, Status newStatus)
        external
        onlyRole(DISTRIBUTOR_ROLE)
    {
        // TODO(contract): implement
        // 1. Load the lot; msg.sender must be the custodian (NotCustodian); no open
        //    hand-off (TransferAlreadyPending).
        // 2. previous = status. Allow only InTransit -> Stored or
        //    Stored -> InTransit (InvalidStatus).
        // 3. status = newStatus.
        // 4. emit StatusUpdated(batchId, previous, newStatus, msg.sender).
        (batchId, newStatus);
        _notImplemented();
    }

    /// @inheritdoc IProvenanceRegistry
    function markDelivered(uint256 batchId) external onlyRole(RETAILER_ROLE) {
        Batch storage batch = _requireBatch(batchId);
        if (batch.custodian != msg.sender) revert NotCustodian(batchId, msg.sender);
        if (batch.status != Status.Stored) revert InvalidStatus(batchId, batch.status);

        // End of the happy path
        batch.status = Status.Delivered;

        emit StatusUpdated(batchId, Status.Stored, Status.Delivered, msg.sender);
    }

    // =====================================================================
    //                      REGULATOR (journey stage: all)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    function issueCertificate(uint256 batchId, DocumentRef calldata certificate)
        external
        onlyRole(REGULATOR_ROLE)
    {
        // TODO(contract): implement
        // 1. Load the lot (BatchNotFound); status must not be Recalled (InvalidStatus).
        // 2. certificate.cid not empty and contentHash != 0 (EmptyDocument).
        // 3. Overwrite the lot's certificate (history lives in events).
        // 4. emit CertificateIssued(batchId, msg.sender, certificate.cid, certificate.contentHash).
        (batchId, certificate);
        _notImplemented();
    }

    /// @inheritdoc IProvenanceRegistry
    function recallBatch(uint256 batchId, string calldata reason)
        external
        onlyRole(REGULATOR_ROLE)
    {
        // TODO(contract): implement
        // 1. Load the lot (BatchNotFound); status must not already be Recalled (InvalidStatus).
        // 2. Clear any open hand-off: pendingCustodian = address(0).
        // 3. status = Recalled.
        // 4. emit BatchRecalled(batchId, msg.sender, reason).
        (batchId, reason);
        _notImplemented();
    }

    // =====================================================================
    //           IoT ORACLE (journey stages: Shipment, Storage)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    function anchorSensorLog(uint256 batchId, DocumentRef calldata sensorLog)
        external
        onlyRole(ORACLE_ROLE)
    {
        // TODO(contract): implement
        // 1. Load the lot (BatchNotFound); status must be active, i.e. Created,
        //    InTransit or Stored (InvalidStatus).
        // 2. sensorLog.cid not empty and contentHash != 0 (EmptyDocument).
        // 3. latestSensorLog = sensorLog; sensorLogCount += 1.
        // 4. emit SensorLogAnchored(batchId, sensorLogCount, sensorLog.cid, sensorLog.contentHash).
        (batchId, sensorLog);
        _notImplemented();
    }

    /// @inheritdoc IProvenanceRegistry
    function reportExcursion(
        uint256 batchId,
        int16 readingTenthsC,
        uint64 observedAt,
        DocumentRef calldata sensorLog
    ) external onlyRole(ORACLE_ROLE) {
        // TODO(contract): implement
        // 1. Load the lot (BatchNotFound); status must be active (InvalidStatus).
        // 2. readingTenthsC must be < minTempTenthsC or > maxTempTenthsC
        //    (else ReadingWithinRange).
        // 3. sensorLog.cid not empty and contentHash != 0 (EmptyDocument).
        //    latestSensorLog = sensorLog; sensorLogCount += 1.
        // 4. Clear any open hand-off; status = Compromised.
        // 5. emit ExcursionReported(batchId, sensorLogCount, readingTenthsC, observedAt,
        //    sensorLog.cid, sensorLog.contentHash).
        (batchId, readingTenthsC, observedAt, sensorLog);
        _notImplemented();
    }

    // =====================================================================
    //                    READ-ONLY (anyone; no wallet needed)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    function verifyBatch(uint256 batchId) external view returns (Batch memory) {
        return _requireBatch(batchId);
    }

    /// @inheritdoc IProvenanceRegistry
    function totalBatches() external view returns (uint256) {
        return _batchCount;
    }

    /// @inheritdoc IProvenanceRegistry
    function batchIdOf(bytes32 productHash) external view returns (uint256) {
        return _batchIdByProductHash[productHash];
    }

    // =====================================================================
    //                                INTERNAL
    // =====================================================================

    /// @dev Return a storage pointer to a lot, reverting with BatchNotFound if
    ///      it does not exist. The write functions will use this too once implemented.
    function _requireBatch(uint256 batchId) internal view returns (Batch storage batch) {
        if (batchId == 0 || batchId > _batchCount) revert BatchNotFound(batchId);
        return _batches[batchId];
    }

    /// @dev Reverts with EmptyDocument if the CID or the content hash is missing.
    function _requireDocument(DocumentRef calldata doc) private pure {
        if (bytes(doc.cid).length == 0 || doc.contentHash == bytes32(0)) {
            revert EmptyDocument();
        }
    }

    /// @dev DRAFT ONLY. Every TODO write function ends here. It reverts with
    ///      NotImplemented(). The dummy write keeps the stubs non-view, so the
    ///      compile stays warning-free until the real logic is in. The
    ///      `(param, ...);` lines in the stubs do the same for unused-parameter
    ///      warnings. Delete this function and `_draftOnly` once every function
    ///      is implemented.
    function _notImplemented() private {
        _draftOnly = _draftOnly;
        revert NotImplemented();
    }
}
