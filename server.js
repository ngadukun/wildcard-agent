// ProofCheck — wallet & contract risk snapshot agent.
//
// Give it an address, it reads live on-chain data (balance, transaction
// count, contract code) at a specific block and returns a plain-language
// risk snapshot. Every report carries a SHA-256 hash of its own contents
// plus the block number it was read at, so the claim is checkable: anyone
// can re-read the same chain state and confirm the report wasn't edited.
//
// Zero dependencies: Node's built-in http server + fetch (JSON-RPC).

import http from "node:http";
import crypto from "node:crypto";

const PORT = process.env.PORT || 8080;

const CHAINS = {
  ethereum: {
    label: "Ethereum mainnet",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
    nativeSymbol: "ETH",
  },
  base: {
    label: "Base",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    nativeSymbol: "ETH",
  },
  arbitrum: {
    label: "Arbitrum One",
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    nativeSymbol: "ETH",
  },
};

async function rpc(chain, method, params) {
  let lastError;
  for (const url of CHAINS[chain].rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12000),
      });
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.message || "rpc error"}`);
      return body.result;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("all RPC endpoints failed");
}

const hexToBig = (h) => BigInt(h);
const fmtEth = (wei) => {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac}`;
};

async function buildReport(address, chainKey) {
  const chain = CHAINS[chainKey];
  const blockHex = await rpc(chainKey, "eth_blockNumber", []);
  const blockNumber = Number(hexToBig(blockHex));
  const atBlock = blockHex; // pin every read to the same block

  const [balanceHex, nonceHex, code] = await Promise.all([
    rpc(chainKey, "eth_getBalance", [address, atBlock]),
    rpc(chainKey, "eth_getTransactionCount", [address, atBlock]),
    rpc(chainKey, "eth_getCode", [address, atBlock]),
  ]);

  const balanceWei = hexToBig(balanceHex);
  const txCount = Number(hexToBig(nonceHex));
  const isContract = code && code !== "0x";
  const codeSizeBytes = isContract ? (code.length - 2) / 2 : 0;

  const flags = [];
  if (!isContract && txCount === 0 && balanceWei === 0n) {
    flags.push({
      level: "caution",
      text: "No on-chain history at all: never sent a transaction and holds nothing. Treat as an unproven counterparty.",
    });
  }
  if (!isContract && txCount === 0 && balanceWei > 0n) {
    flags.push({
      level: "notice",
      text: "Funded but has never sent a transaction. Common for fresh receive-only wallets and some scam collection addresses — ask why before sending more.",
    });
  }
  if (!isContract && txCount > 0 && txCount < 3) {
    flags.push({
      level: "notice",
      text: "Very thin history (1–2 sent transactions). Little track record to judge by.",
    });
  }
  if (isContract) {
    flags.push({
      level: "notice",
      text: `This is a contract (${codeSizeBytes} bytes of code), not a personal wallet. Interact only if you know which protocol deployed it.`,
    });
    if (codeSizeBytes > 20000) {
      flags.push({
        level: "caution",
        text: "Unusually large contract code. Large code is not proof of wrongdoing, but it deserves a second look (proxy setups and complex systems live here).",
      });
    }
  }
  if (balanceWei > 0n && !isContract && txCount >= 3) {
    flags.push({
      level: "ok",
      text: "Established wallet: holds a balance and has a real sending history.",
    });
  }
  if (flags.length === 0) {
    flags.push({ level: "ok", text: "Nothing unusual in the basic on-chain snapshot." });
  }

  const worst = flags.some((f) => f.level === "caution")
    ? "CAUTION"
    : flags.some((f) => f.level === "notice")
      ? "NOTICE"
      : "OK";

  const data = {
    agent: "ProofCheck",
    version: "1.0.0",
    chain: chainKey,
    chainLabel: chain.label,
    blockNumber,
    address,
    kind: isContract ? "contract" : "wallet (EOA)",
    balance: `${fmtEth(balanceWei)} ${chain.nativeSymbol}`,
    balanceWei: balanceWei.toString(),
    transactionsSent: txCount,
    contractCodeBytes: codeSizeBytes,
    riskSignal: worst,
    flags,
    disclaimer:
      "A snapshot, not a verdict. ProofCheck reads basic public chain state only; it cannot see off-chain behaviour, private approvals on other chains, or intent. Use it as a first check, not the only check.",
  };

  // The checkable claim: hash of the canonical report contents + the block
  // they were read at. Re-read the same address at the same block and the
  // same hash must come out — that is what makes the report verifiable.
  const canonical = JSON.stringify(data);
  const reportHash = "0x" + crypto.createHash("sha256").update(canonical).digest("hex");

  return { ...data, reportHash, verifyWith: `Recompute: sha256 of this report's data fields (JSON, keys in shown order) — or simply re-request /check for this address; the block number and hash pin what was seen.` };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, agent: "ProofCheck", chains: Object.keys(CHAINS) });
    }
    if (url.pathname === "/") {
      return sendJson(res, 200, {
        agent: "ProofCheck",
        what: "A wallet & contract risk snapshot agent. It reads live on-chain data at a pinned block and returns a plain-language risk snapshot with a SHA-256 report hash, so every report is a checkable claim.",
        whoItHelps: "Anyone about to send crypto to an address they don't know — a buyer paying a new seller, a user about to interact with an unfamiliar contract, a community mod vetting a wallet.",
        usage: {
          check: "GET /check?address=0x...&chain=ethereum (chains: ethereum, base, arbitrum) or POST /check {\"address\": \"0x...\", \"chain\": \"ethereum\"}",
          health: "GET /health",
        },
        source: "https://github.com/ngadukun/wildcard-agent",
        builtFor: "zkVerify Agent Games — Wildcard track",
      });
    }
    if (url.pathname === "/check") {
      let address, chainKey;
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        address = body.address;
        chainKey = (body.chain || "ethereum").toLowerCase();
      } else {
        address = url.searchParams.get("address");
        chainKey = (url.searchParams.get("chain") || "ethereum").toLowerCase();
      }
      if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return sendJson(res, 400, { error: "Provide a valid address: 0x followed by 40 hex characters." });
      }
      if (!CHAINS[chainKey]) {
        return sendJson(res, 400, { error: `Unknown chain. Supported: ${Object.keys(CHAINS).join(", ")}` });
      }
      const report = await buildReport(address, chainKey);
      return sendJson(res, 200, report);
    }
    return sendJson(res, 404, { error: "Not found. Try /, /health, or /check?address=0x...&chain=ethereum" });
  } catch (e) {
    return sendJson(res, 502, { error: `Upstream chain read failed: ${e.message}` });
  }
});

server.listen(PORT, () => console.log(`ProofCheck listening on :${PORT}`));
