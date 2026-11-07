import {
  clamp,
  hashString,
  lognormalish,
  mulberry32,
  normal,
  weightedPick,
} from "./rng.mjs";
import { ITEM_WEIGHTS, MENU_BY_ID, PACK_SEC, itemById } from "./menu.mjs";
import { buildRealScenario } from "./realdata.mjs";

// A scenario is a frozen shift: every ticket, every prep duration, and every
// courier arrival is sampled up front. Policies only change *scheduling*, so two
// policies are compared on the exact same shift. That is what makes the numbers
// in the Evidence tab a paired comparison rather than two unrelated runs.

const CUSTOMER_NAMES = [
  "Maya R.", "Dev P.", "Ana S.", "Jordan K.", "Priya N.", "Liam O.",
  "Sam T.", "Noor A.", "Elena V.", "Chris B.", "Hana M.", "Owen D.",
  "Rosa L.", "Theo W.", "Iris C.", "Jonas F.", "Tara G.", "Miles H.",
];

const CHANNELS = ["delivery", "delivery", "delivery", "pickup"];

export const SCENARIO_SEEDS = {
  rush: 4101,
  surge: 4102,
  "late-couriers": 4103,
  unassigned: 4104,
  "cold-start": 4105,
  chaos: 4106,
  "dinner-service": 4107,
  "station-down": 4108,
};

const COURSE_LABELS = ["starters", "mains", "dessert"];
// When a table wants each course, measured from the moment it sits down.
const COURSE_TARGETS_SEC = [600, 1020, 1440];

const DESSERT_WEIGHTS = [
  { value: "mac", weight: 4 },
  { value: "salad", weight: 3 },
  { value: "drink", weight: 6 },
];

function prepFor(item, rng) {
  return Math.max(20, Math.round(lognormalish(rng, item.medianSec, item.cv)));
}

function makeTicket({ rng, index, arrivalSec, opts = {} }) {
  const channel = opts.channel ?? CHANNELS[Math.floor(rng() * CHANNELS.length)];
  const itemCount = opts.itemCount ?? 1 + Math.floor(rng() * 3.2);
  const items = [];
  for (let i = 0; i < itemCount; i += 1) {
    const itemId = weightedPick(rng, ITEM_WEIGHTS);
    const item = itemById(itemId);
    items.push({
      lineId: `L${i + 1}`,
      itemId,
      prepSec: prepFor(item, rng),
      station: item.station,
      course: opts.course ?? 0,
    });
  }

  const promiseFloor = opts.promiseMinSec ?? 720;
  const promiseSpread = opts.promiseSpreadSec ?? 600;
  const promisedReadySec =
    arrivalSec + promiseFloor + Math.round(rng() * promiseSpread);

  const courierBiasSec = opts.courierBiasSec ?? 0;
  const courierSdSec = opts.courierSdSec ?? 90;
  const rawCourier = promisedReadySec + courierBiasSec + Math.round(normal(rng, 0, courierSdSec));
  const courierEtaSec = Math.max(arrivalSec + 240, rawCourier);

  const unassigned = Boolean(opts.unassigned) && rng() < 0.4;
  const courierKnownAtSec = unassigned
    ? arrivalSec + 600 + Math.round(rng() * 300)
    : arrivalSec;

  return {
    id: opts.id ?? `T-${String(index + 1).padStart(3, "0")}`,
    arrivalSec,
    promisedReadySec,
    courierEtaSec,
    courierKnownAtSec,
    customerName: opts.customerName ?? CUSTOMER_NAMES[Math.floor(rng() * CUSTOMER_NAMES.length)],
    channel,
    kind: channel === "pickup" ? "pickup" : "delivery",
    tableNo: null,
    partySize: null,
    courseIndex: 0,
    courseLabel: null,
    note: opts.note ?? null,
    items,
    packSec: PACK_SEC,
  };
}

function generateShift({ id, count, durationSec, meanGapSec, opts = {} }) {
  const rng = mulberry32(SCENARIO_SEEDS[id] ?? hashString(id));
  const tickets = [];
  let cursor = 30;
  for (let i = 0; i < count; i += 1) {
    cursor += Math.max(12, Math.round(lognormalish(rng, meanGapSec, 0.55)));
    if (cursor > durationSec - 120) break;
    const ticket = makeTicket({ rng, index: i, arrivalSec: cursor, opts });
    if (opts.pickupShare && rng() < opts.pickupShare) ticket.channel = "pickup";
    tickets.push(ticket);
  }
  return { tickets, rng };
}

