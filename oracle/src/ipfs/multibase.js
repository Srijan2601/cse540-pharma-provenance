/**
 * The three small encodings a CID is made of, implemented here so the package
 * needs no IPFS dependency: RFC 4648 base32 (lower case, no padding), base58btc
 * (only needed to read legacy "Qm..." CIDv0 strings) and the unsigned varint
 * (LEB128) used for the version, codec and multihash fields.
 *
 * Decoding is strict on purpose. A CID string arrives from untrusted places (a
 * URL path, a pinning service's response, the chain), and exactly one string
 * may represent a given CID: if two spellings decoded to the same bytes, the
 * same content could sit under two names in the local store. So anything that
 * is not the canonical encoding is rejected.
 *
 * No Node-only imports: this file also runs in the browser.
 */

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Character -> value lookup tables, built once from the alphabets above. */
const BASE32_VALUES = new Map([...BASE32_ALPHABET].map((char, index) => [char, index]));
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

/**
 * Encode bytes as lower-case base32 without padding (the body of a "b..." multibase string).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base32Encode(bytes) {
  let text = "";
  let buffer = 0; // holds the bits not yet emitted
  let bits = 0; // how many of them
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1; // keep only the pending bits so the accumulator never overflows 32 bits
  }
  if (bits > 0) {
    text += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return text;
}

/**
 * Decode lower-case, unpadded base32. Throws on any character outside the
 * alphabet (including upper case and "="), on a length no byte string encodes
 * to, and on non-zero trailing bits.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base32Decode(text) {
  // 8 characters carry 5 bytes; a remainder of 1, 3 or 6 characters cannot hold a whole number of bytes.
  const remainder = text.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) {
    throw new RangeError("base32 text has an impossible length");
  }
  const bytes = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of text) {
    const value = BASE32_VALUES.get(char);
    if (value === undefined) {
      throw new RangeError("base32 text contains a character outside a-z and 2-7");
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >>> bits) & 0xff;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) {
    // Left-over bits must be zero, otherwise several strings would decode to the same bytes.
    throw new RangeError("base32 text is not canonical (non-zero trailing bits)");
  }
  return bytes;
}

/**
 * Decode a base58btc string (Bitcoin alphabet), as used by CIDv0.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base58Decode(text) {
  // Little-endian base-256 digits of the number, grown as each base-58 digit is folded in.
  const digits = [];
  for (const char of text) {
    let carry = BASE58_VALUES.get(char);
    if (carry === undefined) {
      throw new RangeError("base58 text contains a character outside the Bitcoin alphabet");
    }
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 58;
      digits[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" stands for one leading zero byte, which the number itself cannot represent.
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === "1") leadingZeros++;
  const bytes = new Uint8Array(leadingZeros + digits.length);
  for (let i = 0; i < digits.length; i++) {
    bytes[bytes.length - 1 - i] = digits[i];
  }
  return bytes;
}

/**
 * Encode a non-negative integer as an unsigned varint.
 * @param {number} value a safe integer >= 0
 * @returns {number[]} the bytes, least significant group first
 */
export function varintEncode(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("varint value must be a non-negative safe integer");
  }
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

/**
 * Read one unsigned varint from `bytes` starting at `offset`.
 *
 * Limited to 4 bytes (values below 2^28): every multicodec and multihash code
 * and every digest length fits, and a short limit stops a crafted input from
 * making the parser do unbounded work. Non-minimal encodings (a trailing zero
 * group) are rejected so each number has exactly one encoding.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{ value: number, next: number }} the value and the offset just after it
 */
export function varintDecode(bytes, offset) {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const position = offset + i;
    if (position >= bytes.length) {
      throw new RangeError("varint is cut short");
    }
    const byte = bytes[position];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) {
        throw new RangeError("varint is not minimally encoded");
      }
      return { value, next: position + 1 };
    }
  }
  throw new RangeError("varint is longer than 4 bytes");
}
