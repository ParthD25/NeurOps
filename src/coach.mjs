// The model is an analyst, never the expediter. It receives measured facts:
// per-server lag, outage remakes, online-order holding time, at-risk tickets.
// It may phrase advice; it may not invent numbers, delete an order, or mark a
// ticket complete. Those guards are enforced after the response, not requested
// politely in the prompt.

const FORBIDDEN = /(delete|remove)\s+(the\s+)?(order|ticket)|mark\s+(it|them|the\s+(order|ticket))\s+(as\s+)?complete|auto[- ]?complete|clear\s+(all|the)\s+(orders|tickets)|discard\s+(the\s+)?(order|ticket)/i;

function collectNumbers(value, allowed = new Set()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    allowed.add(String(Math.abs(value)));
    allowed.add(String(Math.round(Math.abs(value))));
  } else if (Array.isArray(value)) {
    for (const entry of value) collectNumbers(entry, allowed);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectNumbers(entry, allowed);
  }
  return allowed;
}

export function buildCoachFacts({ result }) {
  const m = result.metrics;
  const waiters = result.waiterStats ?? [];
  const risky = result.tickets
    .filter((ticket) => ticket.status !== "handed_off" && ticket.status !== "blocked" && (ticket.plan?.lateRiskSec ?? 0) > 90)
    .slice(0, 6)
    .map((ticket) => ({
      id: ticket.id,
      table: ticket.tableNo ?? null,
      waiter: ticket.waiterName ?? null,
      dishCount: ticket.items.length,
      lateRiskSec: ticket.plan?.lateRiskSec ?? 0,
    }));
  const nextFires = result.tickets
    .flatMap((ticket) => (ticket.plan?.items ?? []).map((item) => ({ ticket: ticket.id, table: ticket.tableNo ?? null, item: item.itemId, fireAt: item.fireAt })))
    .sort((a, b) => a.fireAt - b.fireAt)
    .slice(0, 8);
  return {
    scenario: result.scenarioTitle,
    policy: result.policyLabel,
    onTimePct: m.onTimePct,
    avgSitSec: m.avgSitSec,
    avgLateSec: m.avgLateSec,
    p90LateSec: m.p90LateSec,
    stalled: m.stalled,
    remade: m.remade,
    unfinished: m.unfinished,
    waiters,
    risky,
    nextFires,
    onlineOrders: m.tickets,
    network: result.network?.summary ?? null,
  };
}

export function buildCoachBrief(facts) {
  const slowest = [...(facts.waiters ?? [])].sort((a, b) => b.avgLagSec - a.avgLagSec)[0];
  const lines = [
    `${facts.scenario}: ${facts.onTimePct}% on time, online food held ${facts.avgSitSec}s, couriers waited ${facts.avgLateSec}s.`,
  ];
  if (facts.waiters?.length) {
    lines.push(
      `${facts.waiters.length} servers tracked; ${slowest.name} is slowest at ${slowest.avgLagSec}s from pass to table (${slowest.lateCourses} late courses).`,
    );
  }
  if (facts.remade > 0 || facts.stalled > 0) {
    lines.push(`${facts.remade} dish(es) remade after an outage; ${facts.stalled} ticket(s) still stalled and not counted as served.`);
  }
  if (facts.risky?.length) {
    const top = facts.risky[0];
    lines.push(`Highest current risk: ${top.id}${top.waiter ? ` for ${top.waiter}` : ""} with ${top.lateRiskSec}s of projected lateness.`);
  }
  if (facts.network?.steps) {
    lines.push(
      `The shadow neural network trained on ${facts.network.steps} finished dishes: prep error ${facts.network.firstTenMaeSec}s over its first ten, ${facts.network.lastTenMaeSec}s over its last ten, against ${facts.network.menuOnlyMaeSec}s for the menu alone.`,
    );
  }
  lines.push("Advice is advisory only: the deterministic scheduler keeps firing, and no ticket is finished until every dish is done.");
  return lines.join(" ");
}

export function guardCoach(text, facts) {
  const forbidden = FORBIDDEN.test(text);
  const allowed = collectNumbers(facts);
  const unknown = [...new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).filter((number) => !allowed.has(number)))];
  return { ok: !forbidden && unknown.length === 0, forbidden, unknown };
}

export async function llmCoach({
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
        temperature: 0.3,
        max_tokens: 240,
        messages: [
          {
            role: "system",
            content:
              "You are an expo analyst for a restaurant. Use ONLY the facts JSON. Write three short sentences: which server or station is the bottleneck, which online orders are at risk of sitting, and one timing adjustment to try next. Never invent numbers. Never instruct anyone to delete an order, clear tickets, or mark food complete. You cannot change the schedule; you advise the expediter.",
          },
          { role: "user", content: `Facts: ${JSON.stringify(facts)}` },
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
