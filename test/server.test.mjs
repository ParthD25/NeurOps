import test from "node:test";
import assert from "node:assert/strict";

import { createServer, resetServerState } from "../server.mjs";

let server;
let base;

test.before(async () => {
  resetServerState();
  delete process.env.OPENROUTER_API_KEY;
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, options) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, text, json };
}

test("health reports measured weights and no key leakage", async () => {
  const { response, json } = await call("/api/health");
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.weights, { sit: 1, late: 5 });
  assert.equal(json.scenarios, 9);
  assert.ok(!("key" in json));
});

test("scenarios endpoint lists every shift and five policies", async () => {
  const { response, json } = await call("/api/scenarios");
  assert.equal(response.status, 200);
  assert.equal(json.scenarios.length, 9);
  assert.equal(json.policies.length, 5);
  assert.ok(json.scenarios.some((scenario) => scenario.id === "chaos"));
});

test("run returns a full replay for the requested policy", async () => {
  const { response, json } = await call("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "rush", policy: "adaptive", seed: 11 }),
  });
  assert.equal(response.status, 200);
  assert.equal(json.policyId, "adaptive");
  assert.equal(json.seed ?? 11, 11);
  assert.ok(json.tickets.length > 0);
  assert.ok(json.tickets[0].items[0].name, "item names are joined for the tablet");
  assert.ok(json.events.length > 0);
});

test("bad scenario, policy and seed are rejected with 400", async () => {
  const badScenario = await call("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "nope" }),
  });
  assert.equal(badScenario.response.status, 400);
  assert.match(badScenario.json.error, /unknown scenario/);

  const badPolicy = await call("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "rush", policy: "magic" }),
  });
  assert.equal(badPolicy.response.status, 400);

  const badSeed = await call("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "rush", seed: -4 }),
  });
  assert.equal(badSeed.response.status, 400);
});

test("a body over the limit returns 413, not a crash", async () => {
  const huge = JSON.stringify({ scenarioId: "rush", filler: "x".repeat(40 * 1024) });
  const { response } = await call("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: huge,
  });
  assert.equal(response.status, 413);
});

test("brief falls back to measured text without a key", async () => {
  const { response, json } = await call("/api/brief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "rush", policy: "adaptive", seed: 7 }),
  });
  assert.equal(response.status, 200);
  assert.equal(json.source, "deterministic");
  assert.match(json.text, /on time/);
  assert.equal(json.guard.ok, true);
});

test("an LLM brief that invents a number is rejected", async () => {
  const guardedServer = createServer({
    llmFetch: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "We saved $999.00 tonight." } }] }),
    }),
  });
  await new Promise((resolve) => guardedServer.listen(0, "127.0.0.1", resolve));
  const guardedBase = `http://127.0.0.1:${guardedServer.address().port}`;
  try {
    const response = await fetch(`${guardedBase}/api/brief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "rush", policy: "adaptive", seed: 7, apiKey: "test-key" }),
    });
    const json = await response.json();
    assert.equal(json.source, "deterministic");
    assert.equal(json.guard.ok, false);
    assert.match(json.note, /rejected/);
  } finally {
    await new Promise((resolve) => guardedServer.close(resolve));
  }
});

test("overrides require a real reason and are audited", async () => {
  const invalid = await call("/api/override", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId: "T-001", action: "approve", reason: "ok" }),
  });
  assert.equal(invalid.response.status, 400);

  const valid = await call("/api/override", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId: "T-001", action: "hold", reason: "courier at the wrong door" }),
  });
  assert.equal(valid.response.status, 201);
  assert.equal(valid.json.entry.action, "hold");

  const audit = await call("/api/audit");
  assert.equal(audit.response.status, 200);
  assert.ok(audit.json.entries.some((entry) => entry.reason.includes("wrong door")));
});

test("static files are served and traversal is refused", async () => {
  const index = await call("/");
  assert.equal(index.response.status, 200);
  assert.match(index.text, /Fireline/);
  assert.match(index.text, /landing\.css/, "the front door is the landing page");
  const app = await call("/app");
  assert.equal(app.response.status, 200);
  assert.match(app.text, /id="run-form"/, "the app lives at /app");

  const traversal = await call("/%2e%2e/package.json");
  assert.equal(traversal.response.status, 404);

  const missing = await call("/api/nope");
  assert.equal(missing.response.status, 404);
});
