// Short-lived public links to a file, for hosted models that only take an https URL (OpenRouter's video edits).
// The studio itself is never exposed: a second HTTP server on 127.0.0.1 answers only GET/HEAD /s/<random token>,
// and a Cloudflare quick tunnel (cloudflared, no account) points at it. The tunnel starts with the first share and
// stops once no share has been live for a while; each share is dropped when its job ends or its time is up.
//   CLOUDFLARED   path to cloudflared(.exe); otherwise "cloudflared" on PATH
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { Resolver } from "node:dns";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

type Share = { bytes: Uint8Array; type: string; until: number };

const shares = new Map<string, Share>();
let fileServer: Server | null = null;
let filePort = 0;
let tunnel: { proc: ChildProcess; url: Promise<string> } | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const IDLE_MS = 10 * 60_000;

function sweep() {
  const now = Date.now();
  for (const [token, s] of shares) if (s.until < now) shares.delete(token);
}

async function startFileServer(): Promise<number> {
  if (fileServer) return filePort;
  const srv = createServer((req, res) => {
    sweep();
    const m = /^\/s\/([A-Za-z0-9_-]{20,})(?:\.[a-z0-9]+)?$/.exec(req.url ?? "");
    const s = m ? shares.get(m[1]) : undefined;
    if (!s || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const size = s.bytes.byteLength;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    let start = 0, end = size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      status = 206;
    }
    const headers: Record<string, string | number> = {
      "content-type": s.type, "content-length": end - start + 1, "accept-ranges": "bytes", "cache-control": "no-store",
    };
    if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : Buffer.from(s.bytes.buffer, s.bytes.byteOffset + start, end - start + 1));
  });
  await new Promise<void>((ok, fail) => { srv.once("error", fail); srv.listen(0, "127.0.0.1", () => ok()); });
  fileServer = srv;
  filePort = (srv.address() as AddressInfo).port;
  return filePort;
}

function startTunnel(port: number) {
  const bin = process.env.CLOUDFLARED || "cloudflared";
  const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const url = new Promise<string>((ok, fail) => {
    let log = "";
    const timer = setTimeout(() => fail(new Error(`cloudflared gave no public address within 60 s: ${log.slice(-300)}`)), 60_000);
    const read = (chunk: Buffer) => {
      log += chunk.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (m) { clearTimeout(timer); ok(m[0]); }
    };
    proc.stdout?.on("data", read);
    proc.stderr?.on("data", read);
    proc.once("error", (e) => { clearTimeout(timer); fail(new Error(`cannot start cloudflared (${bin}): ${e.message}. Set CLOUDFLARED to its path`)); });
    proc.once("exit", (code) => { clearTimeout(timer); fail(new Error(`cloudflared stopped (${code}): ${log.slice(-300)}`)); });
  });
  proc.once("exit", () => { if (tunnel?.proc === proc) tunnel = null; });
  url.catch(() => { if (tunnel?.proc === proc) { tunnel = null; proc.kill(); } });
  return { proc, url };
}

function stopTunnel() {
  tunnel?.proc.kill();
  tunnel = null;
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    sweep();
    if (shares.size) return armIdle();
    stopTunnel();
  }, IDLE_MS);
  idleTimer.unref?.();
}

// Cloudflare's resolver, asked directly: a fresh quick-tunnel name does not resolve for its first few seconds, and the
// system resolver (Windows above all) would cache that "no such name" for minutes
const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "1.0.0.1"]);
type LookupCb = (e: Error | null, addr: string | { address: string; family: number }[], family?: number) => void;
const lookupViaCloudflare = ((host: string, opts: { all?: boolean }, cb: LookupCb) => {
  resolver.resolve4(host, (e, addrs) => {
    if (e) return cb(e, opts?.all ? [] : "", 4);
    return opts?.all ? cb(null, addrs.map((address) => ({ address, family: 4 }))) : cb(null, addrs[0], 4);
  });
}) as unknown as typeof import("node:dns").lookup;

function head(url: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = httpsRequest(url, { method: "HEAD", lookup: lookupViaCloudflare, timeout: 8000 }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", fail);
    req.end();
  });
}

/** Wait until the new public address answers through the tunnel (a fresh quick tunnel takes a few seconds). */
async function reachable(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const status = await head(url);
      if (status >= 200 && status < 300) return;
      last = `answered ${status}`;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(`the public link did not open within a minute (${last})`);
}

export type Shared = { url: string; release: () => void };

/** Make the bytes reachable at a random https URL for ttlMs (2 h by default). release() ends it sooner. */
export async function shareFile(bytes: Uint8Array, type: string, ext: string, ttlMs = 2 * 3600_000): Promise<Shared> {
  sweep();
  const token = randomBytes(24).toString("base64url");
  shares.set(token, { bytes, type, until: Date.now() + ttlMs });
  try {
    const port = await startFileServer();
    tunnel ??= startTunnel(port);
    const base = await tunnel.url;
    const url = `${base}/s/${token}.${ext.replace(/[^a-z0-9]/gi, "") || "bin"}`;
    await reachable(url);
    armIdle();
    return { url, release: () => { shares.delete(token); armIdle(); } };
  } catch (e) {
    shares.delete(token);
    throw e;
  }
}

/** Stop the tunnel and the file server (tests, shutdown). */
export function closeShares() {
  shares.clear();
  stopTunnel();
  fileServer?.close();
  fileServer = null;
  if (idleTimer) clearTimeout(idleTimer);
}

process.once("exit", stopTunnel);
// Ctrl+C: take the tunnel down with the server (a listener replaces the default exit, so exit here)
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { stopTunnel(); process.exit(130); });
