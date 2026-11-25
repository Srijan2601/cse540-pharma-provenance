/**
 * The panels of the three organizations that hold lots (proposal Table I):
 *
 *   Manufacturer   registerBatch, initiateTransfer, cancelTransfer
 *   Distributor    acceptTransfer, updateStatus, initiateTransfer, cancelTransfer
 *   Pharmacy       acceptTransfer, verifyBatch (the verify page), markDelivered
 *
 * Each panel filters the registry's lots down to the ones that concern the
 * signed-in account: lots it holds, and hand-offs addressed to it.
 */

import { sameAddress } from "../../lib/actions.js";
import { CommandSteps } from "../CommandSteps.jsx";
import { CustodyLotRow, LotList } from "./LotRow.jsx";
import { RegisterLotForm } from "./RegisterLotForm.jsx";

/**
 * The two lists a custody panel is made of.
 * @param {import("./LotRow.jsx").DashboardData} data
 * @returns {{ held: import("../../chain/registry.js").Lot[], incoming: import("../../chain/registry.js").Lot[] }}
 */
function lotsOf(data) {
  return {
    held: data.lots.filter((lot) => sameAddress(lot.custodian, data.address)),
    incoming: data.lots.filter((lot) => sameAddress(lot.pendingCustodian, data.address)),
  };
}

/**
 * A titled card with a list of lots.
 * @param {object} props
 * @param {string} props.id            id for the heading, unique on the page
 * @param {string} props.title
 * @param {string} props.emptyText
 * @param {import("../../chain/registry.js").Lot[]} props.lots
 * @param {import("./LotRow.jsx").DashboardData} props.data
 * @param {"MANUFACTURER"|"DISTRIBUTOR"|"RETAILER"} props.role
 * @param {boolean} [props.offerQr]
 */
function LotCard({ id, title, emptyText, lots, data, role, offerQr = false }) {
  return (
    <section className="card" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <LotList
        lots={lots}
        emptyText={emptyText}
        renderLot={(lot) => <CustodyLotRow key={lot.id} data={data} lot={lot} role={role} offerQr={offerQr} />}
      />
    </section>
  );
}

/** @param {{ data: import("./LotRow.jsx").DashboardData }} props */
export function ManufacturerPanel({ data }) {
  const { held } = lotsOf(data);
  return (
    <section className="stack-small" aria-labelledby="manufacturer-panel-title">
      <h2 id="manufacturer-panel-title">Manufacturer</h2>
      <RegisterLotForm network={data.network} />
      <LotCard
        id="manufacturer-lots-title"
        title="My lots"
        emptyText="This account holds no lot. Lots you registered and handed off are no longer listed here."
        lots={held}
        data={data}
        role="MANUFACTURER"
        offerQr
      />
    </section>
  );
}

/** @param {{ data: import("./LotRow.jsx").DashboardData }} props */
export function DistributorPanel({ data }) {
  const { held, incoming } = lotsOf(data);
  return (
    <section className="stack-small" aria-labelledby="distributor-panel-title">
      <h2 id="distributor-panel-title">Distributor</h2>
      <LotCard
        id="distributor-incoming-title"
        title="Incoming hand-offs"
        emptyText="No hand-off is waiting for this account."
        lots={incoming}
        data={data}
        role="DISTRIBUTOR"
      />
      <LotCard
        id="distributor-lots-title"
        title="Lots I hold"
        emptyText="This account holds no lot."
        lots={held}
        data={data}
        role="DISTRIBUTOR"
      />
    </section>
  );
}

/** @param {{ data: import("./LotRow.jsx").DashboardData }} props */
export function PharmacyPanel({ data }) {
  const { held, incoming } = lotsOf(data);
  return (
    <section className="stack-small" aria-labelledby="pharmacy-panel-title">
      <h2 id="pharmacy-panel-title">Pharmacy</h2>
      <LotCard
        id="pharmacy-incoming-title"
        title="Incoming hand-offs"
        emptyText="No hand-off is waiting for this account."
        lots={incoming}
        data={data}
        role="RETAILER"
      />
      <LotCard id="pharmacy-lots-title" title="Lots I hold" emptyText="This account holds no lot." lots={held} data={data} role="RETAILER" />
    </section>
  );
}

/** How the oracle program is run, from the oracle/ folder (see oracle/README.md for every option). */
const ORACLE_STEPS = [
  { text: "Check that it reaches the chain and holds the oracle role:", command: "cd oracle && npm run oracle:check" },
  { text: "Watch every active lot and anchor its sensor logs until stopped with Ctrl+C:", command: "npm run oracle" },
  { text: "Or anchor one normal log for one lot now (here lot 1):", command: "npm run oracle:once -- --lot 1" },
  { text: "Or report a temperature excursion for that lot:", command: "npm run oracle:once -- --lot 1 --scenario excursion" },
];

/**
 * The oracle has no dashboard: it is a script. The panel says where it is and how to run it.
 */
export function OraclePanel() {
  return (
    <section className="stack-small" aria-labelledby="oracle-panel-title">
      <h2 id="oracle-panel-title">IoT oracle</h2>
      <div className="card">
        <p>
          The oracle is not operated from this page. It is the Node.js program in the <code>oracle/</code> folder: it takes
          (simulated) temperature readings, uploads each sensor log, anchors it with <code>anchorSensorLog</code>, and calls{" "}
          <code>reportExcursion</code> when several readings in a row are out of range.
        </p>
        <CommandSteps steps={ORACLE_STEPS} />
        <p className="small muted">
          Options and scenarios are described in <code>oracle/README.md</code>. The verify page of a lot shows new logs and an
          excursion within a few seconds.
        </p>
      </div>
    </section>
  );
}
