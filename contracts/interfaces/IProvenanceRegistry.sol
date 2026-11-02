// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title IProvenanceRegistry
 * @notice Public interface of the tamper-evident pharmaceutical cold-chain
 *         provenance registry (CSE 540, Project Group 2).
 *
 *         The registry keeps ONE on-chain record per drug lot ("batch") and
 *         combines three things that are usually kept in separate company
 *         databases:
 *           - custody:       who holds the lot, changed only by a signed
 *                            initiate/accept hand-off between organizations;
 *           - condition:     temperature range, sensor-log anchors from the IoT
 *                            oracle, and excursions that flag the lot Compromised;
 *           - certification: regulator certificates and recalls.
 *         Large files (lot metadata, certificates, sensor logs) live on IPFS.
 *         Only their CID and a hash of their bytes are stored on-chain.
 *
 *         All on-chain data is publicly readable, so the patient verify page
 *         reads it with no wallet. Writes are limited by role (see the
 *         ProvenanceRegistry role constants) and, for custody actions, by
 *         being the lot's current custodian.
 *
 * @dev    This file is the cross-team API. The dApp (frontend/), the oracle
 *         (oracle/) and the tests (test/) all code against these names. If you
 *         change a signature, redeploy, which rewrites deployments/<network>.json
 *         and its ABI, and tell the team.
 *
 *         Items tagged "PROPOSED (Cn/On)" are draft design decisions recorded in
 *         docs/design-decisions.md. They fill gaps in the proposal and still need
 *         team confirmation.
 *
 *         Granting and revoking roles ("grant roles" in proposal Table I) uses
 *         the functions inherited from OpenZeppelin AccessControl: grantRole and
 *         revokeRole. They emit RoleGranted and RoleRevoked, so they are not
 *         redeclared here.
 */
interface IProvenanceRegistry {
    // =====================================================================
    //                                TYPES
    // =====================================================================

    /**
     * @notice Lifecycle of a lot (proposal Fig. 1 state machine).
     *
     *   Created --initiateTransfer--> InTransit --acceptTransfer--> Stored
     *   Stored  --initiateTransfer--> InTransit   (next hand-off)
     *   InTransit --cancelTransfer--> Created | Stored   (custodian; back to the status before initiateTransfer)
     *   InTransit <--updateStatus--> Stored       (distributor, no open transfer)
     *   Stored  --markDelivered-->   Delivered    (pharmacy)
     *   Created | InTransit | Stored --reportExcursion--> Compromised   (oracle)
     *   any status except Recalled   --recallBatch-->     Recalled      (regulator)
     *
     * "Active" means Created, InTransit or Stored. Delivered, Compromised and
     * Recalled are terminal for custody: initiate/accept/cancelTransfer,
     * updateStatus and markDelivered revert. recallBatch still applies to
     * Delivered and Compromised lots, and issueCertificate to every status
     * except Recalled.
     *
     * PROPOSED (C1, C2): the proposal does not say which function causes each
     * transition, and it is ambiguous about recalls. Fig. 1 says
     * "active -> Compromised | Recalled", but data flow 4 says the regulator can
     * "recall a lot at any stage". This draft follows data flow 4 (needs a team vote).
     */
    enum Status {
        Created,     // 0: registered by the manufacturer, still at the factory
        InTransit,   // 1: shipped; a hand-off is open or the distributor moved it
        Stored,      // 2: received and stored by the current custodian
        Delivered,   // 3: the pharmacy has dispensed or delivered it (end of the happy path)
        Compromised, // 4: the oracle reported a temperature excursion
        Recalled     // 5: the regulator recalled the lot
    }

    /**
     * @notice Pointer to an off-chain document on IPFS.
     * @dev PROPOSED (O1): a CID alone is not a plain hash of the file's bytes,
     *      because it depends on chunking and DAG settings. So we also store
     *      keccak256 of the exact uploaded bytes. The verify page downloads
     *      `cid` from a gateway, hashes the bytes with ethers.keccak256 and
     *      compares the result with `contentHash`.
     */
    struct DocumentRef {
        string cid;          // IPFS CID (CIDv1 string), used to locate the file
        bytes32 contentHash; // keccak256 of the exact uploaded bytes, used to detect edits
    }

