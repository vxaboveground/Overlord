import { createHash, randomBytes, createCipheriv } from "crypto";
import { authenticateRequest } from "../../auth";
import { getConfig } from "../../config";
import { logger } from "../../logger";

let _solana: typeof import("@solana/web3.js") | null = null;
async function getSolana() {
  if (!_solana) {
    _solana = await import("@solana/web3.js");
  }
  return _solana;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

const DEFAULT_RPC_ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-mainnet.gateway.tatum.io",
  "https://go.getblock.us/86aac42ad4484f3c813079afc201451c",
  "https://solana-rpc.publicnode.com",
  "https://api.blockeden.xyz/solana/KeCh6p22EX5AeRHxMSmc",
  "https://solana.drpc.org",
  "https://solana.leorpc.com/?api_key=FREE",
  "https://solana.api.onfinality.io/public",
  "https://solana.api.pocket.network/",
  "https://api.devnet.solana.com",
];

function encryptServerUrl(serverUrl: string, agentToken: string): string {
  const keyHash = createHash("sha256").update(agentToken).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyHash, nonce);
  const encrypted = Buffer.concat([cipher.update(serverUrl, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString("base64");
}

export async function handleSolRoutes(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/sol")) {
    return null;
  }

  try {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    if (req.method === "POST" && url.pathname === "/api/sol/preview") {
      const body = await req.json();
      const { serverUrl } = body;

      if (!serverUrl || typeof serverUrl !== "string" || !serverUrl.trim()) {
        return Response.json({ error: "serverUrl is required" }, { status: 400 });
      }

      const config = getConfig();
      const agentToken = config.auth.agentToken;
      if (!agentToken) {
        return Response.json({ error: "No agent token configured on this server" }, { status: 400 });
      }

      const memo = encryptServerUrl(serverUrl.trim(), agentToken);
      return Response.json({ memo, memoLength: memo.length });
    }

    if (req.method === "POST" && url.pathname === "/api/sol/publish") {
      const body = await req.json();
      const { privateKeyBase58, serverUrl, rpcUrl } = body;

      if (!serverUrl || typeof serverUrl !== "string" || !serverUrl.trim()) {
        return Response.json({ error: "serverUrl is required" }, { status: 400 });
      }
      if (!privateKeyBase58 || typeof privateKeyBase58 !== "string" || !privateKeyBase58.trim()) {
        return Response.json({ error: "privateKeyBase58 is required" }, { status: 400 });
      }

      const config = getConfig();
      const agentToken = config.auth.agentToken;
      if (!agentToken) {
        return Response.json({ error: "No agent token configured on this server" }, { status: 400 });
      }

      let keypair: InstanceType<Awaited<ReturnType<typeof getSolana>>["Keypair"]>;
      try {
        const { Keypair: SolKeypair } = await getSolana();
        const decoded = decodeBase58(privateKeyBase58.trim());
        keypair = SolKeypair.fromSecretKey(decoded);
      } catch {
        return Response.json({ error: "Invalid Solana private key (Base58)" }, { status: 400 });
      }

      const endpoint = typeof rpcUrl === "string" && rpcUrl.trim()
        ? rpcUrl.trim()
        : "https://api.mainnet-beta.solana.com";

      try {
        new URL(endpoint);
      } catch {
        return Response.json({ error: "Invalid RPC URL" }, { status: 400 });
      }

      const memo = encryptServerUrl(serverUrl.trim(), agentToken);

      try {
        const { Connection, Transaction, TransactionInstruction, PublicKey } = await getSolana();
        const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
        const connection = new Connection(endpoint, "confirmed");

        const memoInstruction = new TransactionInstruction({
          keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }],
          programId: MEMO_PROGRAM_ID,
          data: Buffer.from(memo, "utf8"),
        });

        const transaction = new Transaction().add(memoInstruction);
        transaction.feePayer = keypair.publicKey;

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        transaction.recentBlockhash = blockhash;

        transaction.sign(keypair);

        const signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        await connection.confirmTransaction(signature, "confirmed");

        logger.info(`[sol] Published memo to Solana. Signature: ${signature}, Address: ${keypair.publicKey.toBase58()}`);

        return Response.json({
          success: true,
          signature,
          address: keypair.publicKey.toBase58(),
          memo,
          memoLength: memo.length,
          explorerUrl: endpoint.includes("devnet")
            ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
            : `https://explorer.solana.com/tx/${signature}`,
        });
      } catch (err: any) {
        logger.error(`[sol] Failed to publish memo: ${err?.message || err}`);
        return Response.json({
          error: `Transaction failed: ${err?.message || "Unknown error"}`,
        }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/sol/balance") {
      const body = await req.json();
      const { publicKeyBase58, rpcUrl } = body;

      if (!publicKeyBase58 || typeof publicKeyBase58 !== "string") {
        return Response.json({ error: "publicKeyBase58 is required" }, { status: 400 });
      }

      let pubkey: InstanceType<Awaited<ReturnType<typeof getSolana>>["PublicKey"]>;
      try {
        const { PublicKey } = await getSolana();
        pubkey = new PublicKey(publicKeyBase58.trim());
      } catch {
        return Response.json({ error: "Invalid Solana public key" }, { status: 400 });
      }

      const endpoint = typeof rpcUrl === "string" && rpcUrl.trim()
        ? rpcUrl.trim()
        : "https://api.mainnet-beta.solana.com";

      try {
        const { Connection, LAMPORTS_PER_SOL } = await getSolana();
        const connection = new Connection(endpoint, "confirmed");
        const balance = await connection.getBalance(pubkey);
        return Response.json({
          balance,
          balanceSol: balance / LAMPORTS_PER_SOL,
        });
      } catch (err: any) {
        return Response.json({
          error: `Failed to fetch balance: ${err?.message || "Unknown error"}`,
        }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/sol/rpc-endpoints") {
      return Response.json({ endpoints: DEFAULT_RPC_ENDPOINTS });
    }

    return null;
  } catch (err: any) {
    logger.error(`[sol] Route error: ${err?.message || err}`);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
