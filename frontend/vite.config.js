/**
 * Vite configuration of the web dApp (also read by Vitest).
 *
 * The app deliberately reuses code and data that live outside this folder
 * instead of copying them, so that the browser, the oracle and the contract
 * tests can never disagree about a document format or the contract interface:
 *
 *   @oracle       ../oracle/src     browser-safe modules: encryption envelope, CID and content
 *                                   hash, upload-service client, document validator and builders
 *   @schemas      ../docs/schemas   the JSON Schemas of the three off-chain documents
 *   @deployments  ../deployments    the contract ABI and the per-network deployment records
 */
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fromRepo = (relativePath) => fileURLToPath(new URL(`../${relativePath}`, import.meta.url));

/**
 * Makes the dev server notice a deployment record that appears while it is running.
 *
 * The app finds deployments/<network>.json with import.meta.glob. Vite only watches the project
 * root for new files, and deployments/ lies outside it, so a record written by a first
 * `npm run deploy:local` would stay invisible until the dev server was restarted. With the folder
 * on the watch list, Vite sees the new file, re-evaluates the glob and reloads the open pages.
 */
const watchDeployments = {
  name: "watch-deployments",
  configureServer(server) {
    server.watcher.add(fromRepo("deployments"));
  },
};

export default defineConfig({
  plugins: [react(), watchDeployments],

  // Relative asset URLs, so the built app works from any folder of a static host.
  // Routes live in the URL hash (HashRouter), so no server-side rewrite is needed either.
  base: "./",

  resolve: {
    alias: {
      "@oracle": fromRepo("oracle/src"),
      "@schemas": fromRepo("docs/schemas"),
      "@deployments": fromRepo("deployments"),
    },
    // The shared modules in ../oracle/src import "ethers" and "ajv". Without dedupe they would be
    // looked up in oracle/node_modules, which may not be installed and would otherwise put a second
    // copy of ethers in the bundle. Dedupe resolves both from frontend/node_modules.
    dedupe: ["ethers", "ajv"],
  },

  build: {
    // One bundle of about 800 kB (260 kB gzipped), most of it ethers and the JSON Schema validator.
    // The app is served from the same laptop in the demo, so splitting it would add configuration
    // without making anything faster; the limit is raised so the build does not warn about it.
    chunkSizeWarningLimit: 1000,
  },

  server: {
    // The dev server only serves files under the project root by default; the aliases above
    // point outside it, so the repository root is allowed as well.
    fs: { allow: [repoRoot] },
  },

  test: {
    // The unit tests cover pure logic in src/lib, so no browser DOM is needed.
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