    /**
     * @notice The on-chain record for one lot. Returned by verifyBatch().
     * @dev PROPOSED (C5, C7) field types and encodings.
     */
    struct Batch {
        uint256 id;                  // unique, assigned by the contract, starts at 1 (0 = "no such lot")
        bytes32 productHash;         // keccak256(abi.encode(productCode, lotNumber)), computed off-chain; one lot per hash
        address manufacturer;        // origin: the MANUFACTURER account that registered the lot
        uint64 manufactureDate;      // Unix seconds, supplied by the manufacturer
        uint64 registeredAt;         // block timestamp of registerBatch
        address custodian;           // current holder of the lot
        address pendingCustodian;    // recipient of an open hand-off, or address(0) if none
        Status status;               // see the Status enum
        int16 minTempTenthsC;        // allowed range in tenths of a degree C (2.0 C to 8.0 C = 20 to 80); fixed at registration
        int16 maxTempTenthsC;
        uint32 sensorLogCount;       // number of sensor logs anchored so far (packed into the same slot as the fields above)
        DocumentRef metadata;        // lot metadata JSON (product, site, expiry, manufacturer's certificate of analysis)
        DocumentRef certificate;     // latest regulator certificate; empty cid = not certified yet (C6)
        DocumentRef latestSensorLog; // most recent sensor log anchored by the oracle
    }

    // =====================================================================
    //                    EVENTS (one per write, Fig. 1)
    // =====================================================================
    // Every event has batchId as its first indexed topic, so the verify page
    // can rebuild a lot's history with one batchId topic filter. Query it in
    // block-range pages starting at the deploy block, because public RPCs cap
    // the range of a single query (see O6).

    /// @notice A manufacturer registered a new lot. New status: Created.
    event BatchRegistered(
        uint256 indexed batchId,
        address indexed manufacturer,
        bytes32 indexed productHash,
        string metadataCid
    );

    /// @notice The custodian opened a hand-off to `to`. New status: InTransit.
    event TransferInitiated(uint256 indexed batchId, address indexed from, address indexed to);

    /// @notice `to` accepted the hand-off and is now the custodian. New status: Stored.
    event CustodyTransferred(uint256 indexed batchId, address indexed from, address indexed to);

    /// @notice The custodian cancelled an open hand-off. The status goes back
    ///         to what it was before initiateTransfer.
    /// @dev PROPOSED (C3): not in the proposal's event list. Without a cancel
    ///      path, a typo in the recipient address strands the lot.
    event TransferCancelled(uint256 indexed batchId, address indexed from, address indexed to);

    /// @notice The status changed through updateStatus (distributor) or markDelivered (pharmacy).
    event StatusUpdated(
        uint256 indexed batchId,
        Status previousStatus,
        Status newStatus,
        address indexed by
    );

    /// @notice The regulator attached a certificate, or replaced the previous one.
    event CertificateIssued(
        uint256 indexed batchId,
        address indexed regulator,
        string cid,
        bytes32 contentHash
    );

    /// @notice The oracle anchored a sensor-log file. `logIndex` counts from 1.
    event SensorLogAnchored(
        uint256 indexed batchId,
        uint32 indexed logIndex,
        string cid,
        bytes32 contentHash
    );

    /// @notice The oracle reported an out-of-range reading. New status: Compromised.
    ///         The log that contains the reading becomes log number `logIndex`.
    ///         It is NOT also emitted as SensorLogAnchored, so this event carries
    ///         its hash for the verify page.
    event ExcursionReported(
        uint256 indexed batchId,
        uint32 logIndex,
        int16 readingTenthsC,
        uint64 observedAt,
        string logCid,
        bytes32 logContentHash
    );

    /// @notice The regulator recalled the lot. New status: Recalled.
    event BatchRecalled(uint256 indexed batchId, address indexed regulator, string reason);

    // =====================================================================
    //                                ERRORS
    // =====================================================================
    // Role failures use OpenZeppelin's AccessControlUnauthorizedAccount(account, role),
    // or MissingEitherRole for functions that accept two roles.

