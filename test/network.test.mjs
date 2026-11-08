import test from "node:test";
import assert from "node:assert/strict";

import { PARAM_COUNT, PrepNet, trainShadow, samplesFromSteps } from "../src/sim/nn.mjs";
import { runOne } from "../src/sim/eval.mjs";
import { judgeProposal, parseJsonObject, ruleProposal, sanitizeProposal, tuneNetwork } from "../src/tuner.mjs";
import { simulateLifecycle } from "../src/sim/lifecycle.mjs";
import { createServer } from "../server.mjs";

const steakSamples = (count, actualSec) =>
  Array.from({ length: count }, (_, i) => ({ itemId: "steak", serviceSec: actualSec, t: 60 * (i + 1) }));

test("backpropagation matches finite differences on every parameter", () => {
  const net = new PrepNet({ seed: 3 });
  for (let p = 0; p < PARAM_COUNT; p += 1) net.theta[p] += Math.sin(p * 12.9898) * 0.3;
  const items = ["steak", "fries", "salad", "wings"];
  const targets = [1.4, 0.4, 0.5, 0.9];
  const lossAt = () => items.reduce((sum, item, k) => sum + 0.5 * (net.forward(item).y - targets[k]) ** 2, 0);
  const grad = new Float64Array(PARAM_COUNT);
  items.forEach((item, k) => {
    const cache = net.forward(item);
    net.backward(cache, cache.y - targets[k], grad);
  });
  let worst = 0;
  for (let p = 0; p < PARAM_COUNT; p += 1) {
    const keep = net.theta[p];
    net.theta[p] = keep + 1e-6;
    const up = lossAt();
    net.theta[p] = keep - 1e-6;
    const down = lossAt();
    net.theta[p] = keep;
    const numeric = (up - down) / 2e-6;
    if (Math.abs(numeric) + Math.abs(grad[p]) > 1e-9) {
      worst = Math.max(worst, Math.abs(numeric - grad[p]) / (Math.abs(numeric) + Math.abs(grad[p])));
    }
  }
  assert.ok(worst < 1e-5, `worst relative gradient error ${worst}`);
});

test("a cold network predicts the menu median, then learns this kitchen", () => {
  const net = new PrepNet({ learningRate: 0.01 });
  assert.ok(Math.abs(net.predict("steak") - 330) < 25, "starts near the menu's 330s");
  for (let i = 0; i < 300; i += 1) net.train("steak", 450);
  assert.ok(Math.abs(net.predict("steak") - 450) < 25, `learned ${Math.round(net.predict("steak"))}s`);
});

test("training reports error from before each update and records weights", () => {
  const run = trainShadow(steakSamples(5, 400));
  assert.equal(run.steps.length, 5);
  assert.equal(run.steps[0].errSec, run.steps[0].predSec - 400);
  const params = run.steps[0].params;
  assert.equal(params.inputToH1.length, 22, "one row of first-layer weights per input");
  assert.equal(params.h1ToH2.length, 8);
  assert.equal(params.h2ToOut.length, 8);
  assert.ok(params.gradNorm > 0 && Number.isFinite(params.loss));
  assert.notDeepEqual(run.steps[0].params, run.steps[4].params);
});

test("every run result carries the network trained on its finished dishes", () => {
  const result = runOne({ scenarioId: "rush", seed: 7 });
  assert.equal(result.network.mode, "shadow");
  assert.equal(result.network.steps.length, result.completedSamples);
  assert.ok(!("net" in result.network), "the live network object is not serialized");
});

test("interventions are clamped and replayed at their time", () => {
  const run = trainShadow(steakSamples(4, 330), {
    interventions: [{ atSec: 150, outputBiasSec: 9999, learningRate: 5 }],
  });
  assert.equal(run.interventions.length, 1);
  assert.equal(run.steps[2].params.lr, 0.02, "learning rate clamped to the 0.02 ceiling");
  assert.ok(run.steps[2].predSec - run.steps[1].predSec >= 80, "bias capped at +90s, not 9999s");
});

test("proposals are sanitized: unknown items dropped, values clamped, junk refused", () => {
  const { change, notes } = sanitizeProposal({
    learningRate: "0.5",
    outputBiasSec: -500,
    itemBiasSec: { steak: 20, "<script>": 10, fries: "fast" },
  });
  assert.deepEqual(change, { learningRate: 0.02, outputBiasSec: -90, itemBiasSec: { steak: 20 } });
  assert.ok(notes.some((note) => note.includes("unknown item")));
  assert.deepEqual(sanitizeProposal("delete everything").change, {});
  assert.deepEqual(parseJsonObject('Sure! {"learningRate": 0.02} hope that helps'), { learningRate: 0.02 });
  assert.equal(parseJsonObject("no json here"), null);
});

