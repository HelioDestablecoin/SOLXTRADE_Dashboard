import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { PublicKey, Connection } from "@solana/web3.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const JUPITER_BASE = "https://api.jup.ag/swap/v2";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const connection = new Connection(RPC_URL, "confirmed");

app.disable("x-powered-by");
app.set("trust proxy", Number(process.env.TRUST_PROXY || 0));
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
app.use(express.json({ limit: "96kb", strict: true }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: "draft-7", legacyHeaders: false }));

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const validPubkey = value => {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
};
const jupiterHeaders = () => JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
const fetchJson = async (url, options={}, timeout=15_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { accept:"application/json", ...options.headers } });
    const body = await response.text();
    let data; try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body.slice(0,500) }; }
    if (!response.ok) {
      const message = data.error || data.message || data.errorMessage || `Upstream HTTP ${response.status}`;
      const err = new Error(String(message)); err.status = response.status >= 500 ? 502 : response.status; throw err;
    }
    return data;
  } finally { clearTimeout(timer); }
};


app.get("/api/health", async (_req, res) => {
  let rpcOk = false;
  let rpcVersion = null;
  let rpcError = null;

  try {
    const version = await connection.getVersion();
    rpcOk = true;
    rpcVersion = version["solana-core"] || null;
  } catch (error) {
    rpcError = error.message;
  }

  res.json({
    ok: true,
    service: "SOLXTRADE API",
    status: rpcOk ? "online" : "degraded",
    network: "Solana Mainnet",
    rpcOk,
    rpcVersion,
    rpcError,
    timestamp: new Date().toISOString()
  });
});

  

const orderQuery = z.object({
  inputMint:z.string().min(32).max(44),
  outputMint:z.string().min(32).max(44),
  amount:z.string().regex(/^[1-9]\d{0,19}$/),
  taker:z.string().min(32).max(44)
});
app.get("/api/swap/order", asyncRoute(async (req,res) => {
  const parsed = orderQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error:"Parameter swap tidak valid.", details:parsed.error.flatten() });
  const q = parsed.data;
  if (!validPubkey(q.inputMint) || !validPubkey(q.outputMint) || !validPubkey(q.taker))
    return res.status(400).json({ error:"Mint atau alamat wallet Solana tidak valid." });
  if (q.inputMint === q.outputMint) return res.status(400).json({ error:"Token input dan output tidak boleh sama." });

  const url = new URL(`${JUPITER_BASE}/order`);
  for (const [key,value] of Object.entries(q)) url.searchParams.set(key,value);
  // v0 transactions remain the broadest wallet-compatible default.
  const upstream = await fetchJson(url, { headers:jupiterHeaders() });
  if (!upstream.transaction || !upstream.requestId) {
    return res.status(422).json({ error:upstream.errorMessage || "Jupiter tidak menghasilkan transaksi untuk order ini.", upstream });
  }
  let outputDecimals = null;
  try {
    const supply = await connection.getTokenSupply(new PublicKey(q.outputMint), "confirmed");
    outputDecimals = supply.value.decimals;
  } catch {
    if (q.outputMint === "So11111111111111111111111111111111111111112") outputDecimals = 9;
  }
  // Preserve Jupiter fields expected by the existing frontend; add outputDecimals.
  res.set("Cache-Control","no-store");
  res.json({ ...upstream, outputDecimals });
}));

const executeBody = z.object({
  signedTransaction:z.string().min(100).max(20000),
  requestId:z.string().min(8).max(200),
  lastValidBlockHeight:z.number().int().positive().optional()
});
app.post("/api/swap/execute", asyncRoute(async (req,res) => {
  const parsed = executeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error:"Payload eksekusi tidak valid.", details:parsed.error.flatten() });
  const { signedTransaction, requestId } = parsed.data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransaction) || signedTransaction.length % 4 !== 0)
    return res.status(400).json({ error:"Signed transaction bukan base64 yang valid." });
  const bytes = Buffer.from(signedTransaction,"base64");
  if (!bytes.length || bytes.length > 12_000 || bytes.toString("base64") !== signedTransaction)
    return res.status(400).json({ error:"Ukuran atau encoding transaksi tidak valid." });

  // Never accept a private key or sign on behalf of the user. The wallet has already signed.
  const result = await fetchJson(`${JUPITER_BASE}/execute`, {
    method:"POST",
    headers:{ "content-type":"application/json", ...jupiterHeaders() },
    body:JSON.stringify({ signedTransaction, requestId })
  }, 30_000);
  res.set("Cache-Control","no-store");
  if (result.status !== "Success") return res.status(502).json({ ...result, error:result.error || "Jupiter gagal mengeksekusi transaksi." });
  res.json(result);
}));

