import test from "node:test";
import assert from "node:assert/strict";

import { Engine } from "../src/sim/engine.mjs";
import { createPolicy } from "../src/sim/policy.mjs";

function ticket(overrides = {}) {
  return {
    id: "T-1",
    arrivalSec: 0,
    promisedReadySec: 600,
    courierEtaSec: 300,
    courierKnownAtSec: 0,
    customerName: "Test Guest",
    channel: "delivery",
    note: null,
    items: [{ lineId: "L1", itemId: "burger", prepSec: 100, station: "grill" }],
    packSec: 20,
    ...overrides,
  };
}

function makeScenario(tickets, extra = {}) {
  return { id: "unit", durationSec: 600, unavailable: [], tickets, ...extra };
}

function stubPolicy(fireAt = 0) {
  return {
    id: "stub",
    plan: ({ now }) => ({
      fireAt,
      expectedReadyAt: now + 120,
      expectedCourierAt: 300,
      confidence: 0.5,
      sitRiskSec: 0,
      lateRiskSec: 0,
      prepMeanSec: 100,
      reason: "stub",
    }),
  };
}

function fireAndRun(engine, ids, { tailSec = 1800 } = {}) {
  engine.markArrivals(0);
  for (const id of ids) assert.equal(engine.fire(id).ok, true);
  return engine.run({ tailSec });
}

test("one worker per station serialises items in fire order", () => {
  const a = ticket({ id: "A" });
  const b = ticket({
    id: "B",
    items: [{ lineId: "L1", itemId: "fries", prepSec: 50, station: "grill" }],
  });
  const engine = new Engine({ scenario: makeScenario([a, b]), policy: stubPolicy() });
  fireAndRun(engine, ["A", "B"]);

  assert.equal(engine.byId.get("A").readyAt, 120);
  assert.equal(engine.byId.get("B").readyAt, 170);
  assert.equal(engine.byId.get("A").status, "handed_off");
});

test("sit and late are measured against the real courier arrival", () => {
  const early = new Engine({
    scenario: makeScenario([ticket({ id: "A", courierEtaSec: 200 })]),
    policy: stubPolicy(),
  });
  fireAndRun(early, ["A"]);
  assert.equal(early.byId.get("A").readyAt, 120);
  assert.equal(early.byId.get("A").handoffAt, 200);
  assert.equal(early.metrics().avgSitSec, 80);
  assert.equal(early.metrics().avgLateSec, 0);

  const late = new Engine({
    scenario: makeScenario([ticket({ id: "A", courierEtaSec: 60 })]),
    policy: stubPolicy(),
  });
  fireAndRun(late, ["A"]);
  assert.equal(late.byId.get("A").handoffAt, 120);
  assert.equal(late.metrics().avgSitSec, 0);
  assert.equal(late.metrics().avgLateSec, 60);
});

test("duplicate ticket ids are dropped, not cooked twice", () => {
  const engine = new Engine({
    scenario: makeScenario([ticket({ id: "A" }), ticket({ id: "A", arrivalSec: 30 })]),
    policy: stubPolicy(),
  });
  const result = engine.run();
  assert.deepEqual(result.duplicates, ["A"]);
  assert.equal(result.tickets.length, 1);
  assert.equal(result.metrics.duplicates, 1);
});

test("an 86'd item blocks the ticket before any station load", () => {
  const engine = new Engine({
    scenario: makeScenario([ticket({ id: "A", items: [{ lineId: "L1", itemId: "wings", prepSec: 200, station: "fry" }] })], {
      unavailable: ["wings"],
    }),
    policy: stubPolicy(),
  });
  const result = engine.run();
  assert.equal(result.tickets[0].status, "blocked");
  assert.match(result.tickets[0].blockedReason, /86/);
  assert.equal(engine.station("fry").queue.length, 0);
  assert.equal(result.metrics.blocked, 1);
});

test("an empty ticket is blocked instead of crashing the run", () => {
  const engine = new Engine({
    scenario: makeScenario([ticket({ id: "A", items: [] })]),
    policy: stubPolicy(),
  });
  const result = engine.run();
  assert.equal(result.tickets[0].status, "blocked");
  assert.match(result.tickets[0].blockedReason, /no items/i);
});

