import test from "node:test";
import assert from "node:assert/strict";

import { buildCoachBrief, guardCoach } from "../src/coach.mjs";

const facts = {
  scenario: "Dinner service",
  policy: "Fireline (adaptive)",
  onTimePct: 42,
  avgSitSec: 20,
  avgLateSec: 35,
  p90LateSec: 90,
  stalled: 1,
  remade: 2,
  unfinished: 1,
  waiters: [
    { name: "Maya", avgLagSec: 40, lateCourses: 1, courses: 3 },
    { name: "Sam", avgLagSec: 90, lateCourses: 2, courses: 3 },
  ],
  risky: [{ id: "B2-2", lateRiskSec: 120, waiter: "Sam" }],
};

test("the coach rejects destructive actions and invented numbers", () => {
  assert.equal(guardCoach("Delete the order and mark it complete.", facts).ok, false);
  assert.equal(guardCoach("Clear all tickets and start over.", facts).ok, false);
  assert.equal(guardCoach("Maya is 40s behind; hold the fries for 20s.", facts).ok, true);
  const invented = guardCoach("Maya is 999s behind.", facts);
  assert.equal(invented.ok, false);
  assert.deepEqual(invented.unknown, ["999"]);
});

test("the deterministic coach uses only measured facts and never claims it can serve food", () => {
  const text = buildCoachBrief(facts);
  assert.match(text, /Dinner service/);
  assert.match(text, /Maya|Sam/);
  assert.match(text, /advisory only/);
  assert.equal(guardCoach(text, facts).ok, true);
});
