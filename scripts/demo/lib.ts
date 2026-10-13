/** Small helpers shared by the demo scripts. They talk to a RUNNING API (npm run dev) over HTTP. */
import { randomUUID } from 'node:crypto';

export const API = process.env.API_URL ?? 'http://localhost:4000';
export const DEMO_PASSWORD = 'Auctra@2026';

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export const inr = (v: string | number | null) =>
  v === null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(v));

export function heading(t: string) {
  console.log(`\n${c.bold(t)}\n${'─'.repeat(Math.min(90, t.length))}`);
}

export async function api<T = unknown>(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const t0 = performance.now();
  const res = await fetch(`${API}/api/v1${path}`, { ...init, headers });
  const ms = performance.now() - t0;
  const body = (await res.json()) as { success: boolean; data: T; error?: { code: string; message: string } };
  return { status: res.status, body, headers: res.headers, ms };
}

export async function login(who: string) {
  const r = await api<{ accessToken: string; user: { id: number; name: string } }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: `${who}@auctra.dev`, password: DEMO_PASSWORD }),
  });
  if (r.status !== 200) throw new Error(`login ${who} failed: ${JSON.stringify(r.body)} — is the API running and the database seeded?`);
  return { token: r.body.data.accessToken, ...r.body.data.user };
}

export function bid(token: string, auctionId: number, amount: string, key: string = randomUUID()) {
  return api<{ bid: { id: number; amount: string }; version: number; replayed: boolean }>(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    token,
    body: JSON.stringify({ amount, clientRequestId: key }),
  });
}

export async function demoAuction(sellerToken: string, opts: { title: string; startingPrice: string; increment: string; endsInSeconds: number; imageUrl?: string }) {
  const r = await api<{ id: number }>('/dev/demo-auction', {
    method: 'POST',
    token: sellerToken,
    body: JSON.stringify({ title: opts.title, startingPrice: opts.startingPrice, minimumBidIncrement: opts.increment, endsInSeconds: opts.endsInSeconds, imageUrl: opts.imageUrl }),
  });
  if (r.status !== 201) throw new Error(`demo auction failed (${r.status}): ${JSON.stringify(r.body)} — is ENABLE_DEV_ROUTES=true?`);
  return r.body.data.id;
}
