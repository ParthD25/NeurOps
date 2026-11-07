import { Engine } from "./engine.mjs";
import { POLICY_IDS, POLICY_LABELS, createPolicy } from "./policy.mjs";
import { getScenario } from "./scenario.mjs";

// Paired replay: same shift, same seeds, only the policy changes. Every number in
// the UI comes from here — nothing is hand-written into the deck.

export function runOne({ scenarioId, policyId = "adaptive", seed = 7 }) {
  const scenario = getScenario(scenarioId);
  const policy = createPolicy(policyId, { seed });
  const engine = new Engine({ scenario, policy });
  const result = engine.run();
  return {
    ...result,
    policyLabel: POLICY_LABELS[policyId] ?? policyId,
    weights: policy.weights,
  };
}

export function compare({ scenarioId, seed = 7, policies = POLICY_IDS }) {
  const rows = policies.map((policyId) => {
    const result = runOne({ scenarioId, policyId, seed });
    return {
      policyId,
      label: POLICY_LABELS[policyId],
      metrics: result.metrics,
      durationSec: result.durationSec,
      tickets: result.tickets.length,
    };
  });
  const adaptive = rows.find((row) => row.policyId === "adaptive");
  const best = rows.reduce((min, row) => (row.metrics.score < min.metrics.score ? row : min), rows[0]);
  return {
    scenarioId,
    seed,
    rows: rows.map((row) => ({
      ...row,
      deltaVsAdaptive:
        adaptive && row.policyId !== "adaptive" ? row.metrics.score - adaptive.metrics.score : 0,
      isBest: row.policyId === best.policyId,
    })),
    adaptiveWins: best.policyId === "adaptive",
    best: best.policyId,
  };
}

export function summarize(result) {
  const m = result.metrics;
  return {
    scenario: result.scenarioId,
    policy: result.policyId,
    tickets: m.tickets,
    onTimePct: m.onTimePct,
    avgSitSec: m.avgSitSec,
    avgLateSec: m.avgLateSec,
    p90LateSec: m.p90LateSec,
    blocked: m.blocked,
    pending: m.pending,
    score: m.score,
  };
}

export const evalMeta = {
  policies: POLICY_IDS.map((id) => ({ id, label: POLICY_LABELS[id] })),
  weights: { sit: 1, late: 5 },
};
