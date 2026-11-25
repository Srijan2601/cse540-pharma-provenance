/**
 * Public entry point of the oracle package for Node callers: one import path
 * for the configuration, the IPFS storage library, the document toolkit, the
 * encryption envelope, the upload service, the sensor simulator, the
 * excursion rule and the oracle runner.
 *
 *   import { loadConfig, createStorage, createDocuments } from "../src/index.js";
 *   import { connectRegistry, createOracleRunner } from "../src/index.js";
 *
 * The browser dApp must not import this file (it pulls in node:fs and
 * node:http). It imports the browser-safe modules directly:
 * src/crypto/envelope.js, src/ipfs/cid.js, src/service/client.js,
 * src/documents/validator.js and src/documents/builders.js; and, to
 * re-evaluate a sensor log on the verify page, src/oracle/rule.js and
 * src/units.js.
 */

export * from "./config.js";
export * as envelope from "./crypto/envelope.js";
export * from "./documents/index.js";
export * from "./errors.js";
export * from "./ipfs/index.js";
export { UploadServiceClient } from "./service/client.js";
export { createUploadService } from "./service/server.js";
export * from "./units.js";

export { deriveSeed, hashWords, mix32, randomNoise, randomUnit } from "./simulator/prng.js";
export { SCENARIOS, SCENARIO_NAMES, assertRange, assertScenarioFits, getScenario, simulateReading } from "./simulator/scenarios.js";
export { createReadingSource, sensorSeed } from "./simulator/source.js";

export { describeRule, evaluateRule, isOutOfRange } from "./oracle/rule.js";
export { DEFAULT_RETRY_POLICY, abortableSleep, isTransientError, withRetry } from "./oracle/retry.js";
export {
  LOCAL_CHAIN_ID,
  LOCAL_ORACLE_ACCOUNT_INDEX,
  REQUIRED_FUNCTIONS,
  RegistryClient,
  STATUS_NAMES,
  connectRegistry,
  createProvider,
  decodeRevert,
  extractRevertData,
  isActiveStatus,
  loadDeployment,
  statusName,
} from "./oracle/registryClient.js";
export { createOracleRunner, systemClock } from "./oracle/runner.js";
export { formatEvent, formatEventJson, isDiagnostic } from "./oracle/format.js";
