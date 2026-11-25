/**
 * Encryption envelope v1 for confidential documents (proposal section 5:
 * "encrypting confidential documents before upload"; design decision O5).
 *
 * What is encrypted and why. Lot metadata, regulator certificates and sensor
 * logs stay public plaintext, because a patient must be able to read and
 * verify them. Attachments an organization does not want to publish (the
 * full certificate of analysis, commercial paperwork) are encrypted BEFORE
 * they are uploaded, since anything on public IPFS is readable by everyone,
 * forever. The on-chain contentHash is computed over the ENCRYPTED bytes, so
 * anyone can still verify that the file was not swapped, while only key
 * holders can read it. Keys are handed over out of band; they are never
 * uploaded and never put on-chain.
 *
 * Envelope layout (all of it is the "uploaded bytes"):
 *
 *   byte 0        0x01, the envelope version
 *   bytes 1..12   IV, 96 random bits, fresh for every encryption
 *   bytes 13..    AES-256-GCM ciphertext followed by the 16-byte authentication
 *                 tag, exactly as SubtleCrypto.encrypt returns it
 *
 * Key: 32 random bytes, exchanged as 43 characters of unpadded base64url.
 * No additional authenticated data is used; the version byte is checked
 * before decryption, and any change to the IV, ciphertext or tag makes the
 * tag check fail.
 *
 * Portability: this file has NO imports and uses only the WebCrypto API
 * (globalThis.crypto) plus atob and btoa, which exist both in Node.js >= 22
 * and in browsers. The dApp can import this same file,
 * so a document encrypted by the CLI decrypts in the browser and vice versa.
 * That is also why the error class is defined here instead of in ../errors.js.
 */

/** Version byte of the envelope format described above. */
export const ENVELOPE_VERSION = 1;
/** Cipher name recorded in a document's attachment entry. */
export const ENCRYPTION_SCHEME = "AES-256-GCM";
/** Key length in bytes (AES-256). */
export const KEY_BYTES = 32;
/** IV length in bytes; 96 bits is the size AES-GCM is designed for. */
export const IV_BYTES = 12;
/** Authentication tag length in bytes. */
export const TAG_BYTES = 16;
/** Bytes before the ciphertext: version + IV. */
export const HEADER_BYTES = 1 + IV_BYTES;

/**
 * The value of an attachment's "encryption" field in a lot-metadata or
 * regulator-certificate document when the attachment uses this envelope.
 */
export const ENCRYPTION_DESCRIPTOR = Object.freeze({ scheme: ENCRYPTION_SCHEME, envelope: ENVELOPE_VERSION });

/**
 * Failure of an envelope operation. `code` is one of:
 *   ENVELOPE_KEY_INVALID      the key is not 32 bytes / not valid base64url
 *   ENVELOPE_MALFORMED        the input is too short to be an envelope
 *   ENVELOPE_VERSION          the version byte is not supported
 *   ENVELOPE_AUTH_FAILED      wrong key, or the envelope was modified
 *   ENVELOPE_UNAVAILABLE      WebCrypto is missing (a browser page that is not a secure context)
 * Messages never contain key material.
 */
export class EnvelopeError extends Error {
  /**
   * @param {string} message
   * @param {string} code one of the codes listed above
   */
  constructor(message, code) {
    super(message);
    this.name = "EnvelopeError";
    this.code = code;
  }
}

/**
 * Create a new random 256-bit key.
 * @returns {Uint8Array} 32 bytes from the platform's cryptographic random generator
 */
export function generateKey() {
  return webCrypto().getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 * Encode a key as text for hand-over (unpadded base64url, 43 characters).
 * @param {Uint8Array} key 32 bytes
 * @returns {string}
 * @throws {EnvelopeError} ENVELOPE_KEY_INVALID when the key is not 32 bytes
 */
export function encodeKey(key) {
  assertKeyBytes(key);
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decode a key from its text form.
 * @param {string} text 43 base64url characters (one trailing "=" is tolerated)
 * @returns {Uint8Array} 32 bytes
 * @throws {EnvelopeError} ENVELOPE_KEY_INVALID; the message does not echo the input
 */
export function decodeKey(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{43}=?$/.test(text.trim())) {
    throw new EnvelopeError(
      "The key must be 43 base64url characters (A-Z a-z 0-9 - _), which encode 32 bytes.",
      "ENVELOPE_KEY_INVALID",
    );
  }
  const binary = atob(text.trim().replace(/=$/, "").replaceAll("-", "+").replaceAll("_", "/"));
  const key = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) key[i] = binary.charCodeAt(i);
  assertKeyBytes(key);
  return key;
}

