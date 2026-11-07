import { STATIONS } from "./menu.mjs";

// One worker per station, FIFO queue, exact completion timestamps. The engine is
// deliberately dumb: it executes fire decisions and reports what happened. All
// judgement lives in the policy, so a policy bug cannot hide inside the sim.

const EPS = 1e-9;

export class Engine {
  constructor({ scenario, policy, stepSec = 2, decisionEverySec = 4 }) {
    if (!scenario) throw new Error("scenario required");
    if (!policy) throw new Error("policy required");
    this.scenario = scenario;
    this.policy = policy;
    this.stepSec = stepSec;
    this.decisionEverySec = decisionEverySec;
    this.now = 0;
    this.nextDecisionAt = 0;
    this.events = [];
    this.duplicates = [];
    this.byId = new Map();
    this.tickets = [];
    this.stations = new Map(STATIONS.map((name) => [name, { current: null, queue: [] }]));
    this.courierSamples = [];
    this.completedSamples = [];
    this.blockedAtArrival = 0;

    const seen = new Set();
    for (const raw of scenario.tickets) {
      if (seen.has(raw.id)) {
        this.duplicates.push(raw.id);
        continue;
      }
      seen.add(raw.id);
      const ticket = {
        ...raw,
        items: raw.items.map((item) => ({
          ...item,
          course: item.course ?? 0,
          doneAt: null,
          startedAt: null,
          fireAt: null,
        })),
        status: "scheduled",
        fireAt: null,
        readyAt: null,
        handoffAt: null,
        blockedReason: null,
        plan: null,
        manual: false,
        itemsDone: 0,
        lastItemDoneAt: null,
      };
      this.byId.set(ticket.id, ticket);
      this.tickets.push(ticket);
    }
  }

  station(name) {
    const station = this.stations.get(name);
    if (!station) throw new Error(`unknown station: ${name}`);
    return station;
  }

  stationOutage(name, atSec) {
    for (const outage of this.scenario.stationOutages ?? []) {
      if (outage.station !== name) continue;
      const end = outage.toSec ?? Infinity;
      if (atSec >= outage.fromSec && atSec < end) return outage;
    }
    return null;
  }

  backlogSec(name) {
    const station = this.station(name);
    let total = station.current?.remainingSec ?? 0;
    for (const item of station.queue) total += item.remainingSec;
    return total;
  }

  stationSnapshot() {
    const out = {};
    for (const [name, station] of this.stations) {
      out[name] = {
        current: station.current ? { itemId: station.current.itemId, ticketId: station.current.ticketId, remainingSec: station.current.remainingSec } : null,
        queued: station.queue.map((item) => ({ itemId: item.itemId, ticketId: item.ticketId, remainingSec: item.remainingSec })),
      };
    }
    return out;
  }

  isUnavailable(itemId) {
    return this.scenario.unavailable.includes(itemId);
  }

  courierEstimate(ticket, now) {
    if (ticket.courierEtaSec == null) return { known: false, etaSec: null };
    if (ticket.courierKnownAtSec <= now) return { known: true, etaSec: ticket.courierEtaSec };
    return { known: false, etaSec: null };
  }

  ticketPreview(ticket) {
    return {
      id: ticket.id,
      arrivalSec: ticket.arrivalSec,
      promisedReadySec: ticket.promisedReadySec,
      courierEtaSec: ticket.courierEtaSec,
      courierKnownAtSec: ticket.courierKnownAtSec,
      customerName: ticket.customerName,
      channel: ticket.channel,
      note: ticket.note,
      kind: ticket.kind ?? "delivery",
      tableNo: ticket.tableNo ?? null,
      partySize: ticket.partySize ?? null,
      courseIndex: ticket.courseIndex ?? 0,
      courseLabel: ticket.courseLabel ?? null,
      items: ticket.items.map((item) => ({
        lineId: item.lineId,
        itemId: item.itemId,
        prepSec: item.prepSec,
        station: item.station,
        course: item.course ?? 0,
        startedAt: item.startedAt,
        fireAt: item.fireAt,
        doneAt: item.doneAt,
      })),
    };
  }

