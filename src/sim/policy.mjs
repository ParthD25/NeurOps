import { CourierModel, PrepModel } from "./estimators.mjs";
import { STATIONS } from "./menu.mjs";

// The agent's whole decision is one number: when to start cooking. It is chosen
// by minimising expected cost over a grid of start times, where cost is seconds
// of food sitting plus five times seconds of courier waiting. Five is a stated
// assumption, not a discovered truth; it is exposed in the UI so a judge can
// disagree with it and see the policy change.

export const SIT_WEIGHT = 1;
export const LATE_WEIGHT = 5;

const HORIZON_SEC = 1500;
const OFFSET_STEP = 30;
const PREP_MIN_SEC = 20;
const DEADLINE_QUANTILE = 0.85;

// Fixed quantile grid: common random numbers across candidate start times keep
// the cost curve smooth and the run reproducible.
const Z = [
  -1.75, -1.4, -1.15, -0.95, -0.78, -0.62, -0.48, -0.35, -0.22, -0.1,
  0, 0.1, 0.22, 0.35, 0.48, 0.62, 0.78, 0.95, 1.15, 1.4, 1.75, -0.05, 0.05, 0.28,
];

const QUANTILE_Z = [
  [0.5, 0], [0.6, 0.253], [0.7, 0.524], [0.75, 0.674],
  [0.8, 0.842], [0.85, 1.036], [0.9, 1.282], [0.95, 1.645], [0.99, 2.326],
];

export const POLICY_IDS = ["asap", "promised", "fixed", "adaptive", "oracle"];

export const POLICY_LABELS = {
  asap: "Fire on arrival",
  promised: "Back-calc from promise",
  fixed: "Fixed 10-min buffer",
  adaptive: "Fireline (adaptive)",
  oracle: "Oracle (knows truth)",
};

function zFor(p) {
  const clamped = Math.min(0.99, Math.max(0.5, p));
  for (let i = 1; i < QUANTILE_Z.length; i += 1) {
    const [p1, z1] = QUANTILE_Z[i];
    if (clamped <= p1) {
      const [p0, z0] = QUANTILE_Z[i - 1];
      const t = (clamped - p0) / (p1 - p0);
      return z0 + (z1 - z0) * t;
    }
  }
  return QUANTILE_Z[QUANTILE_Z.length - 1][1];
}

// Prep time is positive and right-skewed. Sampling it as a clamped normal
// truncates the left tail and makes the agent think a ticket can appear in 30s,
// which biases every decision late. A lognormal keeps the mean while keeping
// short cooks plausible instead of free.
function samplePrep(mean, sd, z) {
  const safeMean = Math.max(PREP_MIN_SEC, mean);
  if (!Number.isFinite(sd) || sd <= 0.5) return safeMean;
  const cv = Math.max(0.02, sd / safeMean);
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  return Math.max(PREP_MIN_SEC, safeMean * Math.exp(sigma * z - 0.5 * sigma * sigma));
}

function prepQuantile(mean, sd, p) {
  const safeMean = Math.max(PREP_MIN_SEC, mean);
  if (!Number.isFinite(sd) || sd <= 0.5) return safeMean;
  const cv = Math.max(0.02, sd / safeMean);
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  return Math.max(PREP_MIN_SEC, safeMean * Math.exp(sigma * zFor(p) - 0.5 * sigma * sigma));
}

function riskFor({ fireAt, prepMean, prepSd, courierMean, courierSd }) {
  let cost = 0;
  let sitSum = 0;
  let lateSum = 0;
  let within = 0;
  for (let i = 0; i < Z.length; i += 1) {
    const prep = samplePrep(prepMean, prepSd, Z[i]);
    const ready = fireAt + prep;
    const arrive = courierMean + Z[(i * 7 + 3) % Z.length] * courierSd;
    const sit = Math.max(0, ready - arrive);
    const late = Math.max(0, arrive - ready);
    cost += sit * SIT_WEIGHT + late * LATE_WEIGHT;
    sitSum += sit;
    lateSum += late;
    if (Math.abs(ready - arrive) <= 60) within += 1;
  }
  return {
    cost: cost / Z.length,
    sitRiskSec: Math.round(sitSum / Z.length),
    lateRiskSec: Math.round(lateSum / Z.length),
    confidence: within / Z.length,
  };
}

function optimizeFire({ now, meanAt, prepSd, courierMean, courierSd }) {
  let best = null;
  for (let offset = 0; offset <= HORIZON_SEC; offset += OFFSET_STEP) {
    const prepMean = meanAt(offset);
    const risk = riskFor({ fireAt: now + offset, prepMean, prepSd, courierMean, courierSd });
    if (!best || risk.cost < best.cost - 1e-9) {
      best = { ...risk, offset, fireAt: now + offset, prepMean };
    }
  }
  return best;
}

