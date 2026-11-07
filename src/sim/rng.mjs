// Deterministic, dependency-free randomness. Every simulation result must be
// reproducible from (scenarioId, seed), so nothing here may touch Math.random.

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng, mean = 0, sd = 1) {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Median-and-CV parameterised positive distribution. Used for prep times:
// occasional long tickets matter far more than a clean bell curve.
export function lognormalish(rng, median, cv) {
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const mu = Math.log(Math.max(1, median));
  return Math.exp(mu + sigma * normal(rng, 0, 1));
}

export function pick(rng, list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("pick() needs a non-empty array");
  return list[Math.floor(rng() * list.length)];
}

export function weightedPick(rng, entries) {
  const total = entries.reduce((acc, e) => acc + e.weight, 0);
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry.value;
  }
  return entries[entries.length - 1].value;
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function round(value, places = 0) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