function chaosTickets() {
  const rng = mulberry32(SCENARIO_SEEDS.chaos);
  const base = makeTicket({ rng, index: 0, arrivalSec: 60, opts: { itemCount: 2 } });

  const duplicate = {
    ...makeTicket({ rng, index: 1, arrivalSec: 90, opts: { itemCount: 1 } }),
    id: base.id,
  };

  const withEightySixed = makeTicket({
    rng, index: 2, arrivalSec: 150,
    opts: { itemCount: 2, customerName: "Ana S." },
  });
  withEightySixed.items[0] = { ...withEightySixed.items[0], itemId: "wings", station: "fry", prepSec: 240 };

  const pastDue = {
    ...makeTicket({ rng, index: 3, arrivalSec: 240, opts: { itemCount: 2 } }),
    promisedReadySec: 180,
    courierEtaSec: 300,
  };

  const party = makeTicket({
    rng, index: 4, arrivalSec: 360,
    opts: { itemCount: 12, promiseMinSec: 1500, promiseSpreadSec: 300, customerName: "Jordan K." },
  });

  const empty = {
    ...makeTicket({ rng, index: 5, arrivalSec: 420, opts: { itemCount: 0 } }),
    items: [],
  };

  const longCook = {
    ...makeTicket({
      rng, index: 6, arrivalSec: 480,
      opts: { itemCount: 4, promiseMinSec: 1500, promiseSpreadSec: 240, customerName: "Priya N." },
    }),
    items: [1, 2, 3, 4].map((n) => ({
      lineId: `L${n}`,
      itemId: "steak",
      station: "grill",
      prepSec: 330 + Math.round(rng() * 90),
    })),
  };

  const note = makeTicket({
    rng, index: 7, arrivalSec: 540,
    opts: { itemCount: 1, note: "Extra napkins <b>please</b>", customerName: "Owen D." },
  });

  return [base, duplicate, withEightySixed, pastDue, party, empty, longCook, note];
}

// A table is three course-tickets that share a table number and a seating time.
// Each course has its own serve target, so the kitchen is not choosing one fire
// time for the table — it is choosing one per course, and one per dish inside it.
function dinnerTickets() {
  const rng = mulberry32(SCENARIO_SEEDS["dinner-service"]);
  const tickets = [];
  for (let table = 1; table <= 6; table += 1) {
    const seatedAt = 60 + table * 240 + Math.round(rng() * 120);
    const partySize = 2 + Math.floor(rng() * 4);
    for (let course = 0; course < 3; course += 1) {
      const count = course === 1 ? 2 : 1 + Math.floor(rng() * 2);
      const items = [];
      for (let i = 0; i < count; i += 1) {
        const weights = course === 2 ? DESSERT_WEIGHTS : ITEM_WEIGHTS;
        const item = itemById(weightedPick(rng, weights));
        items.push({
          lineId: `L${i + 1}`,
          itemId: item.id,
          prepSec: prepFor(item, rng),
          station: item.station,
          course,
        });
      }
      const target = seatedAt + COURSE_TARGETS_SEC[course];
      tickets.push({
        id: `B${table}-${course + 1}`,
        arrivalSec: seatedAt,
        promisedReadySec: target,
        courierEtaSec: target,
        courierKnownAtSec: seatedAt,
        customerName: `Table ${table}`,
        channel: "table",
        kind: "table",
        tableNo: table,
        partySize,
        courseIndex: course,
        courseLabel: COURSE_LABELS[course],
        note: null,
        items,
        packSec: PACK_SEC,
      });
    }
  }
  return tickets;
}

