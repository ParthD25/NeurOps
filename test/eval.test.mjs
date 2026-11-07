import test from "node:test";
import assert from "node:assert/strict";

import { compare, runOne } from "../src/sim/eval.mjs";
import { getScenario, listScenarios } from "../src/sim/scenario.mjs";

test("replaying the same shift twice is identical", () => {
  const first = runOne({ scenarioId: "rush", policyId: "adaptive", seed: 7 });
  const second = runOne({ scenarioId: "rush", policyId: "adaptive", seed: 7 });
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.tickets, second.tickets);
});

test("every scenario runs every policy without NaN or crashes", () => {
  for (const scenario of listScenarios()) {
    for (const policyId of ["asap", "promised", "fixed", "adaptive", "oracle"]) {
      const result = runOne({ scenarioId: scenario.id, policyId, seed: 7 });
      for (const [key, value] of Object.entries(result.metrics)) {
        if (typeof value === "number") {
          assert.ok(Number.isFinite(value), `${scenario.id}/${policyId}.${key} is ${value}`);
        }
      }
    }
  }
});

test("compare returns one paired row per policy", () => {
  const comparison = compare({ scenarioId: "rush", seed: 7 });
  assert.equal(comparison.rows.length, 5);
  assert.deepEqual(
    comparison.rows.map((row) => row.policyId),
    ["asap", "promised", "fixed", "adaptive", "oracle"],
  );
  assert.equal(comparison.scenarioId, "rush");
  assert.ok(comparison.best);
});

test("on the rush shift the adaptive policy beats both naive baselines", () => {
  const comparison = compare({ scenarioId: "rush", seed: 7 });
  const byId = Object.fromEntries(comparison.rows.map((row) => [row.policyId, row.metrics]));
  assert.ok(
    byId.adaptive.score < byId.asap.score,
    `adaptive ${byId.adaptive.score} should beat fire-on-arrival ${byId.asap.score}`,
  );
  assert.ok(
    byId.adaptive.score < byId.fixed.score,
    `adaptive ${byId.adaptive.score} should beat fixed buffer ${byId.fixed.score}`,
  );
  assert.ok(byId.adaptive.onTimePct > byId.asap.onTimePct);
});

test("chaos shift handles duplicates, 86'd items, empty and past-due tickets", () => {
  const result = runOne({ scenarioId: "chaos", policyId: "adaptive", seed: 7 });
  assert.equal(result.duplicates.length, 1);
  assert.ok(result.metrics.blocked >= 3, `expected at least 3 blocked, got ${result.metrics.blocked}`);
  const blocked = result.tickets.filter((ticket) => ticket.status === "blocked");
  assert.ok(blocked.some((ticket) => /86/.test(ticket.blockedReason ?? "")));
  assert.ok(blocked.some((ticket) => /no items/i.test(ticket.blockedReason ?? "")));
  const pastDue = result.tickets.find((ticket) => ticket.id === "T-004");
  assert.ok(pastDue, "past-due ticket exists");
  assert.ok(
    pastDue.fireAt - pastDue.arrivalSec <= 4,
    `past-due ticket should fire on its first decision, fired after ${pastDue.fireAt - pastDue.arrivalSec}s`,
  );
});

test("the oracle bound is never worse than fire-on-arrival on rush", () => {
  const comparison = compare({ scenarioId: "rush", seed: 7 });
  const byId = Object.fromEntries(comparison.rows.map((row) => [row.policyId, row.metrics]));
  assert.ok(byId.oracle.score <= byId.asap.score);
});

test("unknown scenarios and policies fail loudly", () => {
  assert.throws(() => getScenario("nope"), /unknown scenario/);
  assert.throws(() => runOne({ scenarioId: "rush", policyId: "nope" }), /unknown policy/);
});

test("dinner service learns each server's pass-to-table lag", () => {
  const result = runOne({ scenarioId: "dinner-service", policyId: "adaptive", seed: 7 });
  assert.ok(result.waiterStats.length >= 4, `only ${result.waiterStats.length} servers`);
  for (const waiter of result.waiterStats) {
    assert.ok(waiter.courses > 0, `${waiter.name} served no courses`);
    assert.ok(waiter.avgLagSec >= 0);
  }
  for (const ticket of result.tickets.filter((entry) => entry.status === "handed_off")) {
    assert.ok(ticket.items.every((item) => item.doneAt != null), `${ticket.id} served unfinished food`);
  }
});

test("dinner service carries tables, courses and per-dish plans", () => {
  const result = runOne({ scenarioId: "dinner-service", policyId: "adaptive", seed: 7 });
  const tables = result.tickets.filter((ticket) => ticket.kind === "table");
  assert.equal(tables.length, 18);
  const table1 = tables
    .filter((ticket) => ticket.tableNo === 1)
    .sort((a, b) => a.courseIndex - b.courseIndex);
  assert.deepEqual(table1.map((ticket) => ticket.courseLabel), ["starters", "mains", "dessert"]);
  assert.ok(table1[0].promisedReadySec < table1[1].promisedReadySec);
  assert.ok(table1[1].promisedReadySec < table1[2].promisedReadySec);
  const withPlan = result.tickets.find((ticket) => ticket.plan?.items?.length);
  assert.ok(withPlan, "a ticket has per-dish plans");
  for (const entry of withPlan.plan.items) {
    assert.ok(Number.isFinite(entry.fireAt));
    assert.ok(Number.isFinite(entry.expectedReadyAt));
  }
});
