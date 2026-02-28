import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

let _client = null;

export function getClobClient() {
  if (_client) return _client;
  const host = process.env.CLOB_HOST || "https://clob.polymarket.com";
  const chainId = Number(process.env.CHAIN_ID || 137);
  const signer = new Wallet(process.env.PRIVATE_KEY);
  const creds = {
    key: process.env.CLOB_API_KEY,
    secret: process.env.CLOB_SECRET,
    passphrase: process.env.CLOB_PASSPHRASE,
  };
  const signatureType = Number(process.env.SIGNATURE_TYPE || 0);
  const funder = process.env.FUNDER_ADDRESS || signer.address;
  _client = new ClobClient(host, chainId, signer, creds, signatureType, funder);
  return _client;
}

export function isLiveMode() {
  return (process.env.TRADING_MODE || "paper").toLowerCase() === "live";
}

export async function getBalance() {
  const client = getClobClient();
  try {
    const bal = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    return Number(bal?.balance || 0) / 1e6;
  } catch (e) {
    console.error("[exchange] Balance fetch failed:", e?.message);
    return null;
  }
}

export async function placeBuyOrder(tokenId, price, sizeUsd) {
  const client = getClobClient();
  const size = Math.max(5, Math.floor(sizeUsd / price));

  try {
    const { OrderType } = await import("@polymarket/clob-client");
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, size, side: "BUY" },
      {},
      OrderType.GTC
    );
    return { success: true, orderId: resp?.orderID, size, price, resp };
  } catch (e) {
    return { success: false, error: e?.message || String(e), orderId: null };
  }
}

export async function placeSellOrder(tokenId, price, size) {
  const client = getClobClient();
  try {
    const { OrderType } = await import("@polymarket/clob-client");
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, size, side: "SELL" },
      {},
      OrderType.GTC
    );
    return { success: true, orderId: resp?.orderID, resp };
  } catch (e) {
    return { success: false, error: e?.message || String(e), orderId: null };
  }
}

export async function cancelOrder(orderId) {
  const client = getClobClient();
  try {
    await client.cancelOrder(orderId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

export async function getOpenOrders() {
  const client = getClobClient();
  try {
    return await client.getOpenOrders();
  } catch (e) {
    console.error("[exchange] getOpenOrders failed:", e?.message);
    return [];
  }
}
