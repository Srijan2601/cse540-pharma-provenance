// Generic helpers shared by the unit tests (test/unit/) and the integration
// tests (test/integration/).
//
// Nothing here deploys a registry or knows its fixtures: the module only
// needs a contract instance for its ABI. That keeps the integration tests
// independent of the unit fixtures in test/helpers/registry.js while the two
// suites still share one copy of these small pieces.
//
// Mocha loads every .js file under test/, including this one. The module only
// defines functions, so loading it registers no tests.

/**
 * Mulberry32, a small deterministic PRNG. The random walks use it so that the
 * same seed always produces the same sequence of calls, and a failure can be
 * reproduced from the step number in its message.
 * @param {number} seed  any 32-bit integer
 * @returns {() => number} a function returning floats in [0, 1)
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Decode revert data as one of the custom errors that `contract`'s ABI
 * declares, or return null.
 *
 * `contract.interface.parseError` alone is not enough for that: ethers also
 * decodes Solidity's built-in Panic(uint256) and Error(string), which no ABI
 * declares, so an arithmetic panic or a require-string revert would pass for
 * an expected rejection. This function first checks the 4-byte selector
 * against the error fragments of the ABI itself.
 * @param {import("ethers").BaseContract} contract  supplies the ABI
 * @param {unknown} data  revert data, normally `error.data` of a failed call
 * @returns {import("ethers").ErrorDescription | null}
 */
export function decodeDeclaredError(contract, data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const declared = contract.interface.fragments.some(
    (fragment) => fragment.type === "error" && fragment.selector === selector,
  );
  return declared ? contract.interface.parseError(data) : null;
}