  fire(ticketId, { manual = false, reason = "" } = {}) {
    const ticket = this.byId.get(ticketId);
    if (!ticket) return { ok: false, error: `unknown ticket ${ticketId}` };
    if (ticket.status !== "waiting") return { ok: false, error: `ticket ${ticketId} is ${ticket.status}` };
    if (ticket.items.length === 0) {
      ticket.status = "blocked";
      ticket.blockedReason = "Ticket has no items";
      this.events.push({ t: this.now, type: "blocked", ticketId, reason: ticket.blockedReason });
      return { ok: false, error: ticket.blockedReason };
    }
    const blockedItem = ticket.items.find((item) => this.isUnavailable(item.itemId));
    if (blockedItem) {
      ticket.status = "blocked";
      ticket.blockedReason = `86'd item: ${blockedItem.itemId}`;
      this.events.push({ t: this.now, type: "blocked", ticketId, reason: ticket.blockedReason });
      return { ok: false, error: ticket.blockedReason };
    }

    ticket.manual = manual;
    ticket.fireReason = reason;
    for (const item of ticket.items) this.startItem(ticket, item);
    return { ok: true };
  }

  startItem(ticket, item) {
    if (item.startedAt != null) return false;
    const station = this.station(item.station);
    station.queue.push({
      ticketId: ticket.id,
      lineId: item.lineId,
      itemId: item.itemId,
      prepSec: item.prepSec,
      remainingSec: item.prepSec,
    });
    item.startedAt = this.now;
    item.fireAt = this.now;
    if (ticket.fireAt == null) {
      ticket.fireAt = this.now;
      this.events.push({ t: this.now, type: "fire", ticketId: ticket.id, manual: ticket.manual, reason: ticket.fireReason ?? "" });
    }
    ticket.status = "cooking";
    this.events.push({ t: this.now, type: "start", ticketId: ticket.id, lineId: item.lineId, itemId: item.itemId });
    return true;
  }

  completeItem(completed, atSec) {
    const ticket = this.byId.get(completed.ticketId);
    if (!ticket) return;
    const item = ticket.items.find((entry) => entry.lineId === completed.lineId);
    if (item && item.doneAt == null) {
      item.doneAt = atSec;
      ticket.itemsDone += 1;
      ticket.lastItemDoneAt = Math.max(ticket.lastItemDoneAt ?? 0, atSec);
      this.completedSamples.push({ itemId: completed.itemId, serviceSec: completed.prepSec });
    }
  }

  advanceStation(name, dt, startAt) {
    const station = this.station(name);
    // A dead station does not finish the dish in front of it. The item stays in
    // `current` with its remaining time frozen, and the ticket stalls.
    if (this.stationOutage(name, startAt)) return;
    let cursor = startAt;
    let left = dt;
    let guard = 0;
    while (left > EPS && guard < 500) {
      guard += 1;
      if (!station.current) {
        station.current = station.queue.shift() ?? null;
        if (!station.current) break;
        station.current.startedAt = cursor;
      }
      const current = station.current;
      const use = Math.min(left, current.remainingSec);
      current.remainingSec -= use;
      cursor += use;
      left -= use;
      if (current.remainingSec <= EPS) {
        station.current = null;
        this.completeItem(current, cursor);
      }
    }
  }