    error ZeroAddress();
    error MissingEitherRole(address account, bytes32 roleA, bytes32 roleB);
    error BatchNotFound(uint256 batchId);
    error DuplicateProduct(bytes32 productHash, uint256 existingBatchId);
    error InvalidTemperatureRange(int16 minTempTenthsC, int16 maxTempTenthsC);
    error EmptyDocument();                              // cid is empty or contentHash is zero
    error NotCustodian(uint256 batchId, address caller);
    error NotPendingCustodian(uint256 batchId, address caller);
    error TransferAlreadyPending(uint256 batchId, address pendingCustodian);
    error NoPendingTransfer(uint256 batchId);
    error InvalidRecipient(address to);                 // zero address, the caller itself, or no allowed role
    error InvalidStatus(uint256 batchId, Status current); // action not allowed in the lot's current status
    error ReadingWithinRange(int16 readingTenthsC, int16 minTempTenthsC, int16 maxTempTenthsC);

    // =====================================================================
    //                   MANUFACTURER (journey stage: Creation)
    // =====================================================================

    /**
     * @notice Register a new lot. The caller becomes its manufacturer and first custodian.
     * @dev Role: MANUFACTURER. Emits BatchRegistered. Status: none -> Created.
     *      Before calling, the dApp uploads the metadata JSON to IPFS (O2/O3).
     *      PROPOSED (C5): productHash is unique across ALL manufacturers. Open
     *      risk: any manufacturer could register another firm's product+lot first
     *      (see docs/design-decisions.md).
     *      Reverts: DuplicateProduct, InvalidTemperatureRange (min >= max), EmptyDocument.
     * @param productHash      keccak256(abi.encode(productCode, lotNumber)); stops the same lot being registered twice
     * @param manufactureDate  Unix seconds
     * @param minTempTenthsC   lowest allowed temperature, in tenths of a degree C
     * @param maxTempTenthsC   highest allowed temperature, in tenths of a degree C
     * @param metadata         IPFS pointer and hash of the lot metadata JSON
     * @return batchId         the new lot's ID (1, 2, 3, ...)
     */
    function registerBatch(
        bytes32 productHash,
        uint64 manufactureDate,
        int16 minTempTenthsC,
        int16 maxTempTenthsC,
        DocumentRef calldata metadata
    ) external returns (uint256 batchId);

    // =====================================================================
    //          CUSTODY HAND-OFF (journey stages: Shipment, Storage)
    // =====================================================================

    /**
     * @notice Step 1 of a hand-off: the current custodian names the next custodian.
     * @dev Role: MANUFACTURER or DISTRIBUTOR, and the caller must be the custodian.
     *      PROPOSED (C4): roles gate functions, custody gates lots.
     *      Status: Created | Stored -> InTransit. Emits TransferInitiated.
     *      PROPOSED (C3): one open hand-off per lot. Allowed routes:
     *      MANUFACTURER -> DISTRIBUTOR, and DISTRIBUTOR -> DISTRIBUTOR | RETAILER.
     *      Reverts: BatchNotFound, NotCustodian, TransferAlreadyPending, InvalidRecipient, InvalidStatus.
     */
    function initiateTransfer(uint256 batchId, address to) external;

    /**
     * @notice Step 2 of a hand-off: the named recipient accepts and becomes the custodian.
     * @dev Role: DISTRIBUTOR or RETAILER, and the caller must be pendingCustodian (C4).
     *      Status: InTransit -> Stored. Emits CustodyTransferred.
     *      Reverts: BatchNotFound, NotPendingCustodian, NoPendingTransfer, InvalidStatus.
     */
    function acceptTransfer(uint256 batchId) external;

    /**
     * @notice Cancel an open hand-off, e.g. one sent to the wrong address.
     * @dev Role: MANUFACTURER or DISTRIBUTOR, and the caller must be the custodian (C4).
     *      The status goes back to what it was before initiateTransfer. Emits TransferCancelled.
     *      PROPOSED (C3): not in proposal Table I.
     *      Reverts: BatchNotFound, NotCustodian, NoPendingTransfer.
     */
    function cancelTransfer(uint256 batchId) external;

    /**
     * @notice A distributor moves a lot it holds between InTransit and Stored,
     *         e.g. warehouse to truck.
     * @dev Role: DISTRIBUTOR, and the caller must be the custodian (C4). No hand-off may be open.
     *      Only InTransit <-> Stored. Emits StatusUpdated.
     *      Reverts: BatchNotFound, NotCustodian, TransferAlreadyPending, InvalidStatus.
     */
    function updateStatus(uint256 batchId, Status newStatus) external;

