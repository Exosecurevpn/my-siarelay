import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const BASE_URL = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const EXCLUDED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

function buildHeaders(incoming) {
  const result = {};
  let clientIp = null;

  for (const [key, val] of Object.entries(incoming)) {
    const k = key.toLowerCase();
    const v = Array.isArray(val) ? val.join(", ") : val;

    if (EXCLUDED_HEADERS.has(k)) continue;
    if (k.startsWith("x-vercel-")) continue;

    if (k === "x-real-ip") { clientIp = v; continue; }
    if (k === "x-forwarded-for") { if (!clientIp) clientIp = v; continue; }

    result[k] = v;
  }

  if (clientIp) result["x-forwarded-for"] = clientIp;
  return result;
}

async function forwardRequest(req, res) {
  if (!BASE_URL) {
    res.statusCode = 500;
    return res.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  const destination = BASE_URL + req.url;
  const headers = buildHeaders(req.headers);
  const method = req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  const options = { method, headers, redirect: "manual" };
  if (hasBody) {
    options.body = Readable.toWeb(req);
    options.duplex = "half";
  }

  const response = await fetch(destination, options);

  res.statusCode = response.status;
  for (const [k, v] of response.headers) {
    if (k.toLowerCase() === "transfer-encoding") continue;
    try { res.setHeader(k, v); } catch {}
  }

  if (response.body) {
    await pipeline(Readable.fromWeb(response.body), res);
  } else {
    res.end();
  }
}

export default async function handler(req, res) {
  try {
    await forwardRequest(req, res);
  } catch (err) {
    console.error("tunnel error:", err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway: Tunnel Failed");
    }
  }
}