  detectStalls() {
    for (const ticket of this.tickets) {
      if (ticket.status !== "cooking" && ticket.status !== "stalled") continue;
      let stalling = false;
      for (const item of ticket.items) {
        if (item.startedAt == null || item.doneAt != null) continue;
        const limit = Math.max(180, item.prepSec * 3 + 120);
        if (this.now - item.startedAt > limit) {
          if (!item.stalled) {
            item.stalled = true;
            this.events.push({ t: this.now, type: "stalled", ticketId: ticket.id, lineId: item.lineId, station: item.station });
          }
          stalling = true;
        }
      }
      if (stalling) {
        ticket.stalled = true;
        ticket.stalledAt = ticket.stalledAt ?? this.now;
        ticket.stallReason = `Item stalled on ${ticket.items.find((item) => item.stalled && item.doneAt == null)?.station ?? "station"}`;
        ticket.status = "stalled";
      } else if (ticket.status === "stalled") {
        ticket.status = "cooking";
      }
    }
  }

  markArrivals(upTo) {
    for (const ticket of this.tickets) {
      if (ticket.status !== "scheduled" || ticket.arrivalSec > upTo) continue;
      this.events.push({ t: ticket.arrivalSec, type: "arrive", ticketId: ticket.id });
      const blocked = ticket.items.find((item) => this.isUnavailable(item.itemId));
      if (ticket.items.length === 0) {
        ticket.status = "blocked";
        ticket.blockedReason = "Ticket has no items";
        this.events.push({ t: ticket.arrivalSec, type: "blocked", ticketId: ticket.id, reason: ticket.blockedReason });
        this.blockedAtArrival += 1;
        continue;
      }
      if (blocked) {
        ticket.status = "blocked";
        ticket.blockedReason = `86'd item: ${blocked.itemId}`;
        this.events.push({ t: ticket.arrivalSec, type: "blocked", ticketId: ticket.id, reason: ticket.blockedReason });
        this.blockedAtArrival += 1;
        continue;
      }
      ticket.status = "waiting";
    }
  }

  markReady() {
    for (const ticket of this.tickets) {
      if (ticket.status !== "cooking" && ticket.status !== "stalled") continue;
      if (ticket.itemsDone !== ticket.items.length) continue;
      if (ticket.readyAt == null) {
        ticket.readyAt = (ticket.lastItemDoneAt ?? this.now) + ticket.packSec;
      }
      if (this.now + EPS >= ticket.readyAt) {
        ticket.status = "ready";
        this.events.push({ t: ticket.readyAt, type: "ready", ticketId: ticket.id });
      }
    }
  }

  markHandoffs() {
    for (const ticket of this.tickets) {
      if (ticket.status !== "ready") continue;
      if (ticket.courierEtaSec == null) continue;
      const handoffAt = Math.max(ticket.readyAt, ticket.courierEtaSec);
      if (this.now + EPS < handoffAt) continue;
      ticket.status = "handed_off";
      ticket.handoffAt = handoffAt;
      this.courierSamples.push({
        promisedSec: ticket.promisedReadySec,
        actualSec: ticket.courierEtaSec,
      });
      this.events.push({ t: handoffAt, type: "handoff", ticketId: ticket.id });
    }
  }

  maybeDecide() {
    if (this.now + EPS < this.nextDecisionAt) return;
    this.nextDecisionAt = this.now + this.decisionEverySec;
    for (const ticket of this.tickets) {
      if (ticket.status !== "waiting" && ticket.status !== "cooking") continue;
      if (!ticket.items.some((item) => item.startedAt == null)) continue;
      const plan = this.policy.plan({ engine: this, ticket, now: this.now });
      if (!plan || !Number.isFinite(plan.fireAt)) continue;
      ticket.plan = plan;
      this.events.push({
        t: this.now,
        type: "decision",
        ticketId: ticket.id,
        fireAt: plan.fireAt,
        expectedReadyAt: plan.expectedReadyAt,
        expectedCourierAt: plan.expectedCourierAt,
        confidence: plan.confidence,
        sitRiskSec: plan.sitRiskSec,
        lateRiskSec: plan.lateRiskSec,
        reason: plan.reason,
      });
      const planned = Array.isArray(plan.items) ? plan.items : [];
      for (const entry of planned) {
        if (entry.fireAt > this.now + EPS) continue;
        const item = ticket.items.find((candidate) => candidate.lineId === entry.lineId && candidate.startedAt == null);
        if (item) this.startItem(ticket, item);
      }
      // Back-compat for a policy that returns only a ticket-level fire time.
      if (!planned.length && this.now + EPS >= plan.fireAt) {
        for (const item of ticket.items.filter((candidate) => candidate.startedAt == null)) {
          this.startItem(ticket, item);
        }
      }
    }
  }

