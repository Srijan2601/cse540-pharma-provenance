/**
 * Tests of the plain-language error messages. The first test is the important
 * one: it reads the committed contract ABI and fails when the contract has an
 * error the message table does not know.
 */

import { describe, expect, it } from "vitest";

import registryAbi from "@deployments/abi/ProvenanceRegistry.json";

import { ROLES, Status } from "./constants.js";
import { CONTRACT_ERROR_MESSAGES, describeContractError, explainError, UserMessageError } from "./errors.js";

const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("the contract error table", () => {
  const abiErrors = registryAbi.filter((entry) => entry.type === "error");

  it("has a sentence for every custom error in the ABI", () => {
    const missing = abiErrors.map((entry) => entry.name).filter((name) => !(name in CONTRACT_ERROR_MESSAGES));
    expect(missing).toEqual([]);
  });

  it("has no sentence for an error the contract no longer declares", () => {
    const declared = new Set(abiErrors.map((entry) => entry.name));
    expect(Object.keys(CONTRACT_ERROR_MESSAGES).filter((name) => !declared.has(name))).toEqual([]);
  });

  it("writes a sentence for every error from its ABI parameters alone", () => {
    for (const entry of abiErrors) {
      // Give each parameter a plausible value of its type, as a decoded revert would.
      const args = Object.fromEntries(
        entry.inputs.map((input) => [input.name, input.type === "address" ? ADDRESS : input.type === "bytes32" ? ROLES.DISTRIBUTOR.id : 2n]),
      );
      const sentence = describeContractError(entry.name, args);
      expect(sentence, entry.name).toMatch(/^[A-Z0-9].*\.$/);
      expect(sentence, entry.name).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

describe("describeContractError", () => {
  it("names the lot and the conflicting lot of a duplicate registration", () => {
    expect(describeContractError("DuplicateProduct", { productHash: "0x00", existingBatchId: 7n })).toBe(
      "This product code and lot number are already registered as lot #7. A lot can be registered only once.",
    );
  });

  it("explains the allowed hand-off routes for a refused recipient", () => {
    expect(describeContractError("InvalidRecipient", { to: ADDRESS })).toBe(
      "0x7099…79C8 cannot receive this lot. A manufacturer hands a lot to a distributor; a distributor hands it to " +
        "another distributor or to a pharmacy; nobody hands a lot to themselves.",
    );
  });

  it("shows temperatures in degrees", () => {
    expect(describeContractError("InvalidTemperatureRange", { minTempTenthsC: 80n, maxTempTenthsC: 20n })).toBe(
      "The allowed temperature range is not valid: the lowest temperature (8.0 °C) must be below the highest (2.0 °C).",
    );
  });

  it("names statuses and roles in words", () => {
    expect(describeContractError("InvalidStatus", { batchId: 3n, current: BigInt(Status.Delivered) })).toBe(
      "This is not possible while lot #3 is delivered.",
    );
    expect(describeContractError("AccessControlUnauthorizedAccount", { account: ADDRESS, neededRole: ROLES.RETAILER.id })).toBe(
      "This account does not hold the Pharmacy role, which this action needs. Ask the regulator to grant it.",
    );
    expect(describeContractError("MissingEitherRole", { account: ADDRESS, roleA: ROLES.MANUFACTURER.id, roleB: ROLES.DISTRIBUTOR.id })).toBe(
      "This account holds neither the Manufacturer nor the Distributor role, and this action needs one of them.",
    );
  });

  it("returns null for a name that is not a contract error", () => {
    expect(describeContractError("SomethingElse", {})).toBeNull();
  });
});

describe("explainError", () => {
  it("passes a message written for the person through unchanged", () => {
    expect(explainError(new UserMessageError("The attachment is an empty file."))).toBe("The attachment is an empty file.");
  });

  it("explains a revert decoded by ethers, whose arguments arrive as a Result", () => {
    const error = { code: "CALL_EXCEPTION", revert: { name: "NotCustodian", args: { toObject: () => ({ batchId: 4n, caller: ADDRESS }) } } };
    expect(explainError(error)).toBe("This account does not hold lot #4, so it cannot act on it.");
  });

  it("still says something useful for a revert it has no sentence for", () => {
    expect(explainError({ code: "CALL_EXCEPTION", revert: { name: "Paused", args: {} } })).toBe("The contract refused this action (Paused).");
  });

  it("explains a revert without data", () => {
    expect(explainError({ code: "CALL_EXCEPTION" })).toBe("The contract refused this action without giving a reason.");
  });

  it("explains a request declined in the wallet", () => {
    expect(explainError({ code: "ACTION_REJECTED" })).toBe("The request was declined in the wallet, so nothing was sent.");
    expect(explainError({ code: 4001, message: "User rejected the request." })).toBe(
      "The request was declined in the wallet, so nothing was sent.",
    );
  });

  it("explains an unreachable node, however the failure is reported", () => {
    const sentence = "The blockchain node did not answer. Check that it is running, then try again.";
    expect(explainError({ code: "NETWORK_ERROR" })).toBe(sentence);
    expect(explainError(new TypeError("Failed to fetch"))).toBe(sentence);
  });

  it("does not blame the node for a programming mistake", () => {
    expect(explainError(new TypeError("x is not a function"))).toBe("Something unexpected went wrong: x is not a function");
  });

  it("says where to start the file service when it does not answer, in one instruction", () => {
    const error = Object.assign(new Error('The upload service at http://127.0.0.1:8787 cannot be reached. Start it with "npm run service".'), {
      code: "SERVICE_REQUEST_FAILED",
    });
    expect(explainError(error)).toBe(
      'The upload service at http://127.0.0.1:8787 cannot be reached. Start it in the oracle/ folder with "npm run service".',
    );
  });

  it("does not add start-up advice to a file service message that has none", () => {
    const message = "The service at http://127.0.0.1:8787 answered an upload without a valid CID; is this the upload service?";
    expect(explainError(Object.assign(new Error(message), { code: "SERVICE_REQUEST_FAILED" }))).toBe(message);
  });

  it("explains that a hand-off may have been settled by the other side in the meantime", () => {
    expect(explainError({ code: "CALL_EXCEPTION", revert: { name: "NoPendingTransfer", args: { batchId: 2n } } })).toBe(
      "Lot #2 has no open hand-off. It may have been accepted or cancelled in the meantime.",
    );
  });

  it("passes on the file service's own explanation of a refused upload", () => {
    const error = Object.assign(new Error("The upload service answered HTTP 413: too large"), { code: "SERVICE_REQUEST_FAILED", status: 413 });
    expect(explainError(error)).toBe("The upload service answered HTTP 413: too large");
  });

  it("passes on the encryption module's explanation of a wrong key", () => {
    const error = Object.assign(new Error("Decryption failed: the key is wrong, or the file was modified after it was encrypted."), {
      code: "ENVELOPE_AUTH_FAILED",
    });
    expect(explainError(error)).toBe("Decryption failed: the key is wrong, or the file was modified after it was encrypted.");
  });

  it("lists what a schema rejected when a document cannot be built", () => {
    const error = { code: "DOCUMENT_INVALID", errors: [{ path: "/site", message: "must NOT have fewer than 1 characters" }] };
    expect(explainError(error)).toBe("The document could not be built: /site must NOT have fewer than 1 characters.");
  });
});
