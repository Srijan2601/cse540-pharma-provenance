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
        // TODO(contract): implement
        // 1. Validate: minTempTenthsC < maxTempTenthsC (else InvalidTemperatureRange);
        //    metadata.cid not empty and metadata.contentHash != 0 (else EmptyDocument).
        // 2. Reject duplicates: _batchIdByProductHash[productHash] must be 0
        //    (else DuplicateProduct).
        // 3. batchId = ++_batchCount; _batchIdByProductHash[productHash] = batchId.
        // 4. Fill _batches[batchId]: id, productHash, manufacturer = custodian = msg.sender,
        //    manufactureDate, registeredAt = uint64(block.timestamp), status = Created,
        //    temperature range, metadata.
        // 5. emit BatchRegistered(batchId, msg.sender, productHash, metadata.cid).
        (productHash, manufactureDate, minTempTenthsC, maxTempTenthsC, metadata, batchId);
        _notImplemented();
    }

    // =====================================================================
    //          CUSTODY HAND-OFF (journey stages: Shipment, Storage)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    function initiateTransfer(uint256 batchId, address to)
        external
        onlyEitherRole(MANUFACTURER_ROLE, DISTRIBUTOR_ROLE)
    {
        // TODO(contract): implement
        // 1. Load the lot (BatchNotFound if missing); msg.sender must be the
        //    custodian (NotCustodian).
        // 2. No open hand-off: pendingCustodian must be address(0)
        //    (TransferAlreadyPending). Check this first, because an open
        //    hand-off always means InTransit and the status check below would
        //    otherwise hide it. Then the status must be Created or Stored (InvalidStatus).
        // 3. Check the recipient: not address(0) and not msg.sender, and holds an
        //    allowed role. MANUFACTURER -> DISTRIBUTOR; DISTRIBUTOR -> DISTRIBUTOR
        //    or RETAILER (InvalidRecipient). C3: team to confirm whether
        //    MANUFACTURER -> RETAILER is allowed.
        // 4. Save the current status in _statusBeforeTransfer, set pendingCustodian = to
        //    and status = InTransit.
        // 5. emit TransferInitiated(batchId, msg.sender, to).
        (batchId, to);
        _notImplemented();
    }

    /// @inheritdoc IProvenanceRegistry
    function acceptTransfer(uint256 batchId)
        external
        onlyEitherRole(DISTRIBUTOR_ROLE, RETAILER_ROLE)
    {
        // TODO(contract): implement
        // 1. Load the lot; there must be an open hand-off (NoPendingTransfer) and the
        //    status must be InTransit (InvalidStatus).
        // 2. msg.sender must be pendingCustodian (NotPendingCustodian).
        // 3. previous = custodian; custodian = msg.sender; pendingCustodian = address(0);
        //    status = Stored.
        // 4. emit CustodyTransferred(batchId, previous, msg.sender).
        (batchId);
        _notImplemented();
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
        // TODO(contract): implement
        // 1. Load the lot; msg.sender must be the custodian (NotCustodian).
        // 2. Status must be Stored (InvalidStatus). Stored -> Delivered.
        // 3. emit StatusUpdated(batchId, Status.Stored, Status.Delivered, msg.sender).
        (batchId);
        _notImplemented();
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
