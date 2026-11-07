import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compare, runOne, evalMeta } from "./src/sim/eval.mjs";
import { getScenario, listScenarios, scenarioSummary } from "./src/sim/scenario.mjs";
import { menuName } from "./src/sim/menu.mjs";
import { buildBrief, buildFacts, guardNumbers, llmBrief } from "./src/brief.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const BODY_LIMIT = 32 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const runCache = new Map();
const compareCache = new Map();
const auditLog = [];
let auditSeq = 0;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (overflow) reject(new HttpError(413, "request body too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function parseScenarioId(value) {
  if (typeof value !== "string" || !value) throw new HttpError(400, "scenarioId is required");
  try {
    getScenario(value);
  } catch {
    throw new HttpError(400, `unknown scenario: ${value}`);
  }
  return value;
}

function parsePolicy(value, fallback = "adaptive") {
  const policy = value ?? fallback;
  if (!evalMeta.policies.some((entry) => entry.id === policy)) {
    throw new HttpError(400, `unknown policy: ${policy}`);
  }
  return policy;
}

function parseSeed(value) {
  if (value == null) return 7;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) {
    throw new HttpError(400, "seed must be an integer between 0 and 2147483647");
  }
  return seed;
}

function withNames(result) {
  for (const ticket of result.tickets) {
    for (const item of ticket.items) item.name = menuName(item.itemId);
  }
  return result;
}

function runCached({ scenarioId, policy, seed }) {
  const key = `${scenarioId}:${policy}:${seed}`;
  if (!runCache.has(key)) {
    if (runCache.size > 200) runCache.clear();
    runCache.set(key, withNames(runOne({ scenarioId, policyId: policy, seed })));
  }
  return runCache.get(key);
}

function compareCached({ scenarioId, seed }) {
  const key = `${scenarioId}:${seed}`;
  if (!compareCache.has(key)) {
    if (compareCache.size > 60) compareCache.clear();
    compareCache.set(key, compare({ scenarioId, seed }));
  }
  return compareCache.get(key);
}

async function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(404, "not found");
  }
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    throw new HttpError(404, "not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": "no-store",
    "content-length": data.length,
  });
  res.end(data);
}

async function handleApi(req, res, url, options) {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      name: "fireline",
      version: "1.0.0",
      llm: Boolean(process.env.OPENROUTER_API_KEY),
      scenarios: listScenarios().length,
      weights: evalMeta.weights,
    });
  }

  if (pathname === "/api/scenarios" && method === "GET") {
    return sendJson(res, 200, {
      scenarios: listScenarios(),
      policies: evalMeta.policies,
      weights: evalMeta.weights,
    });
  }

  if (pathname.startsWith("/api/scenarios/") && method === "GET") {
    const id = pathname.slice("/api/scenarios/".length);
    parseScenarioId(id);
    return sendJson(res, 200, scenarioSummary(getScenario(id)));
  }

  if (pathname === "/api/run" && method === "POST") {
    const body = await readJson(req);
    const scenarioId = parseScenarioId(body.scenarioId);
    const policy = parsePolicy(body.policy);
    const seed = parseSeed(body.seed);
    return sendJson(res, 200, runCached({ scenarioId, policy, seed }));
  }

  if (pathname === "/api/compare" && method === "POST") {
    const body = await readJson(req);
    const scenarioId = parseScenarioId(body.scenarioId);
    const seed = parseSeed(body.seed);
    return sendJson(res, 200, compareCached({ scenarioId, seed }));
  }

  if (pathname === "/api/brief" && method === "POST") {
    const body = await readJson(req);
    const scenarioId = parseScenarioId(body.scenarioId);
    const policy = parsePolicy(body.policy);
    const seed = parseSeed(body.seed);
    const result = runCached({ scenarioId, policy, seed });
    const comparison = compareCached({ scenarioId, seed });
    const facts = buildFacts({ result, comparison });
    const deterministic = buildBrief({ result, comparison });

    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
      ? body.apiKey.trim()
      : process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return sendJson(res, 200, {
        source: "deterministic",
        text: deterministic,
        guard: { ok: true, unknown: [] },
        facts,
        note: "No model key supplied. The brief is generated from measured metrics.",
      });
    }

    const model = typeof body.model === "string" && body.model ? body.model : "openai/gpt-4o-mini";
    const llm = await llmBrief({ facts, apiKey, model, fetchImpl: options.llmFetch ?? globalThis.fetch });
    if (!llm.ok) {
      return sendJson(res, 200, {
        source: "deterministic",
        text: deterministic,
        guard: { ok: true, unknown: [] },
        facts,
        note: `Model unavailable (${llm.error}). Fell back to measured text.`,
      });
    }
    const guard = guardNumbers(llm.text, facts);
    if (!guard.ok) {
      return sendJson(res, 200, {
        source: "deterministic",
        text: deterministic,
        guard,
        facts,
        note: "Model text contained a figure that is not in the measured facts, so it was rejected.",
      });
    }
    return sendJson(res, 200, { source: "llm", text: llm.text, guard, facts, note: null });
  }

  if (pathname === "/api/override" && method === "POST") {
    const body = await readJson(req);
    const action = body.action;
    if (!["approve", "hold", "escalate"].includes(action)) {
      throw new HttpError(400, "action must be approve, hold or escalate");
    }
    if (typeof body.ticketId !== "string" || !body.ticketId) {
      throw new HttpError(400, "ticketId is required");
    }
    if (typeof body.reason !== "string" || body.reason.trim().length < 3) {
      throw new HttpError(400, "a reason of at least 3 characters is required");
    }
    auditSeq += 1;
    const entry = {
      id: `A-${auditSeq}`,
      at: new Date().toISOString(),
      ticketId: body.ticketId.slice(0, 40),
      action,
      reason: body.reason.trim().slice(0, 280),
      actor: "operator",
    };
    auditLog.push(entry);
    return sendJson(res, 201, { entry, entries: auditLog.length });
  }

  if (pathname === "/api/audit" && method === "GET") {
    return sendJson(res, 200, { entries: auditLog.slice(-50) });
  }

  throw new HttpError(404, "not found");
}

export function createServer(options = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, options);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "method not allowed");
      }
      await serveStatic(res, url.pathname);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(res, status, {
        ok: false,
        error: error instanceof HttpError ? error.message : "internal error",
      });
    }
  });
}

export function resetServerState() {
  runCache.clear();
  compareCache.clear();
  auditLog.length = 0;
  auditSeq = 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`fireline listening on http://0.0.0.0:${port}`);
    console.log(`model key present: ${Boolean(process.env.OPENROUTER_API_KEY)}`);
  });
}
