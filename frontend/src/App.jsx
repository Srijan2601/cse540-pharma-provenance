/**
 * The app's routes.
 *
 *   /            home: verify box, list of lots, link to the dashboard
 *   /dashboard   organization dashboard (sign-in required to act)
 *   /verify      patient verify page, opened from a lot's QR code; read-only, no sign-in
 *
 * HashRouter keeps the route in the part of the URL after "#". The server is
 * therefore only ever asked for index.html, so the built app can be served by
 * any static host, and a QR link works without server-side rewrite rules.
 */

import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { DashboardPage } from "./pages/DashboardPage.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { VerifyPage } from "./pages/VerifyPage.jsx";
import { SessionProvider } from "./state/session.jsx";

export function App() {
  return (
    <SessionProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          {/* Any other address leads home instead of to an empty page. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </SessionProvider>
  );
}