export const SCENARIOS = [
  {
    id: "rush",
    title: "Friday rush",
    blurb: "40 tickets over 75 minutes, three stations, one cook per station.",
    seed: SCENARIO_SEEDS.rush,
    durationSec: 4500,
    unavailable: [],
    tickets: generateShift({ id: "rush", count: 40, durationSec: 4500, meanGapSec: 110 }).tickets,
    watch: "the default demo",
  },
  {
    id: "surge",
    title: "Surge spike",
    blurb: "55 tickets in an hour while couriers already run 2 minutes late.",
    seed: SCENARIO_SEEDS.surge,
    durationSec: 3600,
    unavailable: [],
    tickets: generateShift({
      id: "surge", count: 55, durationSec: 3600, meanGapSec: 58,
      opts: { courierBiasSec: 120 },
    }).tickets,
    watch: "congestion",
  },
  {
    id: "late-couriers",
    title: "Late couriers",
    blurb: "Couriers arrive 2.5 minutes after promise, every time. Does the agent notice?",
    seed: SCENARIO_SEEDS["late-couriers"],
    durationSec: 3300,
    unavailable: [],
    tickets: generateShift({
      id: "late-couriers", count: 24, durationSec: 3300, meanGapSec: 110,
      opts: { courierBiasSec: 150, courierSdSec: 75 },
    }).tickets,
    watch: "adaptation",
  },
  {
    id: "unassigned",
    title: "Couriers unassigned",
    blurb: "40% of tickets have no courier for the first ten minutes. Fire anyway?",
    seed: SCENARIO_SEEDS.unassigned,
    durationSec: 3000,
    unavailable: [],
    tickets: generateShift({
      id: "unassigned", count: 20, durationSec: 3000, meanGapSec: 120,
      opts: { unassigned: true },
    }).tickets,
    watch: "uncertainty",
  },
  {
    id: "cold-start",
    title: "Cold start",
    blurb: "Six tickets, zero history. The agent has only the menu priors.",
    seed: SCENARIO_SEEDS["cold-start"],
    durationSec: 1500,
    unavailable: [],
    tickets: generateShift({
      id: "cold-start", count: 6, durationSec: 1500, meanGapSec: 150,
      opts: { itemCount: 2, promiseMinSec: 600 },
    }).tickets,
    watch: "priors",
  },
  {
    id: "dinner-service",
    title: "Dinner service",
    blurb: "Six tables, three courses each, plus delivery. Starters, mains and dessert each have their own serve time; dishes inside a course are staggered by cook time so they land together.",
    seed: SCENARIO_SEEDS["dinner-service"],
    durationSec: 3600,
    unavailable: [],
    tickets: [
      ...dinnerTickets(),
      ...generateShift({ id: "dinner-service", count: 14, durationSec: 3600, meanGapSec: 150 }).tickets,
    ],
    watch: "courses and tables",
  },
  {
    id: "station-down",
    title: "Station down",
    blurb: "The fry station dies at 10:00 and never comes back. Dishes already in it are never marked complete, so the ticket can never be handed off.",
    seed: 4108,
    durationSec: 2400,
    unavailable: [],
    stationOutages: [{ station: "fry", fromSec: 600, toSec: null }],
    tickets: generateShift({ id: "station-down", count: 14, durationSec: 2400, meanGapSec: 120 }).tickets,
    watch: "never-completed items",
  },
  buildRealScenario(),
  {
    id: "chaos",
    title: "Chaos shift",
    blurb: "Duplicate id, an 86'd item, a promise already in the past, a 12-item party order, and an empty ticket.",
    seed: SCENARIO_SEEDS.chaos,
    durationSec: 2400,
    unavailable: ["wings"],
    tickets: chaosTickets(),
    watch: "edge cases",
  },
];

const BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

export function listScenarios() {
  return SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    blurb: s.blurb,
    watch: s.watch,
    ticketCount: s.tickets.length,
    durationSec: s.durationSec,
    unavailable: s.unavailable,
  }));
}

export function getScenario(id) {
  const scenario = BY_ID.get(id);
  if (!scenario) throw new Error(`unknown scenario: ${id}`);
  return scenario;
}

export function scenarioSummary(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    blurb: scenario.blurb,
    durationSec: scenario.durationSec,
    unavailable: scenario.unavailable,
    ticketCount: scenario.tickets.length,
    orderValueCents: scenario.tickets.reduce(
      (sum, ticket) =>
        sum + ticket.items.reduce((inner, item) => inner + (MENU_BY_ID.get(item.itemId)?.priceCents ?? 0), 0),
      0,
    ),
  };
}
