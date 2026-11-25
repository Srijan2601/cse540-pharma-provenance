/**
 * The verify link that a lot's QR code encodes, and how the verify page reads it.
 *
 *   <base>#/verify?lot=<id>&chain=<chainId>&registry=<address>
 *
 * The link names the chain and the registry as well as the lot (design
 * decision O6), so a printed code keeps pointing at the same record even if
 * the app is later built against another deployment. The route sits in the
 * URL hash, so the link works from any static host without server rewrites.
 *
 * Everything in a scanned link is untrusted input: parseVerifyQuery accepts
 * only a positive integer, a chain id and a well-formed address, and the page
 * separately refuses a registry it does not know (see lib/networks.js).
 */

import { getAddress, isAddress } from "ethers";

/** Lot ids and chain ids are small positive integers; the cap keeps them inside JavaScript's exact range. */
const POSITIVE_INTEGER = /^[1-9]\d{0,14}$/;

/**
 * The verify page's route inside the app (what follows the "#" in the address).
 *
 * @param {object} target
 * @param {number} target.lotId     the lot's id in the registry
 * @param {number} target.chainId   chain the registry is deployed on
 * @param {string|null} target.registry  address of the registry; left out of the link when null
 * @returns {string} for example "/verify?lot=3&chain=31337&registry=0x…"
 */
export function buildVerifyRoute({ lotId, chainId, registry }) {
  const query = new URLSearchParams({ lot: String(lotId), chain: String(chainId) });
  // No registry is known before the first local deploy; the link then means "the registry this app knows".
  if (registry) query.set("registry", registry);
  return `/verify?${query.toString()}`;
}

/**
 * Build the complete verify link of a lot, as encoded in its QR code.
 *
 * @param {object} target
 * @param {string} target.baseUrl   address of the app without a hash, for example "http://192.168.1.20:5173/"
 * @param {number} target.lotId
 * @param {number} target.chainId
 * @param {string} target.registry
 * @returns {string} the URL to encode in the QR code
 */
export function buildVerifyUrl({ baseUrl, lotId, chainId, registry }) {
  // Drop any query or hash a configured base may carry, so exactly one route ends up in the link.
  const base = String(baseUrl).split(/[?#]/)[0];
  return `${base}#${buildVerifyRoute({ lotId, chainId, registry })}`;
}

/**
 * @typedef {object} VerifyTarget
 * @property {number|null} lotId      null when the link has no usable lot id
 * @property {number|null} chainId    null when the link does not name a chain (the page then uses its default)
 * @property {string|null} registry   checksummed address, or null when the link does not name one
 * @property {string[]} problems      one sentence per malformed parameter; empty when the link is well formed
 */

/**
 * Read the parameters of a verify link.
 *
 * @param {URLSearchParams} query the query part of the route
 * @returns {VerifyTarget}
 */
export function parseVerifyQuery(query) {
  const problems = [];

  const lotText = query.get("lot");
  let lotId = null;
  if (lotText === null || lotText.trim() === "") {
    problems.push("The link does not say which lot to verify.");
  } else if (POSITIVE_INTEGER.test(lotText.trim())) {
    lotId = Number(lotText.trim());
  } else {
    problems.push("The lot id in the link is not a positive whole number.");
  }

  const chainText = query.get("chain");
  let chainId = null;
  if (chainText !== null && chainText !== "") {
    if (POSITIVE_INTEGER.test(chainText)) chainId = Number(chainText);
    else problems.push("The chain id in the link is not a positive whole number.");
  }

  const registryText = query.get("registry");
  let registry = null;
  if (registryText !== null && registryText !== "") {
    if (isAddress(registryText)) registry = getAddress(registryText);
    else problems.push("The registry address in the link is not a valid address.");
  }

  return { lotId, chainId, registry, problems };
}
