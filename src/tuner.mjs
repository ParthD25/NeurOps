// The network agent. While the shift runs, it reads the network's recent
// errors and proposes changes to the network itself: the learning rate, the
// output bias, or a per-item correction on one skip weight.
//
// Two agents share one contract:
//   - an LLM via OpenRouter, when a key is supplied;
//   - a rule agent, always available, used offline and as the fallback.
//
// Every proposal goes through the same guard before it touches a weight:
// values are clamped to LIMITS, unknown items are dropped, and the change is
// tried on a copy of the live network and scored on the newest finished
// dishes, which the proposal was not built from. It is applied only if it
// lowers error on those held-out dishes by a real margin.

import { LIMITS, INPUTS, SCALE, trainShadow } from "./sim/nn.mjs";
import { menuName } from "./sim/menu.mjs";

const WINDOW = 12; // dishes the agent reads
const CHECK = 6; // newest dishes held out to judge the proposal
const MARGIN_SEC = 1;

const round = (value) => Math.round(value);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

export function buildTuneFacts({ samples, interventions = [], atSec, learningRate }) {
  const run = trainShadow(samples, { interventions, stopAtSec: atSec, learningRate });
  // The agent reads everything except the newest CHECK dishes; those are
  // kept back so the judge can score the proposal on data it never saw.
  const steps = run.steps.slice(0, Math.max(0, run.steps.length - CHECK));
  const recent = steps.slice(-WINDOW);
  const before = steps.slice(-WINDOW * 2, -WINDOW);
  const perItem = new Map();
  for (const step of steps.slice(-WINDOW * 2)) {
    const entry = perItem.get(step.itemId) ?? { itemId: step.itemId, name: menuName(step.itemId), errors: [] };
    entry.errors.push(step.errSec);
    perItem.set(step.itemId, entry);
  }
  return {
    run,
    facts: {
      atSec: round(atSec),
      dishesSeen: steps.length,
      learningRate: run.net.learningRate,
      outputBiasSec: round(run.net.b2 * SCALE),
      recentMaeSec: round(mean(recent.map((step) => Math.abs(step.errSec)))),
      previousMaeSec: before.length ? round(mean(before.map((step) => Math.abs(step.errSec)))) : null,
      recentMeanErrorSec: round(mean(recent.map((step) => step.errSec))),
      items: [...perItem.values()]
        .filter((entry) => entry.errors.length >= 2)
        .map((entry) => ({
          itemId: entry.itemId,
          name: entry.name,
          samples: entry.errors.length,
          meanErrorSec: round(mean(entry.errors)),
        })),
      changesSoFar: interventions.length,
      limits: LIMITS,
      errorSign: "error = predicted minus actual seconds; positive means the network predicts too slow",
    },
  };
}

// Deterministic agent: the same levers an LLM gets, chosen by plain rules.
export function ruleProposal(facts) {
  const proposal = { reason: "" };
  const reasons = [];
  if (facts.dishesSeen < 6) return { reason: "Too few finished dishes to judge yet." };
  const items = {};
  for (const item of facts.items) {
    if (item.samples >= 4 && Math.abs(item.meanErrorSec) >= 20) {
      items[item.itemId] = round(-item.meanErrorSec * 0.5);
      reasons.push(`${item.name} is off by ${item.meanErrorSec}s over ${item.samples} dishes`);
    }
  }
  if (Object.keys(items).length) proposal.itemBiasSec = items;
  else if (Math.abs(facts.recentMeanErrorSec) >= 10) {
    proposal.outputBiasSec = round(-facts.recentMeanErrorSec * 0.5);
    reasons.push(`predictions lean ${facts.recentMeanErrorSec > 0 ? "slow" : "fast"} by ${Math.abs(facts.recentMeanErrorSec)}s`);
  }
  if (facts.previousMaeSec != null) {
    if (facts.recentMaeSec > facts.previousMaeSec * 1.15) {
      proposal.learningRate = Math.max(LIMITS.learningRate[0], facts.learningRate * 0.6);
      reasons.push(`error rose from ${facts.previousMaeSec}s to ${facts.recentMaeSec}s, so learn more cautiously`);
    }
  }
  proposal.reason = reasons.length ? `${reasons.join("; ")}.` : "Network is tracking the kitchen; no change.";
  return proposal;
}

