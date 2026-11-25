/**
 * Patient verify page, opened from a lot's QR code:
 *
 *   #/verify?lot=<id>&chain=<chainId>&registry=<address>
 *
 * No wallet, no sign-in: the page reads the lot and its events over plain
 * JSON-RPC, downloads the lot's files from the gateway and compares each with
 * the fingerprint recorded on the blockchain.
 *
 * Trust comes in three steps, and the page stops at the first that fails:
 *   1. The link must be well formed and must point at a registry this app
 *      knows. Otherwise the page shows a warning and reads nothing: anyone can
 *      deploy a look-alike contract and print a QR code for it.
 *   2. The lot must exist in that registry.
 *   3. Each file must match its recorded fingerprint before its content is shown.
 *
 * The page re-reads the chain every few seconds, so an excursion or a recall
 * shows up while the page is open.
 */

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { createLotRecordReader } from "../chain/history.js";
import { Layout } from "../components/Layout.jsx";
import { Notice } from "../components/Notice.jsx";
import { LotQrCode } from "../components/QrCode.jsx";
import { RegistryGate } from "../components/RegistryGate.jsx";
import { Documents } from "../components/verify/Documents.jsx";
import { LotFacts } from "../components/verify/LotFacts.jsx";
import { TemperatureHistory } from "../components/verify/TemperatureChart.jsx";
import { Timeline } from "../components/verify/Timeline.jsx";
import { VerdictBanner } from "../components/verify/VerdictBanner.jsx";
import { config } from "../config.js";
import { useFileChecks } from "../hooks/useFileChecks.js";
import { usePolling } from "../hooks/usePolling.js";
import { sameAddress } from "../lib/actions.js";
import { explainError } from "../lib/errors.js";
import { replayHistory } from "../lib/history.js";
import { fileKey, interpretDocument, listAttachments, listRecordedDocuments } from "../lib/lotDocuments.js";
import { resolveVerifyTarget } from "../lib/networks.js";
import { collectReadings } from "../lib/temperature.js";
import { computeVerdict } from "../lib/verdict.js";
import { parseVerifyQuery } from "../lib/verifyLink.js";

/**
 * The record of one lot: verdict, facts, documents, history, temperature, QR code.
 * @param {{ network: import("../lib/networks.js").Network, lotId: number }} props
 */