// The queue you will join is not the queue you see. Waiting until the last
// moment means everyone else does too, and the backlog lands on you. This
// projects the station load at a candidate fire time: current work drains at one
// worker, plus every waiting ticket already planned to fire before then.
function projectedBacklog(engine, ticket, model, now, fireAt) {
  const horizon = Math.max(0, fireAt - now);
  const load = new Map(STATIONS.map((station) => [station, Math.max(0, engine.backlogSec(station) - horizon)]));
  for (const other of engine.tickets) {
    if (other === ticket || other.status !== "waiting") continue;
    const planned = other.plan?.fireAt;
    if (planned == null || planned > fireAt) continue;
    for (const item of other.items) {
      const current = load.get(item.station) ?? 0;
      load.set(item.station, current + model.estimate(item.itemId).meanSec);
    }
  }
  return load;
}

function ownLoad(ticket, model) {
  const perStation = new Map();
  let variance = 0;
  for (const item of ticket.items) {
    const estimate = model.estimate(item.itemId);
    const entry = perStation.get(item.station) ?? { meanSec: 0, varSec2: 0 };
    entry.meanSec += estimate.meanSec;
    entry.varSec2 += estimate.sdSec ** 2;
    perStation.set(item.station, entry);
  }
  for (const entry of perStation.values()) variance = Math.max(variance, entry.varSec2);
  return { perStation, sdSec: Math.sqrt(variance) };
}

