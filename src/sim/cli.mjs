import { SCENARIOS } from "./scenario.mjs";
import { compare, runOne } from "./eval.mjs";
import { POLICY_LABELS } from "./policy.mjs";

function pad(value, width) {
  return String(value).padEnd(width, " ");
}

export function formatTable(rows) {
  const header = [pad("policy", 24), pad("on-time", 9), pad("sit s", 7), pad("late s", 7), pad("p90 s", 7), pad("score", 7)];
  const lines = [header.join(" ")];
  for (const row of rows) {
    lines.push(
      [
        pad(row.label, 24),
        pad(`${row.metrics.onTimePct}%`, 9),
        pad(row.metrics.avgSitSec, 7),
        pad(row.metrics.avgLateSec, 7),
        pad(row.metrics.p90LateSec, 7),
        pad(row.metrics.score, 7),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

function main() {
  const arg = process.argv[2];
  const scenarioIds = arg ? [arg] : SCENARIOS.map((s) => s.id);
  for (const scenarioId of scenarioIds) {
    const result = new URLSearchParams();
    result.set("x", "1");
    console.log(`\n=== ${scenarioId} ===`);
    const comparison = compare({ scenarioId, seed: 7 });
    console.log(formatTable(comparison.rows));
    const adaptive = comparison.rows.find((row) => row.policyId === "adaptive");
    const asap = comparison.rows.find((row) => row.policyId === "asap");
    const fixed = comparison.rows.find((row) => row.policyId === "fixed");
    if (adaptive && asap && fixed) {
      console.log(
        `adaptive vs fire-on-arrival: score ${adaptive.metrics.score} vs ${asap.metrics.score}; ` +
          `vs fixed buffer: ${adaptive.metrics.score} vs ${fixed.metrics.score}`,
      );
    }
    const detail = runOne({ scenarioId, policyId: "adaptive", seed: 7 });
    console.log(
      `${POLICY_LABELS.adaptive}: ${detail.metrics.onTimePct}% on time, ` +
        `${detail.metrics.avgSitSec}s sitting, ${detail.metrics.avgLateSec}s late, ` +
        `${detail.metrics.blocked} blocked, ${detail.metrics.pending} still waiting at close.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
