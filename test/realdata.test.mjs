import test from "node:test";
import assert from "node:assert/strict";

import { MENU_BY_ID } from "../src/sim/menu.mjs";
import { runOne } from "../src/sim/eval.mjs";
import { getScenario } from "../src/sim/scenario.mjs";

test("real order data builds a scenario from the public sample", () => {
  const scenario = getScenario("real-orders");
  assert.ok(scenario.tickets.length >= 20, `only ${scenario.tickets.length} tickets built`);
  assert.equal(scenario.source.used, scenario.tickets.length);
  for (const ticket of scenario.tickets) {
    assert.ok(ticket.items.length >= 1, `${ticket.id} has no items`);
    for (const item of ticket.items) {
      assert.ok(MENU_BY_ID.has(item.itemId), `${item.itemId} is not on the menu`);
      assert.ok(item.prepSec >= 20);
    }
  }
});

test("real order runs are valid and never hand off an unfinished ticket", () => {
  for (const policyId of ["adaptive", "asap"]) {
    const result = runOne({ scenarioId: "real-orders", policyId, seed: 7 });
    for (const [key, value] of Object.entries(result.metrics)) {
      if (typeof value === "number") assert.ok(Number.isFinite(value), `${policyId}.${key} is ${value}`);
    }
    for (const ticket of result.tickets.filter((entry) => entry.status === "handed_off")) {
      assert.ok(
        ticket.items.every((item) => item.doneAt != null),
        `${ticket.id} was handed off with an unfinished dish`,
      );
    }
    const finished = result.tickets.filter((ticket) => ticket.status === "handed_off").length;
    assert.equal(result.metrics.handedOff, finished);
  }
});
