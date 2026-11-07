import test from "node:test";
import assert from "node:assert/strict";

import { buildBrief, buildFacts, guardNumbers, llmBrief } from "../src/brief.mjs";
import { compare, runOne } from "../src/sim/eval.mjs";

function fixture() {
  const result = runOne({ scenarioId: "rush", policyId: "adaptive", seed: 7 });
  const comparison = compare({ scenarioId: "rush", seed: 7 });
  return { result, comparison };
}

test("the deterministic brief uses only measured facts", () => {
  const { result, comparison } = fixture();
  const facts = buildFacts({ result, comparison });
  const text = buildBrief({ result, comparison });
  assert.match(text, /tickets handed off/);
  assert.match(text, /on time/);
  assert.deepEqual(guardNumbers(text, facts).unknown, []);
});

test("the number guard rejects an invented dollar figure", () => {
  const { result, comparison } = fixture();
  const facts = buildFacts({ result, comparison });
  const guard = guardNumbers("We recovered $1,299.00 on this shift.", { ...facts, onTimePct: 41.4 });
  assert.equal(guard.ok, false);
  assert.ok(guard.unknown.includes("1,299.00") || guard.unknown.includes("1299.00") || guard.unknown.length > 0);
});

test("the number guard accepts facts that appear in the metrics", () => {
  const { result, comparison } = fixture();
  const facts = buildFacts({ result, comparison });
  const guard = guardNumbers(`${facts.onTimePct}% on time, ${facts.avgLateSec} seconds late.`, facts);
  assert.equal(guard.ok, true, `unexpected unknown numbers: ${guard.unknown.join(", ")}`);
});

test("llmBrief returns the model text when the request succeeds", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "Calm service. One ticket sat." } }] }),
  });
  const response = await llmBrief({ facts: { tickets: 4 }, apiKey: "test", fetchImpl: fakeFetch });
  assert.equal(response.ok, true);
  assert.match(response.text, /Calm service/);
});

test("llmBrief reports transport failures instead of throwing", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const response = await llmBrief({ facts: {}, apiKey: "test", fetchImpl: fakeFetch });
  assert.equal(response.ok, false);
  assert.match(response.error, /429/);
});