  step() {
    const start = this.now;
    const end = start + this.stepSec;
    this.now = end;
    for (const name of STATIONS) this.advanceStation(name, this.stepSec, start);
    this.detectStalls();
    this.markArrivals(end);
    this.markReady();
    this.markHandoffs();
    this.maybeDecide();
  }

  run({ tailSec = 1800 } = {}) {
    const limit = this.scenario.durationSec + tailSec;
    let guard = 0;
    while (this.now < limit && guard < 200000) {
      this.step();
      guard += 1;
    }
    return this.result();
  }

  metrics() {
    const handed = this.tickets.filter((t) => t.status === "handed_off");
    const sits = handed.map((t) => Math.max(0, t.courierEtaSec - t.readyAt));
    const lates = handed.map((t) => Math.max(0, t.readyAt - t.courierEtaSec));
    const waits = this.tickets.filter((t) => t.fireAt != null).map((t) => Math.max(0, t.fireAt - t.arrivalSec));
    const readyErrors = this.tickets
      .filter((t) => t.readyAt != null && t.plan?.expectedReadyAt != null)
      .map((t) => Math.abs(t.readyAt - t.plan.expectedReadyAt));
    const onTime = handed.filter((t) => Math.abs(t.readyAt - t.courierEtaSec) <= 60).length;
    const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
    const pct = (list, p) => {
      if (!list.length) return 0;
      const sorted = [...list].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    };
    const avgSitSec = Math.round(avg(sits));
    const avgLateSec = Math.round(avg(lates));
    return {
      tickets: this.tickets.length,
      handedOff: handed.length,
      blocked: this.tickets.filter((t) => t.status === "blocked").length,
      pending: this.tickets.filter((t) => t.status === "ready").length,
      stalled: this.tickets.filter((t) => t.stalled).length,
      unfinished: this.tickets.filter((t) => t.status !== "handed_off" && t.status !== "blocked").length,
      onTimePct: handed.length ? Math.round((onTime / handed.length) * 1000) / 10 : 0,
      avgSitSec,
      avgLateSec,
      p90LateSec: Math.round(pct(lates, 90)),
      maxLateSec: Math.round(lates.length ? Math.max(...lates) : 0),
      avgWaitSec: Math.round(avg(waits)),
      avgPrepMaeSec: Math.round(avg(readyErrors)),
      score: avgSitSec + 5 * avgLateSec,
      duplicates: this.duplicates.length,
    };
  }

  result() {
    const metrics = this.metrics();
    return {
      scenarioId: this.scenario.id,
      scenarioTitle: this.scenario.title,
      policyId: this.policy.id,
      durationSec: this.scenario.durationSec,
      metrics,
      tickets: this.tickets.map((t) => ({
        ...this.ticketPreview(t),
        status: t.status,
        fireAt: t.fireAt,
        readyAt: t.readyAt,
        handoffAt: t.handoffAt,
        blockedReason: t.blockedReason,
        stalled: Boolean(t.stalled),
        stalledAt: t.stalledAt ?? null,
        stallReason: t.stallReason ?? null,
        manual: t.manual,
        sitSec: t.handoffAt != null ? Math.max(0, t.courierEtaSec - t.readyAt) : null,
        lateSec: t.handoffAt != null ? Math.max(0, t.readyAt - t.courierEtaSec) : null,
        plan: t.plan,
      })),
      events: this.events.slice().sort((a, b) => a.t - b.t),
      duplicates: this.duplicates,
      courierSamples: this.courierSamples.length,
      completedSamples: this.completedSamples.length,
    };
  }
}