// Turns any proposal (LLM text already parsed, or the rule agent's) into a
// clean change: numbers only, clamped, known items only.
export function sanitizeProposal(raw) {
  const clean = {};
  const notes = [];
  if (!raw || typeof raw !== "object") return { change: clean, notes: ["proposal was not an object"] };
  if (raw.learningRate != null) {
    const lr = Number(raw.learningRate);
    if (Number.isFinite(lr)) {
      clean.learningRate = Math.min(LIMITS.learningRate[1], Math.max(LIMITS.learningRate[0], lr));
      if (clean.learningRate !== lr) notes.push(`learning rate clamped to ${clean.learningRate}`);
    } else notes.push("learning rate was not a number");
  }
  if (raw.outputBiasSec != null) {
    const sec = Number(raw.outputBiasSec);
    if (Number.isFinite(sec)) clean.outputBiasSec = Math.max(-LIMITS.outputBiasSec, Math.min(LIMITS.outputBiasSec, sec));
    else notes.push("output bias was not a number");
  }
  if (raw.itemBiasSec && typeof raw.itemBiasSec === "object") {
    const items = {};
    for (const [itemId, value] of Object.entries(raw.itemBiasSec)) {
      const sec = Number(value);
      if (!INPUTS.includes(itemId)) notes.push(`unknown item ${String(itemId).slice(0, 24)} dropped`);
      else if (!Number.isFinite(sec)) notes.push(`${itemId} correction was not a number`);
      else items[itemId] = Math.max(-LIMITS.itemBiasSec, Math.min(LIMITS.itemBiasSec, sec));
    }
    if (Object.keys(items).length) clean.itemBiasSec = items;
  }
  return { change: clean, notes };
}

function maeOn(net, steps) {
  if (!steps.length) return null;
  return mean(steps.map((step) => Math.abs(net.predict(step.itemId) - step.actualSec)));
}

// Tries the change on a copy of the live network and scores both on the
// dishes that have already finished. Learning-rate changes cannot be scored on
// the past, so they are accepted inside LIMITS and say so.
export function judgeProposal(run, change) {
  const recent = run.steps.slice(-CHECK);
  const before = maeOn(run.net, recent);
  const trial = run.net.clone();
  trial.apply(change);
  const after = maeOn(trial, recent);
  const touchesWeights = change.outputBiasSec != null || change.itemBiasSec != null;
  const hasChange = touchesWeights || change.learningRate != null;
  if (!hasChange) return { accepted: false, beforeMaeSec: round(before ?? 0), afterMaeSec: round(after ?? 0), verdict: "no change proposed" };
  if (touchesWeights && (before == null || after > before - MARGIN_SEC)) {
    return {
      accepted: false,
      beforeMaeSec: round(before ?? 0),
      afterMaeSec: round(after ?? 0),
      verdict: "rejected: it did not lower error on the newest finished dishes",
    };
  }
  return {
    accepted: true,
    beforeMaeSec: round(before ?? 0),
    afterMaeSec: round(after ?? 0),
    verdict: touchesWeights ? "applied: lower error on the newest finished dishes" : "applied: learning-rate change, judged as more dishes finish",
  };
}

export function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function llmProposal({
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
        "X-Title": "Fireline network agent",
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 260,
        messages: [
          {
            role: "system",
            content:
              "You tune a small online neural network that predicts restaurant prep times while a shift runs. " +
              "Reply with ONLY a JSON object, no prose outside it. Allowed keys: " +
              '"learningRate" (number), "outputBiasSec" (number, seconds added to every prediction), ' +
              '"itemBiasSec" (object of itemId -> seconds added to that item\'s prediction), "reason" (one short sentence). ' +
              "Error is predicted minus actual: if an item's meanErrorSec is +30, predictions are 30s too slow, so a correction near -30 helps. " +
              "Stay inside the limits in the facts. Omit a key to leave it unchanged. If nothing should change, return {\"reason\": \"...\"}.",
          },
          { role: "user", content: `Facts: ${JSON.stringify(facts)}` },
        ],
      }),
    });
    if (!response.ok) return { ok: false, error: `http ${response.status}` };
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content?.trim();
    const parsed = parseJsonObject(text);
    if (!parsed) return { ok: false, error: "reply was not a JSON object" };
    return { ok: true, proposal: parsed };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "timeout" : "request failed" };
  } finally {
    clearTimeout(timer);
  }
}

// One agent turn: facts -> proposal (LLM or rules) -> sanitize -> judge.
// Returns the decision and, if accepted, the intervention to replay.
export async function tuneNetwork({ samples, interventions = [], atSec, apiKey, model, fetchImpl }) {
  const { run, facts } = buildTuneFacts({ samples, interventions, atSec });
  let source = "rules";
  let note = apiKey ? null : "No model key supplied, so the rule agent proposed this change.";
  let raw = null;
  if (apiKey) {
    const llm = await llmProposal({ facts, apiKey, model, fetchImpl });
    if (llm.ok) {
      raw = llm.proposal;
      source = "llm";
    } else {
      note = `Model unavailable (${llm.error}). The rule agent proposed this change instead.`;
    }
  }
  if (!raw) raw = ruleProposal(facts);
  const { change, notes } = sanitizeProposal(raw);
  const judged = judgeProposal(run, change);
  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 280) : "";
  const decision = {
    atSec: round(atSec),
    source,
    model: source === "llm" ? model : null,
    reason,
    change,
    notes,
    ...judged,
  };
  const intervention = judged.accepted ? { atSec, ...change, source } : null;
  return { decision, intervention, facts, note };
}
