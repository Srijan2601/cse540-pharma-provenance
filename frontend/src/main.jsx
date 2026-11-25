/**
 * Entry point: mounts the React app and loads the style sheets.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.jsx";

import "./styles/base.css";
import "./styles/components.css";
import "./styles/verify.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
