import { readFileSync } from "node:fs";

import { PACK_SEC, itemById } from "./menu.mjs";
import { hashString, lognormalish, mulberry32 } from "./rng.mjs";

// Real order baskets, not real kitchen timings. The public dataset has order
// composition, timestamps and delivery durations; it has no station or prep
// data. So the baskets and the arrival pattern are real and the cook times are
// this kitchen's calibrated priors. Never claim more than that.

const DATASET = "mindweave/food-delivery-orders";
const SOURCE_URL = `https://huggingface.co/datasets/${DATASET}`;
const SAMPLE = new URL("../../data/orders.raw.json", import.meta.url);

const RULES = [
  [/wing/, "wings"],
  [/tender/, "tenders"],
  [/caesar|garden|salad/, "salad"],
  [/pizza/, "pizza"],
  [/taco/, "tacos"],
  [/pad thai|thai/, "padthai"],
  [/brisket|ribs/, "brisket"],
  [/salmon/, "salmon"],
  [/pasta/, "pasta"],
  [/soup/, "soup"],
  [/brownie|cake|dessert/, "brownie"],
  [/burger/, "burger"],
  [/fries|fry/, "fries"],
  [/nugget/, "nuggets"],
  [/wrap|sandwich/, "wrap"],
  [/bowl|rice/, "bowl"],
  [/steak/, "steak"],
  [/mac/, "mac"],
  [/drink|soda|cola|water|lemonade|tea/, "drink"],
  [/chicken/, "tenders"],
];

export function mapItemName(raw) {
  const name = String(raw ?? "").toLowerCase();
  for (const [pattern, id] of RULES) if (pattern.test(name)) return id;
  return null;
}

export function loadRealOrders() {
  const raw = JSON.parse(readFileSync(SAMPLE, "utf8"));
  return raw.rows.map((entry) => entry.row);
}

export function buildRealScenario({ id = "real-orders", maxOrders = 100 } = {}) {
  const rows = loadRealOrders();
  const delivered = rows.filter((order) => order.status === "delivered").slice(0, maxOrders);
  const unmatched = new Set();
  const orders = [];

  for (const order of delivered) {
    const names = String(order.items ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const mapped = [];
    for (const name of names) {
      const itemId = mapItemName(name);
      if (itemId) mapped.push(itemId);
      else unmatched.add(name);
    }
    if (!mapped.length) continue;
    orders.push({ order, mapped: mapped.slice(0, 6) });
  }

  const times = orders
    .map(({ order }) => Date.parse(order.order_timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const span = Math.max(1, times[times.length - 1] - times[0]);
  const scale = 4800 / span; // squash the real window into one dinner service
  const rng = mulberry32(hashString("real-orders"));

  const tickets = orders.map(({ order, mapped }) => {
    const arrivalSec = Math.max(30, Math.round((Date.parse(order.order_timestamp) - times[0]) * scale));
    const items = mapped.map((itemId, index) => {
      const item = itemById(itemId);
      return {
        lineId: `L${index + 1}`,
        itemId,
        prepSec: Math.max(20, Math.round(lognormalish(rng, item.medianSec, item.cv))),
        station: item.station,
        course: 0,
      };
    });
    const estimatedMin = Number(order.estimated_delivery_min) || 30;
    const actualMin = Number(order.actual_delivery_min) || estimatedMin + 4;
    return {
      id: `R-${String(order.id).padStart(3, "0")}`,
      arrivalSec,
      promisedReadySec: arrivalSec + Math.max(600, Math.round(estimatedMin * 60 * 0.65)),
      courierEtaSec: arrivalSec + Math.max(720, Math.round(actualMin * 60 * 0.75)),
      courierKnownAtSec: arrivalSec,
      customerName: `Order ${order.id}`,
      channel: "delivery",
      kind: "delivery",
      tableNo: null,
      partySize: null,
      courseIndex: 0,
      courseLabel: null,
      note: `basket from ${DATASET}`,
      items,
      packSec: PACK_SEC,
    };
  });

  return {
    id,
    title: "Real order data",
    blurb: `${tickets.length} delivered orders from a public Hugging Face food-delivery dataset, compressed into one service. Baskets and arrival order are real; prep times are not in the source and stay calibrated.`,
    seed: 0,
    durationSec: Math.max(...tickets.map((ticket) => ticket.arrivalSec)) + 900,
    unavailable: [],
    tickets,
    watch: "real baskets",
    source: {
      dataset: DATASET,
      url: SOURCE_URL,
      rows: delivered.length,
      used: tickets.length,
      unmatched: [...unmatched].slice(0, 10),
    },
  };
}
