// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IProvenanceRegistry} from "../interfaces/IProvenanceRegistry.sol";

/**
 * @title RegistryBase
 * @notice Shared foundation of the provenance registry: the five roles and
 *         who administers them, the storage that holds every lot, the guards
 *         that the write functions have in common, and the read-only views.
 *
 * @dev Where this contract sits:
 *
 *                      IProvenanceRegistry      types, events, errors, external API
 *                              |
 *                         RegistryBase          roles, storage, guards, views (this file)
 *                       /      |       \
 *          CustodyModule  ConditionModule  CertificationModule    the write functions
 *                       \      |       /
 *                      ProvenanceRegistry       the one deployed contract
 *
 *      The three modules follow the proposal's split of a lot's record into
 *      custody, condition and certification. Each one inherits this contract
 *      and implements only its own part of the interface. Because they share
 *      this single base, they all work on the same lot records. That is what
 *      lets an excursion report (ConditionModule) or a recall
 *      (CertificationModule) close a hand-off opened in CustodyModule.
 *
 *      Access control is OpenZeppelin AccessControl. Single-role functions use
 *      its `onlyRole` modifier; functions open to two roles use
 *      `onlyEitherRole` below. On every write function the role modifier is
 *      the first check: an account without the role gets the role error
 *      whatever lot or argument values it names. Only calldata that Solidity's
 *      ABI decoder rejects fails earlier, before any modifier runs and with
 *      empty revert data: a `newStatus` outside the Status enum, or a word
 *      that is not a valid encoding of its parameter type (an out-of-range
 *      int16, an address with non-zero upper bits).
 *
 *      The registry has no meta-transaction support, so `msg.sender` is
 *      always the organization that signed the transaction.
 *
 *      Invariants. The write functions keep the following properties: each
 *      one holds before and after every transaction. Where a check could only
 *      fail if an invariant were broken, the code relies on the invariant and
 *      says so, instead of repeating the check.
 *
 *        I1  pendingCustodian != address(0) implies status == InTransit.
 *            Only initiateTransfer opens a hand-off, and it sets InTransit in
 *            the same step. Every function that moves a lot out of InTransit
 *            either clears the hand-off (acceptTransfer, cancelTransfer,
 *            reportExcursion, recallBatch) or refuses to run while one is
 *            open (updateStatus).
 *
 *        I2  status in {Delivered, Compromised, Recalled} implies
 *            pendingCustodian == address(0).
 *            A lot that has left the custody flow has no open hand-off. This
 *            follows from I1; it is listed separately because it is the
 *            property the terminal statuses rely on.
 *
 *        I3  Lot IDs are exactly 1.._batchCount, and
 *            _batchIdByProductHash[h] is the ID of the lot registered with
 *            product hash h, or 0 if there is none.
 *            registerBatch is the only writer of both. It rejects a hash that
 *            is already mapped, and no function deletes a lot.
 *
 *        I4  Every existing lot has a non-zero custodian and manufacturer.
 *            Both start as the registering account. Afterwards custodian
 *            only ever becomes the account that accepted a hand-off. In both
 *            cases the value is the sender of a transaction, which is never
 *            the zero address.
 *
 *        I5  Recalled is absorbing, and from Delivered or Compromised the
 *            only possible change of status is to Recalled.
 *            Every custody and oracle function rejects those three statuses,
 *            issueCertificate never changes the status, and recallBatch
 *            rejects a lot that is already Recalled.
 */