test("firing an unknown ticket reports an error and changes nothing", () => {
  const engine = new Engine({ scenario: makeScenario([ticket({ id: "A" })]), policy: stubPolicy() });
  engine.markArrivals(0);
  const response = engine.fire("NOPE");
  assert.equal(response.ok, false);
  assert.match(response.error, /unknown ticket/);
});

test("courier ETA is hidden until assignment and visible afterwards", () => {
  const engine = new Engine({
    scenario: makeScenario([ticket({ id: "A", courierKnownAtSec: 100, courierEtaSec: 300 })]),
    policy: stubPolicy(),
  });
  const target = engine.byId.get("A");
  assert.deepEqual(engine.courierEstimate(target, 50), { known: false, etaSec: null });
  assert.deepEqual(engine.courierEstimate(target, 150), { known: true, etaSec: 300 });
});

test("the same scenario and policy produce byte-identical results", () => {
  const build = () =>
    new Engine({
      scenario: makeScenario([
        ticket({ id: "A" }),
        ticket({ id: "B", arrivalSec: 20, courierEtaSec: 260 }),
      ]),
      policy: stubPolicy(10),
    }).run();
  assert.deepEqual(build(), build());
});

test("a faster dish starts later so it lands with the dish on the critical station", () => {
  const engine = new Engine({
    scenario: makeScenario([
      ticket({
        id: "S",
        promisedReadySec: 900,
        courierEtaSec: 900,
        items: [
          { lineId: "L1", itemId: "steak", prepSec: 300, station: "grill" },
          { lineId: "L2", itemId: "fries", prepSec: 100, station: "fry" },
        ],
      }),
    ]),
    policy: createPolicy("adaptive"),
  });
  engine.markArrivals(0);
  engine.run({ tailSec: 600 });
  const steak = engine.byId.get("S").items[0];
  const fries = engine.byId.get("S").items[1];
  assert.ok(steak.startedAt != null && fries.startedAt != null, "both dishes started");
  assert.ok(
    fries.startedAt - steak.startedAt >= 120,
    `fries should be held back, started ${fries.startedAt - steak.startedAt}s after the steak`,
  );
  assert.ok(
    Math.abs(fries.doneAt - steak.doneAt) <= 90,
    `dishes should land together, finished ${fries.doneAt - steak.doneAt}s apart`,
  );
});

test("an item that never completes is flagged, not silently handed off", () => {
  const engine = new Engine({
    scenario: makeScenario(
      [ticket({ id: "A", courierEtaSec: 1500, items: [{ lineId: "L1", itemId: "fries", prepSec: 200, station: "fry" }] })],
      { stationOutages: [{ station: "fry", fromSec: 0, toSec: null }] },
    ),
    policy: stubPolicy(0),
  });
  engine.markArrivals(0);
  engine.fire("A");
  const result = engine.run({ tailSec: 1800 });
  const ticketResult = result.tickets[0];
  assert.equal(ticketResult.status, "stalled");
  assert.equal(ticketResult.stalled, true);
  assert.equal(ticketResult.items[0].doneAt, null);
  assert.equal(result.metrics.handedOff, 0);
  assert.equal(result.metrics.stalled, 1);
  assert.equal(result.metrics.unfinished, 1);
});

test("a stalled item recovers when the station comes back", () => {
  const engine = new Engine({
    scenario: makeScenario(
      [ticket({ id: "A", courierEtaSec: 1500, items: [{ lineId: "L1", itemId: "fries", prepSec: 200, station: "fry" }] })],
      { stationOutages: [{ station: "fry", fromSec: 0, toSec: 900 }] },
    ),
    policy: stubPolicy(0),
  });
  engine.markArrivals(0);
  engine.fire("A");
  const result = engine.run({ tailSec: 1800 });
  const ticketResult = result.tickets[0];
  assert.equal(ticketResult.stalled, true);
  assert.ok(ticketResult.items[0].doneAt != null, "the dish eventually completed");
  assert.equal(ticketResult.status, "handed_off");
  assert.equal(result.metrics.handedOff, 1);
  assert.equal(result.metrics.unfinished, 0);
});