test("the judge rejects a change that raises error on held-out dishes", () => {
  const run = trainShadow(steakSamples(20, 330), { stopAtSec: Infinity });
  const harmful = judgeProposal(run, { itemBiasSec: { steak: 80 } });
  assert.equal(harmful.accepted, false);
  assert.match(harmful.verdict, /rejected/);
  const helpful = trainShadow(steakSamples(20, 330));
  helpful.net.apply({ itemBiasSec: { steak: -60 } });
  assert.equal(judgeProposal(helpful, { itemBiasSec: { steak: 60 } }).accepted, true);
});

test("the rule agent corrects an item the network keeps getting wrong", () => {
  const facts = {
    dishesSeen: 30,
    learningRate: 0.03,
    recentMaeSec: 40,
    previousMaeSec: 42,
    recentMeanErrorSec: -35,
    items: [{ itemId: "steak", name: "Steak Plate", samples: 6, meanErrorSec: -40 }],
  };
  const proposal = ruleProposal(facts);
  assert.equal(proposal.itemBiasSec.steak, 20);
  assert.match(proposal.reason, /Steak Plate/);
});

test("tuneNetwork uses the LLM when it answers, and the rule agent when it does not", async () => {
  const samples = samplesFromSteps(runOne({ scenarioId: "rush", seed: 7 }).network.steps);
  const atSec = samples[30].t + 1;
  let sentFacts = null;
  const llmFetch = async (_url, init) => {
    sentFacts = JSON.parse(init.body).messages[1].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"learningRate": 0.02, "reason": "steady"}' } }] }) };
  };
  const viaLlm = await tuneNetwork({ samples, atSec, apiKey: "test-key", model: "m", fetchImpl: llmFetch });
  assert.equal(viaLlm.decision.source, "llm");
  assert.equal(viaLlm.decision.change.learningRate, 0.02);
  assert.match(sentFacts, /recentMaeSec/);

  const broken = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "I would lower it a bit" } }] }) });
  const fallback = await tuneNetwork({ samples, atSec, apiKey: "test-key", fetchImpl: broken });
  assert.equal(fallback.decision.source, "rules");
  assert.match(fallback.note, /not a JSON object/);

  const offline = await tuneNetwork({ samples, atSec });
  assert.equal(offline.decision.source, "rules");
});

test("the tune endpoint returns the retrained network and refuses bad input", async () => {
  const server = createServer({
    llmFetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"outputBiasSec": 5, "reason": "x"}' } }] }) }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) =>
    fetch(`${base}/api/network/tune`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const ok = await post({ scenarioId: "rush", policy: "adaptive", seed: 7, atSec: 2400, interventions: [], apiKey: "k" });
    assert.equal(ok.status, 200);
    const json = await ok.json();
    assert.equal(json.decision.source, "llm");
    assert.ok(Array.isArray(json.network.steps) && json.network.steps.length > 0);
    assert.equal(json.interventions.length, json.decision.accepted ? 1 : 0);

    assert.equal((await post({ scenarioId: "rush", atSec: -5 })).status, 400);
    assert.equal((await post({ scenarioId: "rush", atSec: 10, interventions: "lots" })).status, 400);
    assert.equal((await post({ scenarioId: "rush", atSec: 10, interventions: [{ atSec: "soon" }] })).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the release cycle promotes only a challenger that beats production", () => {
  const life = simulateLifecycle({ weeks: 3, cycleDays: 7, withBaseline: false, ordersPerDay: 18 });
  assert.equal(life.days.length, 21);
  assert.equal(life.cycles.length, 3);
  assert.equal(life.releases[0].version, 1);
  for (const cycle of life.cycles) {
    if (cycle.promoted) assert.ok(cycle.challengerMaeSec < cycle.championMaeSec - life.config.marginSec);
    else assert.ok(cycle.challengerMaeSec >= cycle.championMaeSec - life.config.marginSec);
  }
  assert.equal(life.production.version, life.releases.at(-1).version);
  const steak = life.corrections.find((entry) => entry.itemId === "steak");
  if (life.production.version > 1) {
    assert.ok(Math.abs(steak.championSec - steak.kitchenSec) < Math.abs(steak.menuSec - steak.kitchenSec), "production model is closer to this kitchen than the menu");
  }
});

test("model presets are compared on the same shift, and the tune endpoint honours them", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const compare = await (await post("/api/network/presets", { scenarioId: "rush", seed: 7 })).json();
    assert.deepEqual(compare.presets.map((preset) => preset.id), ["production", "fast-adapt", "conservative", "no-replay"]);
    assert.equal(compare.network, null);
    const steps = compare.presets[0].summary.steps;
    assert.ok(compare.presets.every((preset) => preset.summary.steps === steps), "every preset sees the same dishes");

    const chosen = await (await post("/api/network/presets", { scenarioId: "rush", seed: 7, preset: "fast-adapt" })).json();
    assert.equal(chosen.network.learningRate, 0.003);
    assert.equal(chosen.network.batchSize, 8);

    const tuned = await (await post("/api/network/tune", { scenarioId: "rush", seed: 7, atSec: 2400, preset: "conservative" })).json();
    assert.equal(tuned.network.learningRate, 0.0005);

    assert.equal((await post("/api/network/presets", { scenarioId: "rush", preset: "turbo" })).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