// Live public market discovery via DexScreener; not fabricated/sample token data.
app.get("/api/market/search", asyncRoute(async (req,res) => {
  const q = String(req.query.q || "").trim().slice(0,100);
  if (q.length < 2) return res.status(400).json({ error:"Masukkan minimal 2 karakter untuk pencarian." });
  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  res.set("Cache-Control","public, max-age=8");
  res.json({ pairs:(data.pairs || []).filter(p => p.chainId === "solana").slice(0,50) });
}));
// Automatic Solana token/pool feed from DexScreener latest token profiles.
// This provider does not expose launchpad bonding-curve progress, so Final Stretch is not fabricated.
let feedCache = { at: 0, payload: null };
app.get("/api/feed/tokens", asyncRoute(async (_req,res) => {
  if (feedCache.payload && Date.now() - feedCache.at < 20000) {
    res.set("Cache-Control", "no-store");
    return res.json(feedCache.payload);
  }

  const profiles = await fetchJson("https://api.dexscreener.com/token-profiles/latest/v1");
  const mints = [...new Set((Array.isArray(profiles) ? profiles : [])
    .filter(p => p?.chainId === "solana" && typeof p.tokenAddress === "string")
    .map(p => p.tokenAddress))].slice(0, 30);

  if (!mints.length) {
    const payload = {
      source: "DexScreener latest token profiles",
      cluster: "mainnet-beta",
      pairs: [],
      finalStretchAvailable: false,
      updatedAt: new Date().toISOString(),
      note: "No recent Solana token profiles returned. Bonding-curve progress is not supplied by this feed."
    };
    feedCache = { at: Date.now(), payload };
    res.set("Cache-Control", "no-store");
    return res.json(payload);
  }

  const pairs = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`);
  const bestByMint = new Map();
  for (const pair of (Array.isArray(pairs) ? pairs : [])) {
    const mint = pair?.baseToken?.address;
    if (!mint) continue;
    const previous = bestByMint.get(mint);
    const liquidity = Number(pair?.liquidity?.usd || 0);
    if (!previous || liquidity > Number(previous?.liquidity?.usd || 0)) bestByMint.set(mint, pair);
  }

  const payload = {
    source: "DexScreener latest token profiles",
    cluster: "mainnet-beta",
    pairs: [...bestByMint.values()].sort((a,b) => Number(b.pairCreatedAt || 0) - Number(a.pairCreatedAt || 0)),
    finalStretchAvailable: false,
    updatedAt: new Date().toISOString(),
    note: "New/Migrated are UI heuristics from pool age and liquidity. Actual launchpad graduation/bonding-curve progress requires a launchpad event feed."
  };
  feedCache = { at: Date.now(), payload };
  res.set("Cache-Control", "no-store");
  return res.json(payload);
}));

app.get("/api/market/token/:mint", asyncRoute(async (req,res) => {
  const mint = req.params.mint;

  if (!validPubkey(mint)) {
    return res.status(400).json({
      error: "Mint address Solana tidak valid"
    });
  }

  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
  const pairs = (data.pairs || []).filter(p => p.chainId === "solana");

  res.set("Cache-Control", "public, max-age=5");
  res.json({ mint, pairs });
}));
app.use(express.static(join(__dirname, "public"), {
  extensions: ["html"]
}));
app.get("*", (req, res) => {
    res.sendFile(join(process.cwd(), "public", "index.html"));
});
app.use((err,_req,res,_next) => {
  const status = Number(err.status) || 502;
  if (process.env.NODE_ENV !== "production") console.error(err);
  res.status(status).json({ error: status >= 500 ? (err.name === "AbortError" ? "Upstream timeout." : err.message || "Layanan upstream gagal.") : err.message });
});

app.listen(PORT,HOST,() => console.log(`SOLXTRADE API listening on http://${HOST}:${PORT} (Solana Mainnet)`));