abstract contract RegistryBase is AccessControl, IProvenanceRegistry {
    // =====================================================================
    //                                 ROLES
    // =====================================================================
    // Proposal Table I maps each actor to one role. The proposal assumes one
    // wallet per organization (Fig. 1), but nothing here depends on that: a
    // wallet that holds two roles can call the functions of both.
    //
    // The patient has no role and no wallet. Reading is open to everyone.

    /// @notice Regulator: onboards organizations, issues certificates, recalls lots.
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");

    /// @notice Drug manufacturer: registers lots and hands them to a distributor.
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");

    /// @notice Distributor / 3PL: receives lots, stores and ships them, hands them on.
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    /// @notice Pharmacy: receives lots from a distributor and marks them delivered.
    bytes32 public constant RETAILER_ROLE = keccak256("RETAILER_ROLE");

    /// @notice IoT oracle: anchors sensor logs and reports temperature excursions.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // =====================================================================
    //                                STORAGE
    // =====================================================================
    // The invariants I1-I5 that tie this storage together are stated, with
    // the reason each one holds, in the contract NatSpec (@dev) above.

    /// @dev Number of lots registered so far. The next lot gets ID
    ///      `_batchCount + 1`, so IDs start at 1 and ID 0 means "no such lot".
    uint256 internal _batchCount;

    /// @dev Lot ID => record. Modules read existing lots through `_loadBatch`,
    ///      which rejects IDs outside 1.._batchCount (I3).
    mapping(uint256 batchId => Batch) internal _batches;

    /// @dev Product hash => lot ID, 0 if the hash is not registered. Rejects a
    ///      second registration of the same product code and lot number
    ///      (design decision C5).
    mapping(bytes32 productHash => uint256 batchId) internal _batchIdByProductHash;

    /// @dev Lot ID => the status the lot had when its current hand-off was
    ///      opened (Created or Stored), so that cancelTransfer can restore it
    ///      (design decision C3). The entry is only meaningful while a hand-off
    ///      is open. It is not reset when the hand-off closes, because every
    ///      initiateTransfer overwrites it before cancelTransfer can read it.
    mapping(uint256 batchId => Status) internal _statusBeforeTransfer;

    // =====================================================================
    //                              CONSTRUCTOR
    // =====================================================================

    /**
     * @notice Set up the role hierarchy with `regulator` at its root.
     * @dev Design decision C4, the mapping of the proposal's "REGULATOR (admin)"
     *      onto OpenZeppelin AccessControl:
     *        - the regulator holds REGULATOR_ROLE, which lets it call
     *          issueCertificate and recallBatch;
     *        - REGULATOR_ROLE is the admin of the four organization roles, so
     *          the regulator onboards an organization with grantRole and
     *          offboards it with revokeRole (data flow 4, "Oversee");
     *        - the regulator also holds DEFAULT_ADMIN_ROLE, the admin of
     *          REGULATOR_ROLE itself. Without it nobody could add a second
     *          regulator or move the regulator to a new key.
     *      The deployer gets no role unless it is also the regulator, so the
     *      key that pays for deployment has no power over the registry.
     *
     *      Trust assumption: the regulator key is the root of trust (proposal
     *      section 2). It decides who may write, and it can grant any role to
     *      any account, including itself. The contract does not guard against
     *      a malicious or lost regulator key.
     * @param regulator The regulator's wallet. Reverts ZeroAddress if it is
     *        the zero address, which would leave the registry with no admin.
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

    /// @dev Access check for functions that two roles may call, e.g.
    ///      initiateTransfer (MANUFACTURER or DISTRIBUTOR). OpenZeppelin's
    ///      `onlyRole` takes a single role and its error names a single role,
    ///      so the two-role case has its own error naming both.
    modifier onlyEitherRole(bytes32 roleA, bytes32 roleB) {
        if (!hasRole(roleA, msg.sender) && !hasRole(roleB, msg.sender)) {
            revert MissingEitherRole(msg.sender, roleA, roleB);
        }
        _;
    }

    // =====================================================================
    //                    READ-ONLY (anyone; no wallet needed)
    // =====================================================================

    /// @inheritdoc IProvenanceRegistry
    function verifyBatch(uint256 batchId) external view returns (Batch memory) {
        return _loadBatch(batchId);
    }

    /// @inheritdoc IProvenanceRegistry
    function totalBatches() external view returns (uint256) {
        return _batchCount;
    }

    /// @inheritdoc IProvenanceRegistry
    function batchIdOf(bytes32 productHash) external view returns (uint256) {
        return _batchIdByProductHash[productHash];
    }

    /// @notice ERC-165 interface detection.
    /// @dev Returns true for IProvenanceRegistry in addition to what
    ///      AccessControl reports (IAccessControl and IERC165). The dApp and
    ///      the oracle can use it to confirm that an address is a registry
    ///      before they send it transactions.
    /// @param interfaceId The ERC-165 interface identifier to test.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IProvenanceRegistry).interfaceId || super.supportsInterface(interfaceId);
    }

    // =====================================================================
    //                     SHARED GUARDS AND HELPERS
    // =====================================================================
    // Each guard reverts with one specific custom error, or returns. The
    // modules call them in the order in which the interface lists a function's
    // reverts.

    /// @dev Return a storage pointer to an existing lot. Reverts BatchNotFound
    ///      for any ID outside 1.._batchCount, which includes 0.
    function _loadBatch(uint256 batchId) internal view returns (Batch storage batch) {
        if (batchId == 0 || batchId > _batchCount) revert BatchNotFound(batchId);
        return _batches[batchId];
    }

    /// @dev Reverts NotCustodian unless the caller currently holds the lot.
    ///      Design decision C4: a role only says what kind of organization the
    ///      caller is. Without this second check, any distributor could ship or
    ///      re-status the lots held by every other distributor.
    function _requireCustodian(uint256 batchId, Batch storage batch) internal view {
        if (batch.custodian != msg.sender) revert NotCustodian(batchId, msg.sender);
    }

    /// @dev Reverts TransferAlreadyPending if the lot has an open hand-off.
    ///      A lot has one custodian and at most one named successor at a time.
    function _requireNoPendingTransfer(uint256 batchId, Batch storage batch) internal view {
        address pendingCustodian = batch.pendingCustodian;
        if (pendingCustodian != address(0)) revert TransferAlreadyPending(batchId, pendingCustodian);
    }

    /// @dev Reverts NoPendingTransfer if the lot has no open hand-off.
    /// @return pendingCustodian The recipient named by the open hand-off (never zero).
    function _requirePendingTransfer(uint256 batchId, Batch storage batch)
        internal
        view
        returns (address pendingCustodian)
    {
        pendingCustodian = batch.pendingCustodian;
        if (pendingCustodian == address(0)) revert NoPendingTransfer(batchId);
    }

    /// @dev Close the lot's hand-off, if one is open. Callers set the status
    ///      that goes with it; pendingCustodian and status share a storage
    ///      slot, so changing both touches only one slot.
    ///
    ///      reportExcursion and recallBatch call this even though they do not
    ///      know whether a hand-off is open. If they left one open, the named
    ///      recipient could still call acceptTransfer, which would overwrite
    ///      Compromised or Recalled with Stored and move a flagged lot to a new
    ///      custodian. Clearing it keeps I1 and I2 true, and leaves the lot
    ///      with the organization that held it when it was flagged.
    function _clearPendingTransfer(Batch storage batch) internal {
        batch.pendingCustodian = address(0);
    }

    /// @dev True for the statuses in which a lot is still moving through the
    ///      supply chain: Created, InTransit and Stored (design decision C2).
    function _isActive(Status status) internal pure returns (bool) {
        return status == Status.Created || status == Status.InTransit || status == Status.Stored;
    }

    /// @dev Reverts InvalidStatus unless the lot is active. Guards the oracle
    ///      functions: sensor data is only recorded while a lot is on its way.
    function _requireActive(uint256 batchId, Batch storage batch) internal view {
        Status status = batch.status;
        if (!_isActive(status)) revert InvalidStatus(batchId, status);
    }

    /// @dev Reverts InvalidStatus if the lot is Recalled. Guards the regulator
    ///      functions: Recalled is the one status the regulator cannot act on.
    ///      The lot's record is closed, so it can be neither certified nor
    ///      recalled a second time. The custody and oracle functions reject
    ///      Recalled lots as well, which together makes Recalled absorbing
    ///      (invariant I5).
    function _requireNotRecalled(uint256 batchId, Batch storage batch) internal view {
        if (batch.status == Status.Recalled) revert InvalidStatus(batchId, Status.Recalled);
    }

    /// @dev Reverts EmptyDocument unless both halves of the reference are set.
    ///      Design decision O1: the CID locates the file on IPFS and the
    ///      keccak256 content hash lets anyone check the downloaded bytes. A
    ///      reference with only one half could not be both found and verified,
    ///      so it is rejected. The contract cannot check that the CID is well
    ///      formed or that the file exists. That check happens off-chain, when
    ///      a reader downloads the file and compares its hash (data flow 5).
    function _requireDocument(DocumentRef calldata document) internal pure {
        if (bytes(document.cid).length == 0 || document.contentHash == bytes32(0)) {
            revert EmptyDocument();
        }
    }

    /// @dev Reverts InvalidTimestamp if a caller-supplied time is 0 (a missing
    ///      value) or lies in the future. Applies to manufactureDate and
    ///      observedAt: a lot cannot be made, or a reading taken, after the
    ///      block that records it. The contract cannot tell how far in the past
    ///      the real time was, so an older value is accepted as reported.
    function _requirePastTimestamp(uint64 timestamp) internal view {
        if (timestamp == 0 || timestamp > block.timestamp) revert InvalidTimestamp(timestamp);
    }
}
