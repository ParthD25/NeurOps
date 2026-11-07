import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateLifecycle } from "./lifecycle.mjs";

// Precomputes the 9-week lifecycle so the server can answer instantly.
// The simulation is deterministic; rerun after changing the model or kitchen.
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "..", "data", "lifecycle.json");
const result = simulateLifecycle();
await writeFile(out, `${JSON.stringify(result)}\n`);
console.log(`wrote ${out}: ${result.days.length} days, ${result.releases.length} releases, cost ${result.impact.avgScore} vs ${result.impact.avgBaselineScore} without releases`);