/**
 * Encrypt a document into an envelope. A new random IV is drawn on every
 * call, so encrypting the same plaintext twice gives different envelopes
 * (and therefore different CIDs and content hashes).
 *
 * @param {Uint8Array|ArrayBuffer} plaintext the document bytes
 * @param {Uint8Array|string} key 32 bytes, or their base64url text form
 * @returns {Promise<Uint8Array>} the envelope: these are the bytes to hash and upload
 * @throws {EnvelopeError} ENVELOPE_KEY_INVALID, ENVELOPE_UNAVAILABLE
 */
export async function encrypt(plaintext, key) {
  const cryptoKey = await importKey(key, "encrypt");
  const iv = webCrypto().getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await webCrypto().subtle.encrypt({ name: "AES-GCM", iv, tagLength: TAG_BYTES * 8 }, cryptoKey, asBytes(plaintext)),
  );
  const envelope = new Uint8Array(HEADER_BYTES + sealed.length);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(iv, 1);
  envelope.set(sealed, HEADER_BYTES);
  return envelope;
}

/**
 * Decrypt an envelope. Succeeds only if the key is right AND no byte of the
 * envelope was changed (AES-GCM authenticates the ciphertext).
 *
 * @param {Uint8Array|ArrayBuffer} envelope the bytes exactly as downloaded
 * @param {Uint8Array|string} key 32 bytes, or their base64url text form
 * @returns {Promise<Uint8Array>} the original document bytes
 * @throws {EnvelopeError} ENVELOPE_MALFORMED, ENVELOPE_VERSION, ENVELOPE_KEY_INVALID, ENVELOPE_AUTH_FAILED
 */
export async function decrypt(envelope, key) {
  const { iv, sealed } = inspectEnvelope(envelope);
  const cryptoKey = await importKey(key, "decrypt");
  try {
    return new Uint8Array(await webCrypto().subtle.decrypt({ name: "AES-GCM", iv, tagLength: TAG_BYTES * 8 }, cryptoKey, sealed));
  } catch {
    // WebCrypto reports every authentication failure the same way on purpose; there is nothing more specific to pass on.
    throw new EnvelopeError(
      "Decryption failed: the key is wrong, or the file was modified after it was encrypted.",
      "ENVELOPE_AUTH_FAILED",
    );
  }
}

/**
 * Split an envelope into its parts without decrypting it. Useful to recognise
 * an encrypted attachment and to show its sizes.
 *
 * @param {Uint8Array|ArrayBuffer} envelope
 * @returns {{ version: number, iv: Uint8Array, sealed: Uint8Array, plaintextLength: number }}
 *          `sealed` is the ciphertext followed by the 16-byte tag
 * @throws {EnvelopeError} ENVELOPE_MALFORMED when it is too short, ENVELOPE_VERSION when byte 0 is not 0x01
 */
export function inspectEnvelope(envelope) {
  const bytes = asBytes(envelope);
  if (bytes.length < HEADER_BYTES + TAG_BYTES) {
    throw new EnvelopeError(
      `Not an encryption envelope: ${bytes.length} bytes is shorter than the ${HEADER_BYTES + TAG_BYTES}-byte minimum (version, IV and tag).`,
      "ENVELOPE_MALFORMED",
    );
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new EnvelopeError(
      `Unsupported envelope version ${bytes[0]}: this code reads version ${ENVELOPE_VERSION}. The file may not be encrypted at all.`,
      "ENVELOPE_VERSION",
    );
  }
  return {
    version: bytes[0],
    iv: bytes.slice(1, HEADER_BYTES),
    sealed: bytes.slice(HEADER_BYTES),
    plaintextLength: bytes.length - HEADER_BYTES - TAG_BYTES,
  };
}

/**
 * The platform's WebCrypto object.
 * @returns {Crypto}
 */
function webCrypto() {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new EnvelopeError(
      "The WebCrypto API is not available. In a browser it requires a secure context (https, or http://localhost).",
      "ENVELOPE_UNAVAILABLE",
    );
  }
  return crypto;
}

/**
 * Turn raw key bytes (or their text form) into a non-extractable WebCrypto key for one operation.
 * @param {Uint8Array|string} key
 * @param {"encrypt"|"decrypt"} usage
 * @returns {Promise<CryptoKey>}
 */
async function importKey(key, usage) {
  const raw = typeof key === "string" ? decodeKey(key) : key;
  assertKeyBytes(raw);
  return webCrypto().subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

/**
 * Reject anything that is not a 256-bit key.
 * @param {unknown} key
 * @throws {EnvelopeError} unless `key` is exactly 32 bytes
 */
function assertKeyBytes(key) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new EnvelopeError(`The key must be exactly ${KEY_BYTES} bytes (AES-256).`, "ENVELOPE_KEY_INVALID");
  }
}

/**
 * Normalize a byte container to a Uint8Array.
 * @param {Uint8Array|ArrayBuffer} value
 * @returns {Uint8Array}
 */
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a Uint8Array or ArrayBuffer.");
}
