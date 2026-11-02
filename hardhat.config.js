// Hardhat 3 configuration for ProvenanceRegistry.
//
// Networks:
//   default    in-process simulated chain (chainId 31337). Used by `npm test`.
//   localhost  `npm run node` in another terminal (chainId 31337). This is the
//              demo fallback from the contingency plan.
//   amoy       Polygon Amoy testnet (chainId 80002). Needs AMOY_RPC_URL and
//              DEPLOYER_PRIVATE_KEY.
//
// Secrets: configVariable() reads values lazily, only when a task actually
// uses that network. So `npm test` works on a fresh clone with no .env. For
// Amoy, either put the values in .env (see .env.example) or store them in
// Hardhat's encrypted keystore:
//   npx hardhat keystore set DEPLOYER_PRIVATE_KEY
// Environment variables take precedence over the keystore, even when empty.
// If you use the keystore, keep DEPLOYER_PRIVATE_KEY out of .env and your shell.
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
  },
});