export function createPolicy(id = "adaptive", { prepPrior = null } = {}) {
  if (!POLICY_IDS.includes(id)) throw new Error(`unknown policy: ${id}`);
  const prep = new PrepModel({ prior: prepPrior });
  const courier = new CourierModel();
  let seenCompleted = 0;
  let seenCouriers = 0;

  function sync(engine) {
    while (seenCompleted < engine.completedSamples.length) {
      const sample = engine.completedSamples[seenCompleted];
      prep.observe(sample.itemId, sample.serviceSec);
      seenCompleted += 1;
    }
    while (seenCouriers < engine.courierSamples.length) {
      const sample = engine.courierSamples[seenCouriers];
      courier.observe(sample.promisedSec, sample.actualSec);
      seenCouriers += 1;
    }
  }

  function baseForecast({ engine, ticket, now, oracle = false }) {
    const prepForecast = prep.forecastTicket(ticket, engine);
    const courierForecast = courier.forecast({ ticket, now, engine, oracle });
    return { prepForecast, courierForecast };
  }

  // A ticket is not one fire time. Each dish has its own cook time, and on a
  // shared station it also has to wait for the dishes ahead of it. So the ticket
  // fires station by station: the critical station starts at the chosen time,
  // faster stations start later, and every dish lands at (roughly) the same
  // moment. A steak and a fountain drink should not start together.
  function buildItemPlans({ ticket, fireAt, now, oracle = false, stagger = true }) {
    const groups = new Map();
    // Only dishes that have not started yet. Re-planning a dish that is already
    // on the station would place the next dish behind a phantom cook.
    for (const item of ticket.items.filter((entry) => entry.startedAt == null)) {
      const list = groups.get(item.station) ?? [];
      list.push(item);
      groups.set(item.station, list);
    }
    if (!groups.size) return [];
    const estimate = (item) => (oracle ? { meanSec: item.prepSec } : prep.estimate(item.itemId));
    const paths = new Map();
    for (const [station, items] of groups) {
      paths.set(station, items.reduce((sum, item) => sum + estimate(item).meanSec, 0));
    }
    const critical = Math.max(0, ...paths.values());
    const variance = Math.max(
      0,
      ...[...groups.values()].map((items) =>
        items.reduce((sum, item) => sum + (estimate(item).sdSec ?? 0) ** 2, 0),
      ),
    );
    const hasStarted = ticket.items.some((item) => item.startedAt != null);
    // Once part of the ticket is cooking, the remaining dishes still need a
    // landing time. Aim at the target, but pull it forward by the same 85th
    // percentile guard the ticket-level plan uses, otherwise every remaining
    // dish lands exactly on the promise and the queue pushes it late.
    const guard = oracle ? 0 : Math.max(0, prepQuantile(critical, Math.sqrt(variance), DEADLINE_QUANTILE) - critical);
    const target = ticket.courierEtaSec ?? fireAt + critical;
    const anchor = hasStarted ? Math.max(now + critical, target - guard) : fireAt + critical;
    const plans = [];
    for (const [station, items] of groups) {
      const stationStart = stagger ? anchor - paths.get(station) : fireAt;
      let cursor = stationStart;
      for (const item of items) {
        const mean = estimate(item).meanSec;
        const at = Math.max(now, cursor);
        plans.push({
          lineId: item.lineId,
          itemId: item.itemId,
          station,
          fireAt: Math.round(at),
          expectedReadyAt: Math.round(at + mean),
          prepMeanSec: Math.round(mean),
        });
        cursor = at + mean;
      }
    }
    return plans.sort((a, b) => a.fireAt - b.fireAt || a.lineId.localeCompare(b.lineId));
  }

  function packagePlan({ fireAt, prepMean, prepSd, courierForecast, risk, reason, backlogSec, criticalStation, items }) {
    return {
      policyId: id,
      items: items ?? [],
      fireAt: Math.round(items?.length ? Math.min(...items.map((entry) => entry.fireAt)) : fireAt),
      expectedReadyAt: Math.round(fireAt + prepMean),
      expectedCourierAt: Math.round(courierForecast.meanSec),
      prepMeanSec: Math.round(prepMean),
      prepSdSec: Math.round(prepSd),
      courierMeanSec: Math.round(courierForecast.meanSec),
      courierSdSec: Math.round(courierForecast.sdSec),
      criticalStation: criticalStation ?? null,
      backlogSec: Math.round(backlogSec ?? 0),
      sitRiskSec: risk.sitRiskSec,
      lateRiskSec: risk.lateRiskSec,
      confidence: Math.round(risk.confidence * 100) / 100,
      courierKnown: courierForecast.known,
      courierSource: courierForecast.source,
      reason,
    };
  }

  function plan({ engine, ticket, now }) {
    sync(engine);
    const { prepForecast, courierForecast } = baseForecast({ engine, ticket, now });
    const promised = ticket.promisedReadySec;
    const packSec = ticket.packSec ?? 20;

    if (id === "asap") {
      return packagePlan({
        fireAt: now,
        prepMean: prepForecast.meanSec,
        prepSd: prepForecast.sdSec,
        courierForecast,
        risk: { sitRiskSec: 0, lateRiskSec: 0, confidence: 0 },
        backlogSec: 0,
        criticalStation: prepForecast.criticalStation,
        items: buildItemPlans({ ticket, fireAt: now, now, stagger: false }),
        reason: "Fire on arrival. No pacing model, food waits for the courier.",
      });
    }

    if (id === "promised" || id === "fixed") {
      const buffer = id === "promised" ? prepForecast.meanSec : 600;
      const fireAt = Math.max(now, promised - buffer);
      const ready = fireAt + prepForecast.meanSec;
      const sit = Math.max(0, ready - courierForecast.meanSec);
      const late = Math.max(0, courierForecast.meanSec - ready);
      return packagePlan({
        fireAt,
        prepMean: prepForecast.meanSec,
        prepSd: prepForecast.sdSec,
        courierForecast,
        risk: { sitRiskSec: Math.round(sit), lateRiskSec: Math.round(late), confidence: 0 },
        backlogSec: 0,
        criticalStation: prepForecast.criticalStation,
        items: buildItemPlans({ ticket, fireAt: Math.max(now, fireAt), now }),
        reason:
          id === "promised"
            ? "Work backwards from the promised time using mean prep; ignores variance and queue."
            : "Fixed ten-minute buffer before the promise; ignores the actual ticket.",
      });
    }

    if (id === "oracle") {
      const trueMeanAt = (offset) => {
        const fireAt = now + offset;
        const load = new Map(
          STATIONS.map((station) => [station, Math.max(0, engine.backlogSec(station) - Math.max(0, fireAt - now))]),
        );
        for (const other of engine.tickets) {
          if (other === ticket || other.status !== "waiting") continue;
          const planned = other.plan?.fireAt;
          if (planned == null || planned > fireAt) continue;
          for (const item of other.items) {
            load.set(item.station, (load.get(item.station) ?? 0) + item.prepSec);
          }
        }
        const own = new Map();
        for (const item of ticket.items) {
          own.set(item.station, (own.get(item.station) ?? 0) + item.prepSec);
        }
        let critical = 0;
        let backlog = 0;
        for (const [station, secs] of own) {
          critical = Math.max(critical, secs + (load.get(station) ?? 0));
          backlog = Math.max(backlog, load.get(station) ?? 0);
        }
        return { meanSec: critical + packSec, backlogSec: backlog };
      };
      const trueCourier = ticket.courierEtaSec ?? courierForecast.meanSec;
      const best = optimizeFire({
        now,
        meanAt: (offset) => trueMeanAt(offset).meanSec,
        prepSd: 30,
        courierMean: trueCourier,
        courierSd: 30,
      });
      const truth = trueMeanAt(best.offset);
      return packagePlan({
        fireAt: best.fireAt,
        prepMean: truth.meanSec,
        prepSd: 30,
        courierForecast: { ...courierForecast, meanSec: trueCourier, sdSec: 30, known: true },
        risk: best,
        backlogSec: truth.backlogSec,
        criticalStation: null,
        items: buildItemPlans({ ticket, fireAt: best.fireAt, now, oracle: true }),
        reason: "Upper bound: real prep durations, real courier arrival, real queue.",
      });
    }

    const own = ownLoad(ticket, prep);
    const meanAt = (offset) => {
      const fireAt = now + offset;
      const load = projectedBacklog(engine, ticket, prep, now, fireAt);
      let critical = 0;
      let backlog = 0;
      for (const [station, entry] of own.perStation) {
        const stationBacklog = load.get(station) ?? 0;
        backlog = Math.max(backlog, stationBacklog);
        critical = Math.max(critical, entry.meanSec + stationBacklog);
      }
      return { meanSec: critical + packSec, backlogSec: backlog };
    };

    // When the kitchen is already over capacity, waiting is pure loss: every
    // queued ticket ahead of you adds its full prep time to your ready time.
    // Fire now instead of pretending a later start can be absorbed.
    const nowForecast = meanAt(0);
    const timeToCourier = courierForecast.meanSec - now;
    const criticalStation = prepForecast.criticalStation;
    const backlogAtCritical = criticalStation ? engine.backlogSec(criticalStation) : 0;
    if (nowForecast.meanSec + 60 >= timeToCourier) {
      const risk = riskFor({
        fireAt: now,
        prepMean: nowForecast.meanSec,
        prepSd: own.sdSec,
        courierMean: courierForecast.meanSec,
        courierSd: courierForecast.sdSec,
      });
      return packagePlan({
        fireAt: now,
        prepMean: nowForecast.meanSec,
        prepSd: own.sdSec,
        courierForecast,
        risk,
        backlogSec: nowForecast.backlogSec,
        criticalStation,
        items: buildItemPlans({ ticket, fireAt: now, now }),
        reason: "No slack left: the critical station starts now, and faster dishes are still held back so they land with it.",
      });
    }

    const optimal = optimizeFire({
      now,
      meanAt: (offset) => meanAt(offset).meanSec,
      prepSd: own.sdSec,
      courierMean: courierForecast.meanSec,
      courierSd: courierForecast.sdSec,
    });

    // Deadline guard: do not start so late that even an 85th-percentile cook
    // misses the courier. The cost optimum can be greedy under congestion; this
    // caps the damage without turning the board into fire-everything.
    const gatePrep = prepQuantile(optimal.prepMean, own.sdSec, DEADLINE_QUANTILE);
    const latestSafeFireAt = courierForecast.meanSec - gatePrep;
    const gatedFireAt = Math.max(now, Math.min(optimal.fireAt, latestSafeFireAt));
    const offset = Math.max(0, Math.min(HORIZON_SEC, Math.round((gatedFireAt - now) / OFFSET_STEP) * OFFSET_STEP));
    const finalFireAt = now + offset;
    const finalMean = meanAt(offset);
    const risk = riskFor({
      fireAt: finalFireAt,
      prepMean: finalMean.meanSec,
      prepSd: own.sdSec,
      courierMean: courierForecast.meanSec,
      courierSd: courierForecast.sdSec,
    });

    const minutes = (sec) => `${Math.round(sec / 60)}m`;
    const gated = finalFireAt < optimal.fireAt - 1;
    const reason = [
      `Prep ${minutes(finalMean.meanSec)} ± ${minutes(own.sdSec)}`,
      finalMean.backlogSec > 0 ? `(includes ${minutes(finalMean.backlogSec)} projected backlog)` : "(no backlog).",
      `Courier ${courierForecast.known ? "assigned" : "estimated"}.`,
      `Firing now risks ~${risk.sitRiskSec}s sitting vs ~${risk.lateRiskSec}s waiting.`,
      gated ? "Deadline guard moved the start earlier." : "Cost optimum is inside the deadline guard.",
    ].join(" ");

    return packagePlan({
      fireAt: finalFireAt,
      prepMean: finalMean.meanSec,
      prepSd: own.sdSec,
      courierForecast,
      risk,
      backlogSec: finalMean.backlogSec,
      criticalStation: prepForecast.criticalStation,
      items: buildItemPlans({ ticket, fireAt: finalFireAt, now }),
      reason,
    });
  }

  return {
    id,
    label: POLICY_LABELS[id],
    plan,
    sync,
    models: () => ({ prep, courier }),
    weights: { sit: SIT_WEIGHT, late: LATE_WEIGHT },
  };
}
