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
  // === WORKER: brute-force nonce using native keccak256 ===
  const keccak256 = require("keccak");
  const { challenge, difficulty, startNonce } = workerData;
  let nonce = BigInt(startNonce);
  let count = 0;
  let lastReport = Date.now();

  // Pre-compute difficulty as 32-byte big-endian buffer for fast comparison
  const diffHex = BigInt(difficulty).toString(16).padStart(64, "0");
  const diffBytes = Buffer.from(diffHex, "hex");

  // Pre-allocate fixed buffer: 32 bytes challenge + 32 bytes nonce
  const input = Buffer.alloc(64);
  Buffer.from(challenge.slice(2), "hex").copy(input, 0);

  // Write nonce as big-endian uint256 into input[32..63]
  function writeNonce(n) {
    let val = n;
    for (let i = 63; i >= 32; i--) {
      input[i] = Number(val & 0xffn);
      val >>= 8n;
    }
  }

  // Compare hash < difficulty using buffer bytes (big-endian)
  function hashLessThanDiff(hash) {
    for (let i = 0; i < 32; i++) {
      if (hash[i] < diffBytes[i]) return true;
      if (hash[i] > diffBytes[i]) return false;
    }
    return false;
  }

  // Increment nonce directly in buffer (big-endian)
  function incrementNonce() {
    for (let i = 63; i >= 32; i--) {
      input[i]++;
      if (input[i] !== 0) break;
    }
  }

  // Write initial nonce
  writeNonce(nonce);

  while (true) {
    const hash = keccak256("keccak256").update(input).digest();

    if (hashLessThanDiff(hash)) {
      parentPort.postMessage({ found: true, nonce: nonce.toString(), hash: "0x" + hash.toString("hex") });
      break;
    }
    nonce++;
    incrementNonce();
    count++;

    if (count % 100000 === 0) {
      const now = Date.now();
      const elapsed = (now - lastReport) / 1000;
      parentPort.postMessage({ hashrate: Math.round(100000 / elapsed) });
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
    console.log("CPU Cores:", os.cpus().length);

    while (true) {
      const state = await contract.miningState();
      const difficulty = BigInt(state.difficulty.toString());
      const challenge = await contract.getChallenge(wallet.address);

      console.log(`\nEra: ${state.era} | Reward: ${ethers.formatUnits(state.reward, 18)} HASH | Difficulty: ${difficulty} | Epoch: ${state.epoch}`);
      console.log("Challenge:", challenge);
      console.log("Mining with", NUM_WORKERS, "threads...");

      // Estimate time (will update after first hashrate report)
      const maxHash = 2n ** 256n;
      const prob = Number(difficulty) / Number(maxHash);
      const estHashrate = NUM_WORKERS * 80000; // rough estimate per worker
      const estHours = (1 / (prob * estHashrate) / 3600).toFixed(2);
      console.log(`Estimated time: ~${estHours} hours (will refine with actual hashrate)`);

      const startTime = Date.now();
      const nonce = await findNonce(challenge, difficulty.toString());
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`FOUND nonce: ${nonce.nonce} (${elapsed}s)`);
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
        const maxHash = 2n ** 256n;
        const prob = Number(BigInt(difficulty)) / Number(maxHash);
        const eta = total > 0 ? (1 / (prob * total) / 3600).toFixed(1) : "?";
        process.stdout.write(`\r⛏️  Hashrate: ${(total / 1000).toFixed(1)} KH/s | Workers: ${NUM_WORKERS}/${os.cpus().length} cores | ETA: ~${eta}h   `);
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
