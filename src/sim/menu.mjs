// Prep times are medians with a coefficient of variation. The CV is the honest
// part of the model: a burger is not a constant, and a kitchen that pretends it
// is will either burn food or make couriers wait.

export const PACK_SEC = 20;
export const STATIONS = ["grill", "fry", "cold"];

export const STATION_LABEL = {
  grill: "Grill",
  fry: "Fry",
  cold: "Cold / assembly",
};

export const MENU = [
  { id: "burger", name: "Smash Burger", station: "grill", medianSec: 210, cv: 0.16, priceCents: 1450 },
  { id: "fries", name: "Fries", station: "fry", medianSec: 150, cv: 0.12, priceCents: 450 },
  { id: "nuggets", name: "Nuggets", station: "fry", medianSec: 180, cv: 0.15, priceCents: 650 },
  { id: "salad", name: "Garden Salad", station: "cold", medianSec: 120, cv: 0.2, priceCents: 1100 },
  { id: "bowl", name: "Grain Bowl", station: "cold", medianSec: 165, cv: 0.22, priceCents: 1350 },
  { id: "wrap", name: "Chicken Wrap", station: "cold", medianSec: 140, cv: 0.18, priceCents: 1050 },
  { id: "steak", name: "Steak Plate", station: "grill", medianSec: 330, cv: 0.24, priceCents: 2200 },
  { id: "wings", name: "Wings (8)", station: "fry", medianSec: 240, cv: 0.19, priceCents: 1250 },
  { id: "mac", name: "Mac & Cheese", station: "grill", medianSec: 90, cv: 0.1, priceCents: 750 },
  { id: "drink", name: "Fountain Drink", station: "cold", medianSec: 45, cv: 0.08, priceCents: 350 },
  // Dishes that appear in the public order dataset. Their stations and prep
  // medians are this kitchen's assumptions, because the dataset has no timings.
  { id: "pizza", name: "Pizza", station: "grill", medianSec: 300, cv: 0.18, priceCents: 1600 },
  { id: "tacos", name: "Fish Tacos", station: "cold", medianSec: 170, cv: 0.2, priceCents: 1300 },
  { id: "padthai", name: "Pad Thai", station: "grill", medianSec: 240, cv: 0.2, priceCents: 1500 },
  { id: "brisket", name: "Brisket Plate", station: "grill", medianSec: 360, cv: 0.22, priceCents: 2100 },
  { id: "tenders", name: "Chicken Tenders", station: "fry", medianSec: 200, cv: 0.16, priceCents: 1100 },
  { id: "brownie", name: "Brownie", station: "cold", medianSec: 60, cv: 0.1, priceCents: 600 },
  { id: "soup", name: "Soup", station: "cold", medianSec: 90, cv: 0.12, priceCents: 700 },
  { id: "pasta", name: "Pasta", station: "cold", medianSec: 180, cv: 0.15, priceCents: 1400 },
  { id: "salmon", name: "Salmon Plate", station: "grill", medianSec: 240, cv: 0.18, priceCents: 2000 },
];

export const MENU_BY_ID = new Map(MENU.map((item) => [item.id, item]));

export const ITEM_WEIGHTS = [
  { value: "burger", weight: 10 },
  { value: "fries", weight: 9 },
  { value: "bowl", weight: 7 },
  { value: "wrap", weight: 6 },
  { value: "salad", weight: 5 },
  { value: "nuggets", weight: 5 },
  { value: "mac", weight: 4 },
  { value: "wings", weight: 3 },
  { value: "steak", weight: 2 },
  { value: "drink", weight: 6 },
];

export function itemById(id) {
  const item = MENU_BY_ID.get(id);
  if (!item) throw new Error(`unknown menu item: ${id}`);
  return item;
}

export function menuName(id) {
  return MENU_BY_ID.get(id)?.name ?? id;
}

// A ticket's prep time is the critical path across stations plus the pack
// buffer. Ignoring station contention here is deliberate: contention is
// modelled separately from the live queue so the agent can see it.
export function menuForecast(items) {
  const perStation = new Map();
  for (const item of items) {
    const entry = perStation.get(item.station) ?? { meanSec: 0, varSec2: 0, count: 0 };
    entry.meanSec += item.medianSec;
    entry.varSec2 += (item.medianSec * item.cv) ** 2;
    entry.count += 1;
    perStation.set(item.station, entry);
  }
  return perStation;
}
