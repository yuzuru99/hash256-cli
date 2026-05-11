require("dotenv").config();
const { ethers } = require("ethers");
const { fork } = require("child_process");
const path = require("path");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const PAUSE_DURATION = parseInt(process.env.PAUSE_SECONDS || "30") * 1000;
const MINE_METHOD_ID = "0x4d474898"; // mine(uint256) selector

if (!RPC_URL || !PRIVATE_KEY) {
  console.error("Isi RPC_URL dan PRIVATE_KEY di file .env dulu.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
let minerProcess = null;
let paused = false;

function startMiner() {
  if (minerProcess) return;
  console.log(`[${ts()}] 🟢 Starting miner...`);
  minerProcess = fork(path.join(__dirname, "miner.js"), { stdio: "inherit" });
  minerProcess.on("exit", () => { minerProcess = null; });
}

function stopMiner() {
  if (!minerProcess) return;
  console.log(`[${ts()}] 🔴 Stopping miner...`);
  minerProcess.kill();
  minerProcess = null;
}

function ts() {
  return new Date().toLocaleTimeString();
}

async function checkBlock(blockNumber) {
  const block = await provider.getBlock(blockNumber, true);
  if (!block || !block.prefetchedTransactions) return;

  for (const tx of block.prefetchedTransactions) {
    if (tx.to && tx.to.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() && tx.data.startsWith(MINE_METHOD_ID)) {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt) continue;

      if (receipt.status === 1) {
        console.log(`[${ts()}] ✅ Successful mine tx: ${tx.hash} (from ${tx.from})`);
        if (paused) {
          paused = false;
          startMiner();
        }
      } else {
        console.log(`[${ts()}] ❌ Failed mine tx: ${tx.hash} (from ${tx.from})`);
        paused = true;
        stopMiner();
        console.log(`[${ts()}] ⏸️  Pausing for ${PAUSE_DURATION / 1000}s...`);
        setTimeout(() => {
          if (paused) {
            paused = false;
            console.log(`[${ts()}] ▶️  Resuming after pause...`);
            startMiner();
          }
        }, PAUSE_DURATION);
      }
    }
  }
}

async function main() {
  console.log(`[${ts()}] 👀 Monitoring contract: ${CONTRACT_ADDRESS}`);
  console.log(`[${ts()}] Pause duration on fail: ${PAUSE_DURATION / 1000}s`);

  // Check latest block first to decide initial state
  const latestBlock = await provider.getBlockNumber();
  console.log(`[${ts()}] Latest block: ${latestBlock}`);

  // Start miner immediately (optimistic)
  startMiner();

  // Listen for new blocks
  provider.on("block", async (blockNumber) => {
    try {
      await checkBlock(blockNumber);
    } catch (err) {
      console.error(`[${ts()}] Error checking block ${blockNumber}:`, err.message);
    }
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