test("a dead station reroutes the dish to a backup instead of losing the ticket", () => {
  const engine = new Engine({
    scenario: makeScenario(
      [ticket({ id: "A", courierEtaSec: 1600, items: [{ lineId: "L1", itemId: "fries", prepSec: 200, station: "fry" }] })],
      { stationOutages: [{ station: "fry", fromSec: 0, toSec: null, backup: "grill", penalty: 1.3 }] },
    ),
    policy: stubPolicy(0),
  });
  engine.markArrivals(0);
  engine.fire("A");
  const result = engine.run({ tailSec: 1800 });
  const ticketResult = result.tickets[0];
  assert.equal(ticketResult.items[0].station, "grill");
  assert.equal(ticketResult.remade, true);
  assert.equal(ticketResult.items[0].doneAt != null, true);
  assert.equal(ticketResult.status, "handed_off");
  assert.equal(result.metrics.remade, 1);
  assert.equal(result.metrics.unfinished, 0);
});

test("table courses fire in course order and never all at seating", () => {
  const courses = [0, 1, 2].map((course) =>
    ticket({
      id: `B1-${course + 1}`,
      arrivalSec: 0,
      promisedReadySec: 600 + course * 420,
      courierEtaSec: 600 + course * 420,
      customerName: "Table 1",
      channel: "table",
      kind: "table",
      tableNo: 1,
      partySize: 2,
      courseIndex: course,
      courseLabel: ["starters", "mains", "dessert"][course],
      items: [{ lineId: "L1", itemId: "burger", prepSec: 210, station: "grill" }],
    }),
  );
  const engine = new Engine({ scenario: makeScenario(courses, { durationSec: 1800 }), policy: createPolicy("adaptive") });
  const result = engine.run();
  const [starters, mains, dessert] = ["B1-1", "B1-2", "B1-3"].map((id) => engine.byId.get(id));
  assert.ok(starters.fireAt < mains.fireAt, `starters ${starters.fireAt} should fire before mains ${mains.fireAt}`);
  assert.ok(mains.fireAt < dessert.fireAt, `mains ${mains.fireAt} should fire before dessert ${dessert.fireAt}`);
  for (const course of [starters, mains, dessert]) {
    assert.ok(course.fireAt > 0, `${course.id} should not fire at seating`);
    assert.ok(course.plan.items.length === 1, `${course.id} has an item-level plan`);
  }
  assert.equal(result.tickets[0].kind, "table");
  assert.equal(result.tickets[0].tableNo, 1);
});

test("table service tracks checks and delivery separately from firing", () => {
  const courses = ["starters", "mains", "dessert"].map((label, index) =>
    ticket({
      id: `T-${index}`,
      kind: "table",
      tableNo: 7,
      partySize: 4,
      courseIndex: index,
      courseLabel: label,
      waiterId: "w1",
      waiterName: "Maya",
      waiterSection: "A",
      waiterLagSec: 45,
      arrivalSec: index * 300,
      courierEtaSec: 300 + index * 600,
      promisedReadySec: 300 + index * 600,
      items: [{ lineId: `L${index}`, itemId: "burger", prepSec: 100, station: "grill" }],
    }),
  );
  const engine = new Engine({ scenario: makeScenario(courses, { durationSec: 1800 }), policy: stubPolicy(0) });
  const result = engine.run({ tailSec: 1800 });
  assert.equal(result.tables.length, 1);
  const table = result.tables[0];
  assert.equal(table.tableNo, 7);
  assert.equal(table.waiterName, "Maya");
  assert.ok(table.checks.length >= 2, "waiter should complete repeated check rounds");
  assert.ok(table.checks.every((at) => at >= table.seatedAt + 90));
  for (const served of result.tickets) {
    assert.ok(served.deliveredAt > served.handoffAt);
    assert.equal(served.deliveredAt - served.handoffAt, 45);
  }
  const checkEvents = result.events.filter((event) => event.type === "check");
  assert.equal(checkEvents.length, table.checks.length - 1);
});
