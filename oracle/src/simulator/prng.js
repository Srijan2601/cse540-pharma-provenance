/**
 * The simulator's own seeded pseudo-random numbers.
 *
 * Why not Math.random: the demo, the tests and the documentation must show
 * the same readings every time for the same SIM_SEED, and Math.random cannot
 * be seeded.
 *
 * Why counter-based instead of a generator with internal state: a reading is
 * defined as a pure function of (seed, lot, reading index). Each random value
 * is therefore computed directly from those numbers by hashing them, so
 * reading number 500 can be produced without producing the 499 before it,
 * two lots never share a random stream, and nothing has to be saved for the
 * series to continue after a restart.
 *
 * The hash is the 32-bit finalizer of MurmurHash3 applied once per input
 * word. It is a statistical mixer, not a cryptographic one: good enough to
 * make simulated sensor noise look random, and never used for keys or
 * anything a party could want to predict or forge.
 *
 * No imports: this file also runs in the browser.
 */

/** 2^32: the number of values a 32-bit word can take. */
const UINT32_RANGE = 0x100000000;

/** Odd constant derived from the golden ratio; keeps successive inputs from cancelling each other out. */
const GOLDEN_GAMMA = 0x9e3779b9;

/**
 * Scramble a 32-bit word so that every input bit affects every output bit
 * (the "fmix32" finalizer of MurmurHash3).
 *
 * @param {number} value any number; only its low 32 bits are used
 * @returns {number} an unsigned 32-bit integer
 */
export function mix32(value) {
  let x = value >>> 0;
  // Math.imul is 32-bit integer multiplication; a plain "*" would lose the low bits in a double.
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Hash a sequence of non-negative integers into one 32-bit word. The order
 * matters: hashWords(1, 2) and hashWords(2, 1) are unrelated.
 *
 * @param {...number} words non-negative safe integers (a seed, a lot id, a reading index, a stream number)
 * @returns {number} an unsigned 32-bit integer
 * @throws {TypeError} when a word is not a non-negative safe integer
 */
export function hashWords(...words) {
  let state = GOLDEN_GAMMA;
  for (const word of words) {
    if (!Number.isSafeInteger(word) || word < 0) {
      throw new TypeError(`The random generator takes non-negative whole numbers, got ${String(word)}.`);
    }
    // A safe integer has up to 53 bits, so it is absorbed as two 32-bit halves. The high half is
    // absorbed even when it is zero, which keeps the number of rounds independent of the value.
    state = mix32((state ^ (word >>> 0)) + GOLDEN_GAMMA);
    state = mix32((state ^ Math.floor(word / UINT32_RANGE)) + GOLDEN_GAMMA);
  }
  return state;
}

/**
 * A uniformly distributed number in [0, 1) that depends only on its arguments.
 *
 * @param {number} seed   the stream's seed
 * @param {number} stream which quantity is being drawn (noise, phase, ...), so different quantities are independent
 * @param {number} [index] position in the stream, for values that change from reading to reading
 * @returns {number} 0 <= value < 1
 */
export function randomUnit(seed, stream, index = 0) {
  return hashWords(seed, stream, index) / UINT32_RANGE;
}

/**
 * A number in [-1, 1) with a triangular distribution around 0: the sum of two
 * uniform draws. Small deviations are more likely than large ones, which is
 * closer to real sensor noise than a flat distribution.
 *
 * @param {number} seed
 * @param {number} stream
 * @param {number} [index]
 * @returns {number} -1 <= value < 1
 */
export function randomNoise(seed, stream, index = 0) {
  // The second draw uses the bitwise complement of the stream number, so it is a different stream
  // from every small stream number a caller passes.
  return randomUnit(seed, stream, index) + randomUnit(seed, ~stream >>> 0, index) - 1;
}

/**
 * Derive an independent seed from a seed and some identifying numbers, for
 * example one seed per lot from SIM_SEED and the lot id.
 *
 * @param {number} seed
 * @param {...number} words
 * @returns {number} an unsigned 32-bit integer usable as a seed
 */
export function deriveSeed(seed, ...words) {
  return hashWords(seed, ...words);
}
