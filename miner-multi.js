require("dotenv").config();
const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const NUM_WORKERS = parseInt(process.env.WORKERS || os.cpus().length);

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

if (!isMainThread) {
  // === WORKER: brute-force nonce ===
  const { challenge, difficulty, startNonce } = workerData;
  const diffBig = BigInt(difficulty);
  let nonce = BigInt(startNonce);
  let count = 0;
  let lastReport = Date.now();

  while (true) {
    const hash = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256"],
      [challenge, nonce]
    );
    if (BigInt(hash) < diffBig) {
      parentPort.postMessage({ found: true, nonce: nonce.toString(), hash });
      break;
    }
    nonce++;
    count++;

    if (count % 50000 === 0) {
      const now = Date.now();
      const elapsed = (now - lastReport) / 1000;
      parentPort.postMessage({ hashrate: Math.round(50000 / elapsed) });
      lastReport = now;
      count = 0;
    }
  }
} else {
  // === MAIN THREAD ===
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Isi RPC_URL dan PRIVATE_KEY di file .env dulu.");
    process.exit(1);
  }

  async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    console.log("Wallet:", wallet.address);
    console.log("Workers:", NUM_WORKERS);

    while (true) {
      const state = await contract.miningState();
      const difficulty = BigInt(state.difficulty.toString());
      const challenge = await contract.getChallenge(wallet.address);

      console.log(`\nEra: ${state.era} | Reward: ${ethers.formatUnits(state.reward, 18)} HASH | Difficulty: ${difficulty} | Epoch: ${state.epoch}`);
      console.log("Challenge:", challenge);
      console.log("Mining with", NUM_WORKERS, "threads...");

      const nonce = await findNonce(challenge, difficulty.toString());

      console.log("FOUND nonce:", nonce.nonce);
      console.log("Hash:", nonce.hash);

      try {
        const tx = await contract.mine(BigInt(nonce.nonce));
        console.log("TX sent:", tx.hash);
        const receipt = await tx.wait();
        console.log("✅ Success block:", receipt.blockNumber);
      } catch (err) {
        console.error("❌ TX failed:", err.shortMessage || err.message);
      }
    }
  }

  function findNonce(challenge, difficulty) {
    return new Promise((resolve) => {
      const workers = [];
      let resolved = false;
      const rates = new Array(NUM_WORKERS).fill(0);

      const rateInterval = setInterval(() => {
        const total = rates.reduce((a, b) => a + b, 0);
        process.stdout.write(`\r⛏️  Hashrate: ${(total / 1000).toFixed(1)} KH/s (${NUM_WORKERS} threads)   `);
      }, 2000);

      for (let i = 0; i < NUM_WORKERS; i++) {
        const startNonce = (BigInt(Math.floor(Math.random() * 1e15)) + BigInt(i) * BigInt(1e15)).toString();
        const w = new Worker(__filename, {
          workerData: { challenge, difficulty, startNonce }
        });

        w.on("message", (msg) => {
          if (msg.found && !resolved) {
            resolved = true;
            clearInterval(rateInterval);
            console.log("");
            resolve(msg);
            workers.forEach((wk) => wk.terminate());
          } else if (msg.hashrate) {
            rates[i] = msg.hashrate;
          }
        });

        w.on("error", (err) => console.error("Worker error:", err.message));
        workers.push(w);
      }
    });
  }

  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
