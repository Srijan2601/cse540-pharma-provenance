// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RegistryBase} from "./base/RegistryBase.sol";
import {CustodyModule} from "./modules/CustodyModule.sol";
import {ConditionModule} from "./modules/ConditionModule.sol";
import {CertificationModule} from "./modules/CertificationModule.sol";

/**
 * @title ProvenanceRegistry
 * @notice One shared, tamper-evident record per drug lot. Rival supply-chain
 *         organizations write to it, each limited to its own functions, and
 *         anyone can verify a lot without a wallet. See IProvenanceRegistry
 *         for the data model, the events and the full function documentation.
 *
 * @dev This is the only contract that is deployed. It has no logic of its
 *      own: it composes the three modules, which all build on RegistryBase.
 *
 *        base/RegistryBase.sol            roles, storage, shared guards, views
 *        modules/CustodyModule.sol        registerBatch, initiateTransfer,
 *                                         acceptTransfer, cancelTransfer,
 *                                         updateStatus, markDelivered
 *        modules/ConditionModule.sol      anchorSensorLog, reportExcursion
 *        modules/CertificationModule.sol  issueCertificate, recallBatch
 *
 *      The modules are separate source files, not separate contracts on
 *      chain. The proposal promises a single registry, and one deployment
 *      keeps a lot's custody, condition and certification in one record that
 *      a single verifyBatch call returns. Splitting the source by concern
 *      keeps each file short enough to review against its part of the
 *      proposal.
 *
 *      Who can do what (proposal Table I, plus cancelTransfer from design
 *      decision C3; revokeRole is the inherited counterpart of Table I's
 *      "grant roles"):
 *        MANUFACTURER  registerBatch, initiateTransfer, cancelTransfer
 *        DISTRIBUTOR   acceptTransfer, updateStatus, initiateTransfer, cancelTransfer
 *        RETAILER      acceptTransfer, markDelivered (+ verifyBatch, which is public)
 *        REGULATOR     grantRole/revokeRole for the four roles above, issueCertificate, recallBatch
 *        ORACLE        anchorSensorLog, reportExcursion
 *        anyone        verifyBatch, totalBatches, batchIdOf (patients need no wallet)
 */
contract ProvenanceRegistry is CustodyModule, ConditionModule, CertificationModule {
    /**
     * @notice Deploy the registry with `regulator` as its administrator.
     * @dev All set-up happens in the RegistryBase constructor, which the three
     *      modules share, so it runs once.
     * @param regulator The regulator's wallet. It receives REGULATOR_ROLE and
     *        DEFAULT_ADMIN_ROLE and becomes the admin of the MANUFACTURER,
     *        DISTRIBUTOR, RETAILER and ORACLE roles. The deployer gets no role
     *        unless it is also the regulator. Reverts ZeroAddress if it is the
     *        zero address.
     */
    constructor(address regulator) RegistryBase(regulator) {}
}