function LotRecord({ network, lotId }) {
  const reader = useMemo(() => createLotRecordReader(network, lotId), [network, lotId]);
  const { data, loading, error } = usePolling(reader, network.pollMs);

  const lot = data?.lot ?? null;
  const history = useMemo(() => replayHistory(data?.events ?? []), [data]);

  // Files named by the chain first; attachments only once the documents that list them are verified.
  const recorded = useMemo(() => (lot ? listRecordedDocuments(lot, history) : []), [lot, history]);
  const recordedChecks = useFileChecks(
    recorded.map((entry) => entry.ref),
    data?.readAt,
  );
  const lotContext = useMemo(
    () => (lot ? { chainId: network.chainId, registry: network.registry, lotId: lot.id, productHash: lot.productHash } : null),
    [lot, network],
  );
  const checkedRecorded = useMemo(
    () => recorded.map((entry) => interpretDocument(entry, recordedChecks[fileKey(entry.ref)], lotContext)),
    [recorded, recordedChecks, lotContext],
  );
  const attachments = useMemo(
    () => listAttachments(checkedRecorded.filter((entry) => entry.kind === "lot-metadata" || entry.kind === "regulator-certificate")),
    [checkedRecorded],
  );
  const attachmentChecks = useFileChecks(
    attachments.map((entry) => entry.ref),
    data?.readAt,
  );

  if (loading) {
    return (
      <p className="muted" role="status">
        Reading lot {lotId} from the blockchain…
      </p>
    );
  }
  if (data === undefined) {
    return (
      <Notice tone="error" title="The lot could not be read" live>
        <p>{explainError(error)}</p>
      </Notice>
    );
  }
  if (lot === null) {
    return (
      <Notice tone="warning" title={`Lot ${lotId} is not in the registry`}>
        <p>
          No lot with this ID has been registered. Check the number. If it came from a QR code on a package, this record does not
          vouch for that package.
        </p>
        <p>
          <Link to="/">See the list of registered lots</Link>
        </p>
      </Notice>
    );
  }

  const documents = [...checkedRecorded, ...attachments.map((entry) => interpretDocument(entry, attachmentChecks[fileKey(entry.ref)], lotContext))];
  const metadata = checkedRecorded[0];
  const sensorLogs = checkedRecorded.filter((entry) => entry.kind === "sensor-log");
  const readings = collectReadings(
    sensorLogs.filter((entry) => entry.document).map((entry) => ({ index: entry.logIndex, readings: entry.document.readings })),
  );

  // The events were read up to the same block as the lot, so replaying them must give the lot's current state.
  const historyComplete =
    history.status === lot.status &&
    sameAddress(history.custodian, lot.custodian) &&
    (history.pendingCustodian === null ? lot.pendingCustodian === null : sameAddress(history.pendingCustodian, lot.pendingCustodian)) &&
    history.sensorLogs.length === lot.sensorLogCount;

  const verdict = computeVerdict({
    lot,
    history,
    documents,
    holderRoles: data.rolesByAddress[lot.custodian] ?? [],
    historyComplete,
  });
  const filesMissing = documents.some((entry) => entry.status === "unavailable");

  return (
    <div className="stack">
      <VerdictBanner verdict={verdict} />
      {filesMissing ? (
        <Notice tone="warning" title="Some files could not be fetched">
          <p>
            The file gateway at {config.gatewayUrl} did not deliver them. For the local demo, start the file service with{" "}
            <code>npm run service</code> in the <code>oracle/</code> folder; this page then picks the files up by itself.
          </p>
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="warning" title="The latest refresh failed">
          <p>{explainError(error)} The page shows what it read at {new Date(data.readAt).toLocaleTimeString("en-US")}.</p>
        </Notice>
      ) : null}
      <LotFacts lot={lot} metadata={metadata} rolesByAddress={data.rolesByAddress} />
      <Documents documents={documents} />
      <Timeline entries={history.entries} rolesByAddress={data.rolesByAddress} />
      <TemperatureHistory
        readings={readings}
        range={{ minTenthsC: lot.minTempTenthsC, maxTenthsC: lot.maxTempTenthsC }}
        excursion={history.excursion}
        logCount={sensorLogs.length}
        logsUsable={sensorLogs.filter((entry) => entry.document).length}
      />
      <section className="card" aria-labelledby="qr-title">
        <h2 id="qr-title">This lot's QR code</h2>
        <LotQrCode network={network} lotId={lot.id} />
      </section>
      <p className="small muted">
        Read from {network.name}, registry <span className="mono breakable">{network.registry}</span>, at{" "}
        {new Date(data.readAt).toLocaleTimeString("en-US")}. This page updates by itself every few seconds.
      </p>
    </div>
  );
}

export function VerifyPage() {
  const [query] = useSearchParams();
  const target = useMemo(() => parseVerifyQuery(query), [query]);
  const resolved = resolveVerifyTarget(target, config.networks, config.defaultChainId);

  let content;
  if (target.problems.length > 0) {
    content = (
      <Notice tone="error" title="This verify link is not valid">
        {target.problems.map((problem) => (
          <p key={problem}>{problem}</p>
        ))}
        <p>
          Nothing was checked. Scan the QR code again, or <Link to="/">enter the lot ID by hand</Link>.
        </p>
      </Notice>
    );
  } else if (!resolved.trusted) {
    const known = resolved.network ?? config.defaultNetwork;
    content = (
      <Notice tone="error" title="Not verified: this link does not lead to the official registry">
        <p>{resolved.reason}</p>
        <p>
          A counterfeiter can set up a registry of their own, in which every lot looks genuine, and print a QR code that points
          at it. This page therefore shows nothing from the registry named in the link. Do not rely on this code.
        </p>
        <dl className="facts facts--compact">
          <div className="facts__row">
            <dt>Registry in the link</dt>
            <dd className="mono breakable">
              {target.registry ?? "none"} on chain {target.chainId ?? "not named"}
            </dd>
          </div>
          <div className="facts__row">
            <dt>Registry this app knows</dt>
            <dd className="mono breakable">
              {known.registry ?? "none yet"} on chain {known.chainId}
            </dd>
          </div>
        </dl>
        {/*
          The warning offers no way on to "this lot ID in the known registry": whoever printed the code chose the ID,
          so such a link would take the reader from this warning to a genuine record of some other lot.
        */}
      </Notice>
    );
  } else {
    content = (
      <RegistryGate network={resolved.network}>
        {/* The key starts a fresh record, with no state left over, when the link changes to another lot. */}
        <LotRecord key={`${resolved.network.chainId}-${target.lotId}`} network={resolved.network} lotId={target.lotId} />
      </RegistryGate>
    );
  }

  return (
    <Layout narrow>
      <div className="stack">
        <h1 className="verify-heading">{target.lotId === null ? "Verify a lot" : `Verification of lot ${target.lotId}`}</h1>
        {content}
      </div>
    </Layout>
  );
}
