// SPDX-License-Identifier: MIT
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
 *         reads it with no wallet. Writes are limited by role (see the role
 *         constants in base/RegistryBase.sol) and, for custody actions, by
 *         being the lot's current custodian.
 *
 * @dev    This file is the cross-team API. The dApp (frontend/), the oracle
 *         (oracle/) and the tests (test/) all code against these names. Any
 *         change to the external interface (functions, events or errors, here
 *         or in the contracts that implement it) changes the ABI that
 *         frontend/ and oracle/ load. Run `npm run compile` and commit
 *         deployments/abi/ProvenanceRegistry.json in the same PR;
 *         test/tooling/abi-sync.test.js fails otherwise. A network that
 *         already has a deployments/<network>.json keeps the old ABI until it
 *         is redeployed. Tell the team. Details: deployments/README.md.
 *
 *         The implementation is split by concern: base/RegistryBase.sol (roles,
 *         storage, shared guards, views) and one module per bullet above in
 *         modules/. ProvenanceRegistry.sol composes them into the one deployed
 *         contract.
 *
 *         Tags such as "C3" or "O1" name the design decisions recorded in
 *         docs/design-decisions.md: the points the proposal left open and the
 *         answer this contract implements.
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
     *   (no lot)  --registerBatch-->    Created            (manufacturer)
     *   Created   --initiateTransfer--> InTransit          (custodian opens a hand-off)
     *   Stored    --initiateTransfer--> InTransit          (custodian opens the next hand-off)
     *   InTransit --acceptTransfer-->   Stored             (named recipient; custody moves)
     *   InTransit --cancelTransfer-->   Created | Stored   (custodian; back to the status before initiateTransfer)
     *   InTransit <--updateStatus-->    Stored             (distributor custodian, no open hand-off)
     *   Stored    --markDelivered-->    Delivered          (pharmacy custodian)
     *   Created | InTransit | Stored --reportExcursion--> Compromised   (oracle)
     *   any status except Recalled   --recallBatch-->     Recalled      (regulator)
     *
     * "Active" means Created, InTransit or Stored. Delivered, Compromised and
     * Recalled are terminal for custody: initiateTransfer, acceptTransfer,
     * cancelTransfer, updateStatus and markDelivered revert, and so do the
     * oracle's anchorSensorLog and reportExcursion. recallBatch still applies to
     * Delivered and Compromised lots, and issueCertificate to every status
     * except Recalled. Recalled is final: no function changes a recalled lot.
     *
     * Design decision C1: the proposal names the statuses but not the function
     * behind each transition; the list above is the contract's answer.
     * Design decision C2: Fig. 1 reads "active -> Compromised | Recalled", while
     * data flow 4 lets the regulator "recall a lot at any stage". The contract
     * follows data flow 4, because the lots a recall most needs to reach are
     * the ones already at the pharmacy (Delivered) or already flagged
     * (Compromised).
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
     * @dev Design decision O1: a CID alone is not a plain hash of the file's
     *      bytes, because it depends on chunking and DAG settings. So the
     *      registry also stores keccak256 of the exact uploaded bytes. The
     *      verify page downloads `cid` from a gateway, hashes the bytes with
     *      ethers.keccak256 and compares the result with `contentHash`. The CID
     *      locates the file; the hash proves it was not edited.
     */
    struct DocumentRef {
        string cid;          // IPFS CID (CIDv1 string), used to locate the file
        bytes32 contentHash; // keccak256 of the exact uploaded bytes, used to detect edits
    }

    /**
     * @notice The on-chain record for one lot. Returned by verifyBatch().
     * @dev Design decisions C5 and C7 fix the field types and encodings. The
     *      invariants that tie these fields together (I1-I5) are stated in the
     *      contract NatSpec of base/RegistryBase.sol, which holds the records.
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
        uint32 sensorLogCount;       // number of sensor logs anchored so far (shares a storage slot with the four fields above)
        DocumentRef metadata;        // lot metadata JSON (product, site, expiry, manufacturer's certificate of analysis)
        DocumentRef certificate;     // latest regulator certificate; empty cid = not certified yet (C6)
        DocumentRef latestSensorLog; // most recent sensor log anchored by the oracle
    }

    // =====================================================================
    //                    EVENTS (one per write, Fig. 1)
    // =====================================================================
    // Every successful call to a write function declared below emits exactly
    // one of these events. Every event has batchId as its first indexed topic,
    // so the verify page can rebuild a lot's history with one batchId topic
    // filter. Query it in block-range pages starting at the deploy block,
    // because public RPCs cap the range of a single query (see O6).

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
    /// @dev Design decision C3: not in the proposal's event list. It exists
    ///      because cancelTransfer exists, and every write emits an event.
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
    // Every failure reverts with a custom error that carries the values a
    // caller needs to explain it, instead of a revert string. Role failures use
    // OpenZeppelin's AccessControlUnauthorizedAccount(account, role), or
    // MissingEitherRole for functions that accept two roles. The role check
    // always runs first: a caller without the role gets the role error
    // whatever lot or argument values it names. Only calldata that Solidity's
    // ABI decoder rejects fails earlier, with empty revert data: a `newStatus`
    // outside the Status enum, or a word that is not a valid encoding of its
    // parameter type (an out-of-range int16, an address with non-zero upper
    // bits).

    /// @notice The constructor was given the zero address as regulator.
    error ZeroAddress();

    /// @notice `account` holds neither `roleA` nor `roleB`; the function needs one of them.
    error MissingEitherRole(address account, bytes32 roleA, bytes32 roleB);

    /// @notice No lot has this ID. IDs run from 1 to totalBatches(); 0 never exists.
    error BatchNotFound(uint256 batchId);

    /// @notice registerBatch: the product hash is zero.
    error ZeroProductHash();

    /// @notice registerBatch: this product hash is already registered as lot `existingBatchId`.
    error DuplicateProduct(bytes32 productHash, uint256 existingBatchId);

    /// @notice A caller-supplied time (manufactureDate, observedAt) is 0 or later than the block timestamp.
    error InvalidTimestamp(uint64 timestamp);

    /// @notice registerBatch: the temperature range is empty or inverted (min >= max).
    error InvalidTemperatureRange(int16 minTempTenthsC, int16 maxTempTenthsC);

    /// @notice A document reference has an empty CID or a zero content hash.
    error EmptyDocument();

    /// @notice The caller holds the right role but is not the lot's current custodian.
    error NotCustodian(uint256 batchId, address caller);

    /// @notice acceptTransfer: the open hand-off names a different recipient.
    error NotPendingCustodian(uint256 batchId, address caller);

    /// @notice The action needs a lot with no open hand-off, but one to `pendingCustodian` is open.
    error TransferAlreadyPending(uint256 batchId, address pendingCustodian);

    /// @notice acceptTransfer or cancelTransfer: the lot has no open hand-off.
    error NoPendingTransfer(uint256 batchId);

    /// @notice initiateTransfer: `to` is the zero address, the caller itself, or not an allowed route.
    error InvalidRecipient(address to);

    /// @notice The action is not allowed while the lot is in status `current`.
    error InvalidStatus(uint256 batchId, Status current);

    /// @notice updateStatus: only InTransit -> Stored and Stored -> InTransit are allowed.
    error InvalidStatusTransition(uint256 batchId, Status from, Status to);

    /// @notice reportExcursion: the reading is inside the lot's range (bounds included), so it is not an excursion.
    error ReadingWithinRange(int16 readingTenthsC, int16 minTempTenthsC, int16 maxTempTenthsC);

    /// @notice recallBatch: the reason is empty.
    error EmptyReason();

    // =====================================================================
    //                   MANUFACTURER (journey stage: Creation)
    // =====================================================================

    /**
     * @notice Register a new lot. The caller becomes its manufacturer and first custodian.
     * @dev Role: MANUFACTURER. Emits BatchRegistered. Status: none -> Created.
     *      Before calling, the dApp uploads the metadata JSON to IPFS (O2/O3).
     *      Design decision C5: productHash is unique across ALL manufacturers, so
     *      one product code + lot number can never be registered twice. Known
     *      limit: any manufacturer could register another firm's product and lot
     *      first, and a recall does not free the hash (see
     *      docs/design-decisions.md).
     *      Reverts: ZeroProductHash, InvalidTimestamp (manufactureDate is 0 or in
     *      the future), InvalidTemperatureRange (min >= max), EmptyDocument,
     *      DuplicateProduct.
     * @param productHash      keccak256(abi.encode(productCode, lotNumber)); stops the same lot being registered twice
     * @param manufactureDate  Unix seconds; not 0 and not later than the block timestamp
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
     *      Design decision C4: roles gate functions, custody gates lots.
     *      Status: Created | Stored -> InTransit. Custody itself does not move
     *      until the recipient accepts. Emits TransferInitiated.
     *      Design decision C3: one open hand-off per lot. Allowed routes: to a
     *      DISTRIBUTOR (from a manufacturer or a distributor), or to a RETAILER
     *      when the caller holds DISTRIBUTOR_ROLE. A caller that holds
     *      MANUFACTURER_ROLE but not DISTRIBUTOR_ROLE cannot hand off directly
     *      to a pharmacy.
     *      Reverts, checked in this order: BatchNotFound, NotCustodian,
     *      TransferAlreadyPending, InvalidStatus (not Created or Stored),
     *      InvalidRecipient (zero address, the caller itself, or a route that is
     *      not allowed).
     * @param batchId  the lot to hand off
     * @param to       the organization that is to become the custodian
     */
    function initiateTransfer(uint256 batchId, address to) external;

    /**
     * @notice Step 2 of a hand-off: the named recipient accepts and becomes the custodian.
     * @dev Role: DISTRIBUTOR or RETAILER, and the caller must be pendingCustodian (C4).
     *      Status: InTransit -> Stored. Emits CustodyTransferred.
     *      Reverts, checked in this order: BatchNotFound, NoPendingTransfer,
     *      NotPendingCustodian.
     */
    function acceptTransfer(uint256 batchId) external;

    /**
     * @notice Cancel an open hand-off, e.g. one opened to the wrong organization.
     * @dev Role: MANUFACTURER or DISTRIBUTOR, and the caller must be the custodian (C4).
     *      The status goes back to what it was before initiateTransfer (Created
     *      or Stored). Emits TransferCancelled.
     *      Design decision C3: not in proposal Table I. Without it, a hand-off
     *      that the recipient never accepts would leave the lot InTransit for
     *      good, because only one hand-off can be open.
     *      Reverts, checked in this order: BatchNotFound, NotCustodian,
     *      NoPendingTransfer.
     */
    function cancelTransfer(uint256 batchId) external;

    /**
     * @notice A distributor moves a lot it holds between InTransit and Stored,
     *         e.g. warehouse to truck.
     * @dev Role: DISTRIBUTOR, and the caller must be the custodian (C4). No hand-off may be open.
     *      Only InTransit -> Stored and Stored -> InTransit are allowed. Every
     *      other pair reverts InvalidStatusTransition, including an update to
     *      the current status and any update of a Created, Delivered,
     *      Compromised or Recalled lot. Emits StatusUpdated.
     *      Reverts, checked in this order: BatchNotFound, NotCustodian,
     *      TransferAlreadyPending, InvalidStatusTransition.
     *      A `newStatus` outside the Status enum never reaches these checks: the
     *      ABI decoder rejects the call.
     */
    function updateStatus(uint256 batchId, Status newStatus) external;

    /**
     * @notice The pharmacy marks a lot it holds as delivered (end of the happy path).
     * @dev Role: RETAILER, and the caller must be the custodian (C4). Status: Stored -> Delivered.
     *      Emits StatusUpdated, so Fig. 1's event list needs no BatchDelivered event.
     *      Reverts: BatchNotFound, NotCustodian, InvalidStatus (not Stored).
     */
    function markDelivered(uint256 batchId) external;

    // =====================================================================
    //                      REGULATOR (journey stage: all)
    // =====================================================================

    /**
     * @notice Attach a regulator certificate to a lot, or replace the previous one.
     * @dev Role: REGULATOR. Allowed in every status except Recalled ("certify ...
     *      at any stage"); the status does not change. Overwrites `certificate`.
     *      The full history stays in CertificateIssued events, so no array grows
     *      in storage (design decision C6). Emits CertificateIssued.
     *      Reverts: BatchNotFound, InvalidStatus (Recalled), EmptyDocument.
     */
    function issueCertificate(uint256 batchId, DocumentRef calldata certificate) external;

    /**
     * @notice Recall a lot at any stage. Clears any open hand-off.
     * @dev Role: REGULATOR. Allowed in every status except Recalled, including
     *      Delivered and Compromised (design decision C2). Emits BatchRecalled.
     *      Status: any except Recalled -> Recalled, which is final.
     *      Reverts: BatchNotFound, InvalidStatus (already Recalled), EmptyReason.
     * @param batchId  the lot to recall
     * @param reason   why the lot is recalled; not empty. It is published in the
     *                 BatchRecalled event, so it must not contain personal data.
     */
    function recallBatch(uint256 batchId, string calldata reason) external;

    // =====================================================================
    //           IoT ORACLE (journey stages: Shipment, Storage)
    // =====================================================================

    /**
     * @notice Anchor a sensor-log file (uploaded to IPFS by the oracle) to a lot.
     * @dev Role: ORACLE. The lot must be active (Created, InTransit or Stored);
     *      the status does not change. Stores only the latest log and a counter;
     *      earlier logs stay in SensorLogAnchored events (plus the
     *      ExcursionReported event, if any), so a lot's storage does not grow
     *      with the number of logs. Emits SensorLogAnchored.
     *      Reverts: BatchNotFound, InvalidStatus, EmptyDocument.
     */
    function anchorSensorLog(uint256 batchId, DocumentRef calldata sensorLog) external;

    /**
     * @notice Report a temperature excursion. The lot becomes Compromised.
     * @dev Role: ORACLE. The lot must be active. The contract only checks that
     *      the REPORTED reading is outside the lot's registered range (a reading
     *      equal to either bound is in range). It cannot check that the reading
     *      is genuine, so the ORACLE key is trusted: a faulty or stolen key can
     *      mark any active lot Compromised, and no function undoes that (the
     *      only later status is Recalled). It records `sensorLog` as the latest
     *      log (incrementing sensorLogCount) and clears any open hand-off.
     *      Design decision C7. Emits ExcursionReported.
     *      Status: active -> Compromised.
     *      Reverts: BatchNotFound, InvalidStatus, InvalidTimestamp (observedAt is
     *      0 or in the future), ReadingWithinRange, EmptyDocument.
     * @param batchId         the lot the reading belongs to
     * @param readingTenthsC  the offending reading, in tenths of a degree C
     * @param observedAt      Unix seconds when the sensor took the reading; not 0
     *                        and not later than the block timestamp
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
     *      history come from this lot's events, not from storage (design
     *      decision O6).
     *      Reverts: BatchNotFound (also for ID 0).
     */
    function verifyBatch(uint256 batchId) external view returns (Batch memory);

    /// @notice Number of lots registered so far. IDs run from 1 to totalBatches().
    function totalBatches() external view returns (uint256);

    /// @notice Look up a lot ID by product hash. Returns 0 if not registered.
    function batchIdOf(bytes32 productHash) external view returns (uint256);
}
