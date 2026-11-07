import { itemById } from "./menu.mjs";
import { clamp } from "./rng.mjs";

// Two tiny online models. Neither is deep learning, and that is the point: each
// one has an inspectable prior, an update rule you can say out loud, and a
// failure mode you can demonstrate (cold start, regime change, selection bias).

const PRIOR_STRENGTH = 2;

export class PrepModel {
  constructor({ priorStrength = PRIOR_STRENGTH } = {}) {
    this.priorStrength = priorStrength;
    this.stats = new Map();
  }

  seed(itemId) {
    const item = itemById(itemId);
    return {
      n: 0,
      mean: item.medianSec,
      m2: 0,
      priorMean: item.medianSec,
      priorVar: (item.medianSec * item.cv) ** 2,
    };
  }

  observe(itemId, serviceSec) {
    if (!Number.isFinite(serviceSec) || serviceSec <= 0) return;
    const entry = this.stats.get(itemId) ?? this.seed(itemId);
    const n = entry.n + 1;
    const delta = serviceSec - entry.mean;
    entry.mean += delta / n;
    entry.m2 += delta * (serviceSec - entry.mean);
    entry.n = n;
    this.stats.set(itemId, entry);
  }

  estimate(itemId) {
    const item = itemById(itemId);
    const entry = this.stats.get(itemId) ?? this.seed(itemId);
    const n0 = this.priorStrength;
    const total = n0 + entry.n;
    const mean = (n0 * entry.priorMean + entry.n * entry.mean) / total;
    const variance = (n0 * entry.priorVar + entry.m2) / total;
    return {
      meanSec: mean,
      sdSec: Math.sqrt(Math.max(120, variance)),
      samples: entry.n,
      source: entry.n === 0 ? "prior" : "learned",
      priorMeanSec: item.medianSec,
    };
  }

  forecastTicket(ticket, engine) {
    const byStation = new Map();
    for (const item of ticket.items) {
      const est = this.estimate(item.itemId);
      const entry = byStation.get(item.station) ?? { station: item.station, meanSec: 0, varSec2: 0, items: 0, backlogSec: 0 };
      entry.meanSec += est.meanSec;
      entry.varSec2 += est.sdSec ** 2;
      entry.items += 1;
      byStation.set(item.station, entry);
    }
    for (const entry of byStation.values()) {
      entry.backlogSec = engine ? engine.backlogSec(entry.station) : 0;
      entry.meanSec += entry.backlogSec;
      entry.sdSec = Math.sqrt(entry.varSec2);
    }
    let critical = { station: null, meanSec: 0, sdSec: 0 };
    for (const entry of byStation.values()) {
      if (entry.meanSec > critical.meanSec) critical = entry;
    }
    const packSec = ticket.packSec ?? 20;
    return {
      meanSec: critical.meanSec + packSec,
      sdSec: clamp(critical.sdSec, 20, 900),
      criticalStation: critical.station,
      perStation: [...byStation.values()],
      packSec,
    };
  }
}

export class CourierModel {
  constructor({ biasSec = 0, absErrorSec = 120, n = 0, alpha = 0.25 } = {}) {
    this.biasSec = biasSec;
    this.absErrorSec = absErrorSec;
    this.n = n;
    this.alpha = alpha;
  }

  observe(promisedSec, actualSec) {
    if (!Number.isFinite(promisedSec) || !Number.isFinite(actualSec)) return;
    const residual = actualSec - promisedSec;
    const rate = this.n === 0 ? 1 : this.alpha;
    this.biasSec = this.biasSec + rate * (residual - this.biasSec);
    this.absErrorSec = this.absErrorSec + rate * (Math.abs(residual) - this.absErrorSec);
    this.n += 1;
  }

  forecast({ ticket, now, engine, oracle = false }) {
    const packSec = ticket.packSec ?? 20;
    const estimate = engine ? engine.courierEstimate(ticket, now) : { known: false, etaSec: null };
    const known = oracle ? ticket.courierEtaSec != null : estimate.known;
    const etaSec = oracle ? ticket.courierEtaSec : estimate.etaSec;
    if (known && etaSec != null) {
      return {
        meanSec: etaSec,
        sdSec: 30,
        known: true,
        source: "courier-assigned",
        confidenceLabel: "courier assigned",
        packSec,
      };
    }
    const sd = clamp(this.absErrorSec * 1.4, 90, 480);
    return {
      meanSec: ticket.promisedReadySec + this.biasSec,
      sdSec: sd,
      known: false,
      source: this.n === 0 ? "promise-only" : "promise + learned bias",
      confidenceLabel: this.n === 0 ? "no courier data yet" : `bias ${Math.round(this.biasSec)}s, n=${this.n}`,
      packSec,
    };
  }
}
