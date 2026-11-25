/**
 * The frame around every page: header with navigation, main area, footer.
 */

import { Link, NavLink } from "react-router-dom";

import { Icon } from "./Icon.jsx";

/**
 * @param {object} props
 * @param {boolean} [props.narrow]  use the narrow column of the verify page
 * @param {import("react").ReactNode} props.children
 */
export function Layout({ narrow = false, children }) {
  return (
    <>
      <header className="site-header">
        <div className="site-header__inner">
          <Link to="/" className="site-title">
            <Icon name="check" size={22} />
            Cold-chain provenance
          </Link>
          <nav className="site-nav" aria-label="Main">
            {/* NavLink sets aria-current="page" on the link of the page being shown. */}
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/dashboard">Organization dashboard</NavLink>
          </nav>
        </div>
      </header>

      <main className={`site-main${narrow ? " site-main--narrow" : ""}`}>{children}</main>

      <footer className="site-footer">
        <div className="site-footer__inner">
          <p>CSE 540 course project: a tamper-evident record of a medicine lot's custody, temperature and certification.</p>
          <p>All products, organizations and readings shown here are synthetic demo data.</p>
        </div>
      </footer>
    </>
  );
}
