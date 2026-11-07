// A shift brief is generated from measured numbers only. The deterministic path
// always works. The optional LLM path is allowed to *rephrase* those numbers and
// nothing else: any figure it invents fails the guard and the caller falls back.

export function buildFacts({ result, comparison }) {
  const m = result.metrics;
  const adaptive = comparison?.rows.find((row) => row.policyId === "adaptive");
  const asap = comparison?.rows.find((row) => row.policyId === "asap");
  return {
    scenario: result.scenarioTitle,
    policy: result.policyLabel,
    tickets: m.tickets,
    handedOff: m.handedOff,
    blocked: m.blocked,
    pending: m.pending,
    onTimePct: m.onTimePct,
    avgSitSec: m.avgSitSec,
    avgLateSec: m.avgLateSec,
    p90LateSec: m.p90LateSec,
    avgWaitSec: m.avgWaitSec,
    maxLateSec: m.maxLateSec,
    score: m.score,
    sitWeight: result.weights?.sit ?? 1,
    lateWeight: result.weights?.late ?? 5,
    adaptiveScore: adaptive ? adaptive.metrics.score : null,
    fireOnArrivalScore: asap ? asap.metrics.score : null,
    scoreDelta: asap ? asap.metrics.score - m.score : null,
    durationMin: Math.round(result.durationSec / 60),
  };
}

export function buildBrief({ result, comparison }) {
  const facts = buildFacts({ result, comparison });
  const lines = [];
  lines.push(
    `${facts.scenario}: ${facts.handedOff}/${facts.tickets} tickets handed off, ${facts.onTimePct}% on time.`,
  );
  lines.push(
    `Food sat ${facts.avgSitSec}s on average; couriers waited ${facts.avgLateSec}s (tail wait ${facts.p90LateSec}s).`,
  );
  if (facts.blocked > 0) {
    lines.push(`${facts.blocked} ticket(s) blocked before cooking, ${facts.pending} still waiting at close.`);
  }
  if (facts.fireOnArrivalScore != null && facts.adaptiveScore != null) {
    const diff = facts.fireOnArrivalScore - facts.adaptiveScore;
    const direction = diff >= 0 ? "better" : "worse";
    lines.push(
      `Composite cost ${facts.adaptiveScore} vs ${facts.fireOnArrivalScore} for fire-on-arrival (${Math.abs(diff)} ${direction}).`,
    );
  }
  lines.push(
    `Weighting: one second of food sitting costs ${facts.sitWeight}; one second of courier waiting costs ${facts.lateWeight}. Change the weight and the firing times change.`,
  );
  return lines.join(" ");
}

const NUMBER = /\d+(?:\.\d+)?/g;

export function guardNumbers(text, facts) {
  const allowed = new Set();
  for (const value of Object.values(facts)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      allowed.add(String(Math.abs(value)));
      allowed.add(String(Math.round(Math.abs(value))));
    }
  }
  const unknown = [...new Set((text.match(NUMBER) ?? []).filter((n) => !allowed.has(n)))];
  return { ok: unknown.length === 0, unknown };
}

export async function llmBrief({
  facts,
  apiKey,
  model = "openai/gpt-4o-mini",
  baseUrl = "https://openrouter.ai/api/v1",
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
} = {}) {
  if (!apiKey) return { ok: false, error: "no key" };
  if (typeof fetchImpl !== "function") return { ok: false, error: "no fetch" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://fireline.local",
        "X-Title": "Fireline",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You write a two-sentence shift handover for a restaurant kitchen. Use ONLY numbers present in the facts JSON. Never invent a number, a cause, or an action. Be concrete and calm.",
          },
          {
            role: "user",
            content: `Facts: ${JSON.stringify(facts)}`,
          },
        ],
      }),
    });
    if (!response.ok) return { ok: false, error: `http ${response.status}` };
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: "empty completion" };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "timeout" : "request failed" };
  } finally {
    clearTimeout(timer);
  }
}