    /**
     * @notice The pharmacy marks a lot it holds as delivered (end of the happy path).
     * @dev Role: RETAILER, and the caller must be the custodian (C4). Status: Stored -> Delivered.
     *      Emits StatusUpdated, so Fig. 1's event list needs no BatchDelivered event.
     *      Reverts: BatchNotFound, NotCustodian, InvalidStatus.
     */
    function markDelivered(uint256 batchId) external;

    // =====================================================================
    //                      REGULATOR (journey stage: all)
    // =====================================================================

    /**
     * @notice Attach a regulator certificate to a lot, or replace the previous one.
     * @dev Role: REGULATOR. Allowed in every status except Recalled ("certify ...
     *      at any stage"). Overwrites `certificate`. The full history stays in
     *      CertificateIssued events, so no array grows in storage. PROPOSED (C6).
     *      Reverts: BatchNotFound, InvalidStatus, EmptyDocument.
     */
    function issueCertificate(uint256 batchId, DocumentRef calldata certificate) external;

    /**
     * @notice Recall a lot at any stage. Clears any open hand-off.
     * @dev Role: REGULATOR. Allowed in every status except Recalled, including
     *      Delivered and Compromised. PROPOSED (C2). Emits BatchRecalled.
     *      Status: any -> Recalled.
     *      Reverts: BatchNotFound, InvalidStatus.
     */
    function recallBatch(uint256 batchId, string calldata reason) external;

    // =====================================================================
    //           IoT ORACLE (journey stages: Shipment, Storage)
    // =====================================================================

    /**
     * @notice Anchor a sensor-log file (uploaded to IPFS by the oracle) to a lot.
     * @dev Role: ORACLE. The lot must be active (Created, InTransit or Stored).
     *      Stores only the latest log and a counter; earlier logs stay in
     *      SensorLogAnchored events (plus the ExcursionReported event, if any),
     *      which keeps gas flat. Emits SensorLogAnchored.
     *      Reverts: BatchNotFound, InvalidStatus, EmptyDocument.
     */
    function anchorSensorLog(uint256 batchId, DocumentRef calldata sensorLog) external;

    /**
     * @notice Report a temperature excursion. The lot becomes Compromised.
     * @dev Role: ORACLE. The lot must be active. The contract only checks that
     *      the REPORTED reading is outside the lot's registered range. It cannot
     *      check that the reading is genuine, so the ORACLE key is trusted: a
     *      faulty or stolen key can mark any active lot Compromised, and in the
     *      MVP that cannot be undone. It records `sensorLog` as the latest log
     *      (incrementing sensorLogCount) and clears any open hand-off.
     *      PROPOSED (C7). Emits ExcursionReported.
     *      Status: active -> Compromised.
     *      Reverts: BatchNotFound, InvalidStatus, ReadingWithinRange, EmptyDocument.
     * @param readingTenthsC  the offending reading, in tenths of a degree C
     * @param observedAt      Unix seconds when the sensor took the reading
     * @param sensorLog       the log file that contains the reading
     */
    function reportExcursion(
        uint256 batchId,
        int16 readingTenthsC,
        uint64 observedAt,
        DocumentRef calldata sensorLog
    ) external;

    // =====================================================================
    //        READ-ONLY (anyone, incl. pharmacy and patient verify page)
    // =====================================================================

    /**
     * @notice Return the full on-chain record of a lot. No wallet or role needed.
     * @dev Patients reach this through the QR code's verify page. The pharmacy
     *      calls the same view from its dashboard. Custody and temperature
     *      history come from this lot's events, not from storage. PROPOSED (O6).
     *      Reverts: BatchNotFound.
     */
    function verifyBatch(uint256 batchId) external view returns (Batch memory);

    /// @notice Number of lots registered so far. IDs run from 1 to totalBatches().
    function totalBatches() external view returns (uint256);

    /// @notice Look up a lot ID by product hash. Returns 0 if not registered.
    function batchIdOf(bytes32 productHash) external view returns (uint256);
}
