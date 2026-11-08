import { Engine } from "./engine.mjs";
import { createPolicy } from "./policy.mjs";
import { restaurantDay } from "./scenario.mjs";
import { itemById, menuName } from "./menu.mjs";
import { PrepNet, samplesFromSteps } from "./nn.mjs";

// The model lifecycle: weeks of service at one restaurant.
//
//   challenger  a PrepNet that keeps training on every finished dish, every day
//   champion    a frozen copy that is "in production": at the start of each
//               shift its predictions become the scheduler's prep-time priors
//               (the scheduler still learns within the shift on top of them)
//
// Every cycle (21 days by default) the challenger is scored against the
// champion on the most recent days' dishes. It replaces the champion only if
// its error is lower by a real margin; otherwise the champion stays. Each
// release is recorded with the numbers that justified it.

// How this kitchen differs from the menu's assumptions. The grill line runs
// slow and the new fryer runs fast; from day 36 the grill slows further
// (a cook leaves), which a fixed model cannot know and a retrained one can.
export const KITCHEN_PROFILE = {
  label: "Fireline demo kitchen",
  base: { steak: 1.3, burger: 1.15, mac: 1.1, fries: 0.8, wings: 0.85, nuggets: 0.9, bowl: 1.2, salad: 0.9 },
  drift: { fromDay: 36, factors: { steak: 1.5, burger: 1.3, mac: 1.25 }, note: "grill cook leaves; grill dishes slow down" },
};

function factorsFor(day, profile) {
  return day >= profile.drift.fromDay ? { ...profile.base, ...profile.drift.factors } : { ...profile.base };
}

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const round1 = (value) => (value == null ? null : Math.round(value * 10) / 10);

export function simulateLifecycle({
  weeks = 9,
  cycleDays = 21,
  evalDays = 3,
  marginSec = 1,
  profile = KITCHEN_PROFILE,
  ordersPerDay = 30,
  withBaseline = true,
  netOptions = {},
} = {}) {
  const totalDays = Math.max(1, Math.min(26 * 7, Math.round(weeks * 7)));
  const challenger = new PrepNet(netOptions);
  let champion = null; // v1 is the menu medians themselves
  let championVersion = 1;
  const releases = [
    { version: 1, day: 0, kind: "baseline", note: "Menu medians. No restaurant data yet.", championMaeSec: null, challengerMaeSec: null },
  ];
  const cycles = [];
  const days = [];

  for (let day = 1; day <= totalDays; day += 1) {
    const frozen = champion ? champion.clone() : null;
    const predictChampion = (itemId) => (frozen ? frozen.predict(itemId) : itemById(itemId).medianSec);
    const scenario = restaurantDay({ day, prepFactor: factorsFor(day, profile), count: ordersPerDay });
    const policy = createPolicy("adaptive", { prepPrior: frozen ? (itemId) => Math.max(20, frozen.predict(itemId)) : null });
    const result = new Engine({ scenario, policy }).run();
    const samples = samplesFromSteps(result.network.steps);
    // Counterfactual: the same day with v1 (menu medians) left in production.
    const baseline = withBaseline
      ? new Engine({ scenario, policy: createPolicy("adaptive") }).run().metrics
      : null;

    const championErr = [];
    const challengerErr = [];
    const menuErr = [];
    for (const sample of samples) {
      championErr.push(Math.abs(predictChampion(sample.itemId) - sample.serviceSec));
      menuErr.push(Math.abs(itemById(sample.itemId).medianSec - sample.serviceSec));
      // Predict-then-update, so the challenger's error is honest online error.
      const { errSec } = challenger.train(sample.itemId, sample.serviceSec);
      challengerErr.push(Math.abs(errSec));
    }
    days.push({
      day,
      championVersion,
      dishes: samples.length,
      championMaeSec: round1(mean(championErr)),
      challengerMaeSec: round1(mean(challengerErr)),
      menuMaeSec: round1(mean(menuErr)),
      score: result.metrics.score,
      onTimePct: result.metrics.onTimePct,
      baselineScore: baseline?.score ?? null,
      baselineOnTimePct: baseline?.onTimePct ?? null,
      drift: day === profile.drift.fromDay ? profile.drift.note : null,
    });

    if (day % cycleDays === 0) {
      const window = days.slice(-evalDays);
      const championMae = round1(mean(window.map((entry) => entry.championMaeSec)));
      const challengerMae = round1(mean(window.map((entry) => entry.challengerMaeSec)));
      const promote = challengerMae != null && championMae != null && challengerMae < championMae - marginSec;
      const cycle = {
        day,
        evalDays,
        championVersion,
        championMaeSec: championMae,
        challengerMaeSec: challengerMae,
        promoted: promote,
      };
      if (promote) {
        champion = challenger.clone();
        championVersion += 1;
        cycle.newVersion = championVersion;
        releases.push({
          version: championVersion,
          day,
          kind: "promoted",
          note: `Retrained network replaced v${championVersion - 1}: ${challengerMae}s vs ${championMae}s error over the last ${evalDays} days.`,
          championMaeSec: championMae,
          challengerMaeSec: challengerMae,
        });
      } else {
        cycle.note = `Kept v${championVersion}: the retrained network was not better by ${marginSec}s.`;
      }
      cycles.push(cycle);
    }
  }

  const corrections = Object.entries(factorsFor(totalDays, profile))
    .map(([itemId, factor]) => ({
      itemId,
      name: menuName(itemId),
      menuSec: itemById(itemId).medianSec,
      kitchenSec: Math.round(itemById(itemId).medianSec * factor),
      championSec: Math.round(champion ? champion.predict(itemId) : itemById(itemId).medianSec),
    }))
    .sort((a, b) => Math.abs(b.kitchenSec - b.menuSec) - Math.abs(a.kitchenSec - a.menuSec));

  const sum = (key) => days.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  const impact = withBaseline
    ? {
        avgScore: Math.round(sum("score") / days.length),
        avgBaselineScore: Math.round(sum("baselineScore") / days.length),
        avgOnTimePct: round1(sum("onTimePct") / days.length),
        avgBaselineOnTimePct: round1(sum("baselineOnTimePct") / days.length),
      }
    : null;

  return {
    impact,
    config: { weeks, totalDays, cycleDays, evalDays, marginSec, ordersPerDay, kitchen: profile.label, driftDay: profile.drift.fromDay, driftNote: profile.drift.note },
    days,
    cycles,
    releases,
    production: { version: championVersion, sinceDay: releases.at(-1).day, nextReviewDay: (Math.floor(totalDays / cycleDays) + 1) * cycleDays },
    corrections,
  };
}
