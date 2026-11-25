// Hardhat 3 configuration for ProvenanceRegistry.
//
// Networks:
//   default    in-process simulated chain (chainId 31337). Used by `npm test`.
//   localhost  `npm run node` in another terminal (chainId 31337). This is the
//              demo fallback from the contingency plan.
//   amoy       Polygon Amoy testnet (chainId 80002). Needs AMOY_RPC_URL and
//              DEPLOYER_PRIVATE_KEY.
//   amoyVerify the same chain and RPC URL with no accounts, used only by
//              `npm run verify:amoy`. Verification signs nothing, but Hardhat
//              resolves a network's accounts on its first RPC request, so
//              going through `amoy` would demand DEPLOYER_PRIVATE_KEY from
//              anyone who verifies. This network needs only AMOY_RPC_URL.
//
// Secrets: configVariable() reads values lazily, only when a task actually
// uses that network. So `npm test` works on a fresh clone with no .env. For
// Amoy, either put the values in .env (names in the Configuration section of
// README.md) or store them in Hardhat's encrypted keystore:
//   npx hardhat keystore set DEPLOYER_PRIVATE_KEY
// Environment variables take precedence over the keystore, even when empty.
// If you use the keystore, keep DEPLOYER_PRIVATE_KEY out of .env and your shell.
//
// Source verification (hardhat-verify, part of the toolbox) publishes the
// Solidity source on the Amoy block explorer, so anyone can read the code
// behind the registry's address:
//   npm run verify:amoy -- <registry address> <regulator address>
// It needs ETHERSCAN_API_KEY in addition to AMOY_RPC_URL, and no private key
// (it runs on the amoyVerify network). `npm run deploy:amoy` prints the
// command with both addresses filled in. See the `verify` section below for
// why the command names a build profile.
import "dotenv/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],

  solidity: {
    version: "0.8.34", // Solidity 0.8.x per the proposal; OpenZeppelin 5.x needs >= 0.8.20
    settings: {
      // solc 0.8.34 targets the newest EVM ("osaka") by default. Pin "cancun"
      // so the bytecode only uses opcodes that Polygon PoS / Amoy supports.
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    amoy: {
      type: "http",
      chainType: "l1",
      chainId: 80002,
      url: configVariable("AMOY_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    amoyVerify: {
      type: "http",
      chainType: "l1",
      chainId: 80002,
      url: configVariable("AMOY_RPC_URL"),
      accounts: [], // read-only: see the header
    },
  },

  // Source verification with hardhat-verify.
  //
  // Explorer: Hardhat's built-in chain list already maps chainId 80002 to
  // PolygonScan (https://amoy.polygonscan.com), so no chain descriptor is
  // needed here. PolygonScan is served by the Etherscan v2 API, where one key
  // from an account at https://etherscan.io works for every supported chain.
  // The key is a configVariable like the secrets above: it is only read when
  // a verify task runs, and it can live in .env or in the Hardhat keystore.
  //
  // Build profile: the verify task rebuilds the compiler input with the
  // "production" build profile unless told otherwise. This file defines a
  // single compiler configuration, which Hardhat uses as the "default"
  // profile; the "production" profile it derives from it copies only the
  // compiler version, not the settings, so it would drop the evmVersion pin
  // above. scripts/deploy.js deploys what the "default" profile compiled.
  // `npm run verify:amoy` therefore passes --build-profile default, which
  // makes the explorer recompile exactly the deployed bytecode, including its
  // metadata hash. Without the flag the explorer would be sent settings that
  // differ from the deployed contract's.
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
