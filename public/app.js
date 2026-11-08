const state = {
  scenarioId: "rush",
  policy: "adaptive",
  seed: 7,
  result: null,
  comparison: null,
  clock: 0,
  horizon: 0,
  playing: true,
  speed: 8,
  selected: null,
  tab: "board",
  loading: false,
  lastRendered: -1,
  checked: {},
  filter: "all",
  section: "all",
  training: null,
  runId: 0,
  interventions: [],
  decisions: [],
  agentAuto: false,
  agentBusy: false,
  agentLastStep: 0,
  lifecycle: null,
  serverKey: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);

function clockLabel(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function minutesLabel(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (Math.abs(seconds) >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
}

function statusAt(ticket, t) {
  if (ticket.status === "blocked") return "blocked";
  if (ticket.stalledAt != null && t >= ticket.stalledAt && (ticket.handoffAt == null || t < ticket.handoffAt)) return "stalled";
  if (t < ticket.arrivalSec) return "scheduled";
  if (ticket.fireAt == null || t < ticket.fireAt) return "waiting";
  if (ticket.readyAt == null || t < ticket.readyAt) return "cooking";
  if (ticket.handoffAt == null || t < ticket.handoffAt) return "ready";
  return "done";
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setStatus(text) {
  $("#status").textContent = text;
}

function setLoading(loading) {
  state.loading = loading;
  const button = $("#run-btn");
  button.disabled = loading;
  button.textContent = loading ? "Running…" : "Run shift";
}

async function bootstrap() {
  try {
    const meta = await api("/api/scenarios");
    const scenarioSelect = $("#scenario");
    scenarioSelect.innerHTML = meta.scenarios
      .map((scenario) => `<option value="${esc(scenario.id)}">${esc(scenario.title)}</option>`)
      .join("");
    const policySelect = $("#policy");
    policySelect.innerHTML = meta.policies
      .map((policy) => `<option value="${esc(policy.id)}">${esc(policy.label)}</option>`)
      .join("");
    policySelect.value = "adaptive";
    scenarioSelect.value = "rush";
    state.scenarioId = "rush";
    state.policy = "adaptive";
    renderFilters();
    bindEvents();
    api("/api/health")
      .then((health) => {
        state.serverKey = Boolean(health.llm);
        renderAgentSource();
      })
      .catch(() => {});
    await run();
  } catch (error) {
    setStatus(`offline: ${error.message}`);
    $("#metrics").innerHTML = `<p class="error">Could not reach the server: ${esc(error.message)}</p>`;
  }
}

function bindEvents() {
  $("#run-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.scenarioId = $("#scenario").value;
    state.policy = $("#policy").value;
    state.seed = Number($("#seed").value) || 0;
    run();
  });

  $$(".tabs button[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  $("#play").addEventListener("click", () => {
    if (!state.result) return;
    if (state.clock >= state.horizon) state.clock = 0;
    state.playing = !state.playing;
    updatePlayLabel();
  });

  $("#scrub").addEventListener("input", (event) => {
    state.clock = Number(event.target.value);
    state.lastRendered = -1;
    renderBoard();
  });

  $$(".speeds button").forEach((button) => {
    button.addEventListener("click", () => {
      state.speed = Number(button.dataset.speed);
      $$(".speeds button").forEach((other) => other.classList.toggle("on", other === button));
    });
  });

  $("#tickets").addEventListener("click", (event) => {
    const card = event.target.closest(".ticket");
    if (card) openDrawer(card.dataset.id);
  });

  $("#filters").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    $$("#filters button").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    renderTickets();
  });

  $("#section-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-section]");
    if (!button) return;
    state.section = button.dataset.section;
    renderFloor();
  });

  $("#table-list").addEventListener("click", (event) => {
    const card = event.target.closest(".res-card");
    if (card) openTable(Number(card.dataset.table));
  });

  $("#floor-map").addEventListener("click", (event) => {
    const tile = event.target.closest(".table-tile");
    if (tile) openTable(Number(tile.dataset.table));
  });

  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
    if (event.key === " " && event.target === document.body) {
      event.preventDefault();
      $("#play").click();
    }
    if (event.key === "Tab" && !$("#drawer").classList.contains("hidden")) {
      const focusable = [...$("#drawer").querySelectorAll('button, input, textarea, select, [href]')].filter(
        (node) => !node.disabled,
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  $("#brief-btn").addEventListener("click", writeBrief);
  $("#agent-btn").addEventListener("click", () => askAgent());
  $("#agent-auto").addEventListener("change", (event) => {
    state.agentAuto = event.target.checked;
    state.agentLastStep = stepIndexAt(state.clock) + 1 - AGENT_EVERY;
    renderAgentSource();
    maybeAutoTune();
  });
  $("#api-key")?.addEventListener("input", () => renderAgentSource());
  $("#model")?.addEventListener("change", () => renderAgentSource());
  $("#coach-btn").addEventListener("click", writeCoach);

  $("#compare-table").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-policy]");
    if (!button) return;
    $("#policy").value = button.dataset.policy;
    state.policy = button.dataset.policy;
    run();
  });
}

function switchView(view) {
  state.tab = view;
  $$(".tabs button[data-view]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.view === view));
  });
  for (const name of ["board", "floor", "plan", "model", "evidence", "idea"]) {
    $(`#view-${name}`).classList.toggle("hidden", name !== view);
  }
  if (view === "floor") renderFloor();
  if (view === "plan") renderPlan();
  if (view === "model") {
    loadReleases();
    renderModelReadouts();
    drawModel(performance.now());
  }
}

async function run() {
  setLoading(true);
  setStatus("simulating…");
  closeDrawer();
  try {
    const [result, comparison] = await Promise.all([
      api("/api/run", { scenarioId: state.scenarioId, policy: state.policy, seed: state.seed }),
      api("/api/compare", { scenarioId: state.scenarioId, seed: state.seed }),
    ]);
    state.result = result;
    state.comparison = comparison;
    state.runId += 1;
    state.interventions = [];
    state.decisions = [];
    state.agentLastStep = 0;
    state.training = computeTraining(result);
    state.clock = 0;
    state.horizon = Math.max(result.durationSec, ...result.events.map((event) => event.t)) + 120;
    state.playing = true;
    state.lastRendered = -1;
    state.checked = {};
    renderAgentLog();
    updatePlayLabel();
    renderAll();
    setStatus(
      `${result.scenarioTitle} · ${result.policyLabel} · ${result.metrics.tickets} tickets · seed ${state.seed}`,
    );
  } catch (error) {
    setStatus(`error: ${error.message}`);
    $("#metrics").innerHTML = `<p class="error">${esc(error.message)}</p>`;
  } finally {
    setLoading(false);
  }
}

function renderAll() {
  renderBoard(true);
  renderEvidence();
  if (state.tab === "floor") renderFloor();
  if (state.tab === "plan") renderPlan();
}

function renderBoard(force = false) {
  if (!state.result) return;
  // Rebuilding 40 cards every animation frame makes taps land on nodes that are
  // about to disappear. One update per second is enough for a countdown and
  // keeps the board stable under a gloved finger.
  if (!force && Math.abs(state.clock - state.lastRendered) < 1) return;
  state.lastRendered = state.clock;
  renderExpo();
  renderMetrics();
  renderLanes();
  renderTickets();
  if (state.tab === "floor") renderFloor();
  if (state.tab === "plan") renderPlan();
  if (state.tab === "model") renderModelReadouts();
  renderSideModel();
  maybeAutoTune();
  const scrub = $("#scrub");
  scrub.max = String(Math.round(state.horizon));
  if (document.activeElement !== scrub) scrub.value = String(Math.round(state.clock));
  $("#clock").textContent = `${clockLabel(state.clock)} / ${clockLabel(state.horizon)}`;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Wait list" },
  { id: "cooking", label: "In kitchen" },
  { id: "ready", label: "At pass" },
  { id: "stalled", label: "Stalled" },
  { id: "done", label: "Served" },
];

const filterKey = (status) => (status === "blocked" ? "stalled" : status);

function renderFilters() {
  $("#filters").innerHTML = FILTERS.map(
    (filter) =>
      `<button type="button" data-filter="${filter.id}" aria-pressed="${state.filter === filter.id}">${esc(filter.label)} <span class="count ${filter.id}" data-count="${filter.id}">0</span></button>`,
  ).join("");
}

// Counts update in place once a second; the filter buttons are never rebuilt,
// so a tap cannot land on a node that is being replaced.
function renderExpo() {
  const t = state.clock;
  const counts = { all: 0 };
  for (const ticket of state.result.tickets) {
    const status = statusAt(ticket, t);
    if (status === "scheduled") continue;
    counts.all += 1;
    const key = filterKey(status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  $("#expo-clock").innerHTML = `<span class="live"></span> EXPO <b>${clockLabel(t)}</b>`;
  for (const node of $$("#filters [data-count]")) node.textContent = String(counts[node.dataset.count] ?? 0);
}

const STATUS_LABEL = {
  waiting: "Wait list",
  cooking: "In kitchen",
  ready: "Ready",
  stalled: "Stalled",
  blocked: "Blocked",
  scheduled: "Upcoming",
};

function renderTickets() {
  const t = state.clock;
  const decorated = state.result.tickets.map((ticket) => ({ ticket, status: statusAt(ticket, t) }));
  const order = { cooking: 0, stalled: 1, ready: 2, waiting: 3, blocked: 4, done: 5, scheduled: 6 };
  decorated.sort((a, b) => {
    const byStatus = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    const aTime = a.ticket.plan?.fireAt ?? a.ticket.arrivalSec;
    const bTime = b.ticket.plan?.fireAt ?? b.ticket.arrivalSec;
    return aTime - bTime;
  });

  const visible = decorated
    .filter((entry) => entry.status !== "scheduled" || entry.ticket.arrivalSec < t + 300)
    .filter((entry) => state.filter === "all" || filterKey(entry.status) === state.filter)
    .slice(0, 40);
  if (!visible.length) {
    $("#tickets").innerHTML = `<p class="fine">${state.filter === "all" ? "No orders yet. Press play." : "No orders in this list right now."}</p>`;
    return;
  }
  $("#tickets").innerHTML = visible
    .map(({ ticket, status }) => {
      const plan = ticket.plan;
      const urgent = status === "waiting" && plan?.fireAt != null && plan.fireAt - t < 60;
      const items = ticket.items.map((item) => esc(item.name ?? item.itemId)).join(" · ");
      const where = ticket.kind === "table" ? `Table ${String(ticket.tableNo).padStart(2, "0")}` : ticket.channel;
      const who =
        ticket.kind === "table" ? `${ticket.courseLabel}${ticket.waiterName ? ` · ${ticket.waiterName}` : ""}` : ticket.customerName;
      const age = status === "waiting" ? t - ticket.arrivalSec : status === "cooking" ? t - (ticket.fireAt ?? t) : 0;
      const ageClass = age > 420 ? "age-late" : age > 180 ? "age-warn" : "age-fresh";
      let eta = "";
      if (status === "waiting") eta = plan?.fireAt != null ? `fire in ${minutesLabel(plan.fireAt - t)}` : "no plan";
      else if (status === "cooking") {
        const next = (plan?.items ?? []).filter((entry) => entry.fireAt > t + 1).sort((a, b) => a.fireAt - b.fireAt)[0];
        if (next) {
          const nextItem = ticket.items.find((item) => item.lineId === next.lineId);
          eta = `${nextItem?.name ?? next.itemId} in ${minutesLabel(next.fireAt - t)}`;
        } else {
          eta = ticket.readyAt != null ? `ready in ${minutesLabel(ticket.readyAt - t)}` : "cooking";
        }
      } else if (status === "ready") eta = ticket.kind === "table" ? "waiting for service" : "waiting for courier";
      else if (status === "done") eta = ticket.sitSec > 0 ? `sat ${minutesLabel(ticket.sitSec)}` : `late ${minutesLabel(ticket.lateSec)}`;
      else if (status === "blocked") eta = ticket.blockedReason ?? "blocked";
      else if (status === "stalled") eta = ticket.stallReason ?? "item never completed";
      else if (status === "scheduled") eta = `arrives ${clockLabel(ticket.arrivalSec)}`;
      const label = status === "done" ? (ticket.kind === "table" ? "Served" : "Handed off") : (STATUS_LABEL[status] ?? status);
      const ageText = age > 0 ? `<span class="age">${minutesLabel(age)}</span> · ` : "";
      return `<button type="button" class="ticket ${status} ${ageClass}${urgent ? " urgent" : ""}" data-id="${esc(ticket.id)}">
        <div class="thead"><span class="id">Order #${esc(ticket.id)}</span><span class="where">${esc(where)}</span></div>
        <div class="qty">Item: ${ticket.items.length}X</div>
        <div class="cust">${esc(who)}</div>
        <div class="items">${items || "no items"}</div>
        <div class="trow"><span class="time">${ageText}${esc(eta)}</span><span class="tag">${esc(label)}</span></div>
      </button>`;
    })
    .join("");
}

function renderMetrics() {
  const m = state.result.metrics;
  const cards = [
    { k: "On time", v: `${m.onTimePct}%`, s: `${m.handedOff} handed off`, tone: m.onTimePct >= 60 ? "good" : "bad" },
    { k: "Food sat", v: `${m.avgSitSec}s`, s: "avg before pickup", tone: m.avgSitSec > 180 ? "warn" : "good" },
    { k: "Courier waited", v: `${m.avgLateSec}s`, s: `p90 ${m.p90LateSec}s`, tone: m.avgLateSec > 60 ? "bad" : "good" },
    { k: "Blocked", v: String(m.blocked), s: "86'd or empty", tone: m.blocked ? "warn" : "good" },
    { k: "Cost", v: String(m.score), s: "sit + 5 × late", tone: "warn" },
  ];
  $("#metrics").innerHTML = cards
    .map((card) => `<div class="metric ${card.tone}"><div class="k">${esc(card.k)}</div><div class="v">${esc(card.v)}</div><div class="s">${esc(card.s)}</div></div>`)
    .join("");
}

function renderLanes() {
  const stations = [
    { id: "grill", label: "Grill" },
    { id: "fry", label: "Fry" },
    { id: "cold", label: "Cold / assembly" },
  ];
  const t = state.clock;
  $("#lanes").innerHTML = stations
    .map((station) => {
      const rows = [];
      for (const ticket of state.result.tickets) {
        for (const item of ticket.items) {
          if (item.station !== station.id) continue;
          const start = item.startedAt ?? item.fireAt;
          if (start == null || t < start) continue;
          const end = item.doneAt ?? start + item.prepSec;
          if (t >= end) continue;
          const pct = Math.max(4, Math.min(100, ((t - start) / Math.max(30, item.prepSec)) * 100));
          rows.push(
            `<div class="station-row"><div class="top"><b>${esc(item.name ?? item.itemId)}</b><span>${esc(ticket.id)}</span></div>` +
              `<div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div></div>`,
          );
        }
      }
      const body = rows.length ? rows.slice(0, 4).join("") : `<div class="idle">idle</div>`;
      return `<section class="lane"><h3>${esc(station.label)} <span>${rows.length}</span></h3>${body}</section>`;
    })
    .join("");
}

function renderEvidence() {
  if (!state.comparison) return;
  const rows = state.comparison.rows;
  const maxScore = Math.max(1, ...rows.map((row) => row.metrics.score));
  const body = rows
    .map((row) => {
      const delta = row.policyId === "adaptive" ? "—" : `${row.deltaVsAdaptive >= 0 ? "+" : ""}${row.deltaVsAdaptive}`;
      const deltaClass = row.deltaVsAdaptive > 0 ? "good" : row.deltaVsAdaptive < 0 ? "bad" : "";
      return `<tr class="${row.policyId === "adaptive" ? "adaptive" : ""}${row.isBest ? " best" : ""}">
        <td>${esc(row.label)}</td>
        <td class="num">${row.metrics.onTimePct}%</td>
        <td class="num">${row.metrics.avgSitSec}s</td>
        <td class="num">${row.metrics.avgLateSec}s</td>
        <td class="num">${row.metrics.p90LateSec}s</td>
        <td class="num">${row.metrics.score}</td>
        <td><span class="delta ${deltaClass}">${esc(delta)}</span> <button type="button" class="ghost" data-policy="${esc(row.policyId)}">replay</button></td>
      </tr>`;
    })
    .join("");
  $("#compare-table tbody").innerHTML = body;

  $("#bars").innerHTML = rows
    .map(
      (row) => `<div class="bar ${row.policyId === "adaptive" ? "adaptive" : ""}">
        <span>${esc(row.label)}</span>
        <span class="track"><i style="width:${Math.max(4, (row.metrics.score / maxScore) * 100).toFixed(1)}%"></i></span>
        <span class="v">${row.metrics.score}</span>
      </div>`,
    )
    .join("");
}

function floorTables() {
  if (state.result?.tables?.length) return state.result.tables;
  const map = new Map();
  for (const ticket of state.result?.tickets ?? []) {
    if (ticket.kind !== "table" || ticket.tableNo == null) continue;
    if (!map.has(ticket.tableNo)) {
      map.set(ticket.tableNo, {
        tableNo: ticket.tableNo,
        section: ticket.waiterSection ?? "A",
        waiterName: ticket.waiterName ?? "unassigned",
        waiterId: ticket.waiterId ?? null,
        seats: ticket.partySize ?? 2,
        seatedAt: ticket.arrivalSec,
        checks: [ticket.arrivalSec + 90],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.tableNo - b.tableNo);
}

function deliveredAt(course) {
  if (course.deliveredAt != null) return course.deliveredAt;
  if (course.handoffAt != null) return course.handoffAt + (course.waiterLagSec ?? 0);
  return null;
}

function floorState() {
  const t = state.clock;
  return floorTables()
    .map((table) => {
      const courses = state.result.tickets
        .filter((ticket) => ticket.kind === "table" && ticket.tableNo === table.tableNo)
        .sort((a, b) => a.courseIndex - b.courseIndex);
      const checks = [...(table.checks ?? [table.seatedAt + 90]), state.checked[table.tableNo]]
        .filter((at) => at != null && at <= t);
      const lastCheckAt = Math.max(table.seatedAt + 90, ...checks);
      const checkAge = Math.max(0, t - lastCheckAt);
      const waiting = [];
      for (const course of courses) {
        if (course.readyAt == null || t < course.readyAt) continue;
        const atTable = deliveredAt(course);
        if (atTable != null && t >= atTable) continue;
        waiting.push({ course, heldSec: Math.max(0, t - course.readyAt) });
      }
      const longest = waiting.slice().sort((a, b) => b.heldSec - a.heldSec)[0] ?? null;
      const current =
        courses.find((course) => {
          const atTable = deliveredAt(course);
          return atTable == null || t < atTable;
        }) ?? courses[courses.length - 1];
      const seated = t >= table.seatedAt;
      const checkDue = seated && t >= table.seatedAt + 120 && checkAge >= 480;
      const checkOverdue = seated && t >= table.seatedAt + 120 && checkAge > 600;
      const foodOverdue = longest != null && longest.heldSec > 900;
      const foodDue = longest != null && longest.heldSec >= 600;
      const deliveredCount = courses.filter((course) => {
        const atTable = deliveredAt(course);
        return atTable != null && t >= atTable;
      }).length;
      const stateName = !seated
        ? "upcoming"
        : foodOverdue || checkOverdue
          ? "alert"
          : foodDue || checkDue
            ? "warn"
            : deliveredCount === courses.length
              ? "done"
              : "ok";
      return {
        ...table,
        courses,
        lastCheckAt,
        checkAge,
        checkDue,
        checkOverdue,
        waiting,
        longest,
        foodOverdue,
        foodDue,
        current,
        deliveredCount,
        state: stateName,
        seated,
      };
    })
    .sort((a, b) => a.tableNo - b.tableNo);
}

const PEOPLE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.3a3 3 0 0 1 0 5.6M17.5 14.4c1.6.7 2.6 2.2 3 4.6"/></svg>';

const STATE_RANK = { alert: 0, warn: 1, ok: 2, upcoming: 3, done: 4 };
const STATE_TEXT = { alert: "Waiting long", warn: "Check due", ok: "On dine", upcoming: "Reserved", done: "Served" };

function chair(on) {
  return `<svg class="chair${on ? " on" : ""}" viewBox="0 0 20 22"><use href="#chair"/></svg>`;
}

// Top-down table: chairs on the long sides, one at each end for parties of
// four or more. Filled chairs are occupied, outlined chairs are empty.
function tableTile(table) {
  const party = Math.max(1, Math.min(12, Number(table.seats) || 2));
  const capacity = Math.max(2, party + (party % 2));
  const sides = capacity >= 4 ? 2 : 0;
  const rest = capacity - sides;
  const top = Math.ceil(rest / 2);
  const bottom = rest - top;
  const occupied = table.seated ? party : 0;
  let seat = 0;
  const row = (count) => Array.from({ length: count }, () => chair(seat++ < occupied)).join("");
  const topRow = row(top);
  const bottomRow = row(bottom);
  const left = sides ? row(1) : "";
  const right = sides ? row(1) : "";
  const timer = table.foodDue || table.foodOverdue
    ? `food ${minutesLabel(table.longest.heldSec)}`
    : table.checkDue
      ? `check ${minutesLabel(table.checkAge)}`
      : !table.seated
        ? `seats ${clockLabel(table.seatedAt)}`
        : "";
  return `<button type="button" class="table-tile state-${table.state}" data-table="${table.tableNo}" aria-label="Table ${table.tableNo}, party of ${party}, ${esc(STATE_TEXT[table.state] ?? table.state)}">
    <span class="chairs top">${topRow}</span>
    ${left ? `<span class="chairs left">${left}</span>` : ""}
    <span class="tbl-top${top >= 3 ? " wide" : ""}"><b>Table #${table.tableNo}</b><span class="ppl">${PEOPLE_ICON}${party}</span>${timer ? `<span class="tm">${esc(timer)}</span>` : ""}</span>
    ${right ? `<span class="chairs right">${right}</span>` : ""}
    <span class="chairs bottom">${bottomRow}</span>
  </button>`;
}

function resCard(table) {
  const block = {
    alert: table.longest && table.foodOverdue ? `${minutesLabel(table.longest.heldSec)}<br>food` : `${minutesLabel(table.checkAge)}<br>no check`,
    warn: "Check<br>due",
    ok: "On<br>Dine",
    upcoming: clockLabel(table.seatedAt),
    done: "Served",
  }[table.state] ?? "";
  return `<button type="button" class="res-card state-${table.state}" data-table="${table.tableNo}">
    <span class="res-time">${block}</span>
    <span class="res-main"><b>${esc(table.waiterName ?? "unassigned")}</b><span><span>Table ${table.tableNo}</span><span>${PEOPLE_ICON} ${table.seats}</span></span></span>
    <span class="res-state">${esc(STATE_TEXT[table.state] ?? table.state)}</span>
  </button>`;
}

function renderSectionTabs(sections) {
  const key = sections.join("|");
  const box = $("#section-tabs");
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = ["all", ...sections]
      .map((section) => `<button type="button" data-section="${esc(section)}">${section === "all" ? "All sections" : `Section ${esc(section)}`}</button>`)
      .join("");
  }
  if (state.section !== "all" && !sections.includes(state.section)) state.section = "all";
  for (const button of box.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.section === state.section));
}

function renderFloor() {
  if (!state.result) return;
  const t = state.clock;
  const tables = floorState();
  const active = tables.filter((table) => table.seated && table.state !== "done");
  const checkAlerts = tables.filter((table) => table.checkOverdue);
  const foodAlerts = tables.filter((table) => table.foodOverdue);
  const dueSoon = tables.filter((table) => table.checkDue && !table.checkOverdue);
  const avgCheck = active.length ? Math.round(active.reduce((sum, table) => sum + table.checkAge, 0) / active.length) : 0;
  const risk = checkAlerts.length + foodAlerts.length > 2 ? "High" : checkAlerts.length + foodAlerts.length ? "Watch" : "Steady";

  $("#service-metrics").innerHTML = `
    <div class="service-metric ${checkAlerts.length ? "bad" : ""}"><span>Tables to check</span><b>${checkAlerts.length}</b><small>10-minute standard</small></div>
    <div class="service-metric ${foodAlerts.length ? "bad" : ""}"><span>Food over 15m</span><b>${foodAlerts.length}</b><small>still at the pass</small></div>
    <div class="service-metric"><span>Avg check gap</span><b>${minutesLabel(avgCheck)}</b><small>${active.length} active tables</small></div>
    <div class="service-metric ${risk === "High" ? "bad" : ""}"><span>Service risk</span><b>${risk}</b><small>${clockLabel(t)} · ${dueSoon.length} due soon</small></div>`;

  const calls = [];
  for (const table of checkAlerts) {
    calls.push({ severity: 2, who: table.waiterName, table: table.tableNo, text: `no check in ${minutesLabel(table.checkAge)}`, action: "check now", detail: "Refill drinks, clear plates, ask about the first bite." });
  }
  for (const table of foodAlerts) {
    calls.push({ severity: 3, who: table.waiterName, table: table.tableNo, text: `${table.longest.course.courseLabel} waiting ${minutesLabel(table.longest.heldSec)} at the pass`, action: "run the food", detail: "Apologize for the wait, give an honest ETA, and tell the pass." });
  }
  for (const table of dueSoon) {
    calls.push({ severity: 1, who: table.waiterName, table: table.tableNo, text: `check due (${minutesLabel(table.checkAge)} since last)`, action: "check next", detail: "A quick stop now keeps the table inside ten minutes." });
  }
  calls.sort((a, b) => b.severity - a.severity || b.table - a.table);
  $("#service-calls").innerHTML = calls.length
    ? calls
        .slice(0, 6)
        .map(
          (call) => `<div class="waiter-call sev-${call.severity}">
            <span class="who">Tell ${esc(call.who)}</span>
            <span class="what"><b>Table ${call.table}</b> · ${esc(call.text)}</span>
            <span class="act">${esc(call.action)}</span>
            <span class="detail">${esc(call.detail)}</span>
          </div>`,
        )
        .join("")
    : `<p class="idle">Every seated table has been checked within ten minutes, and no dish has sat at the pass for fifteen.</p>`;

  const sections = [...new Set(tables.map((table) => String(table.section)))].sort();
  renderSectionTabs(sections);
  const shown = tables.filter((table) => state.section === "all" || String(table.section) === state.section);

  $("#table-list").innerHTML = shown.length
    ? shown
        .slice()
        .sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || a.tableNo - b.tableNo)
        .map(resCard)
        .join("")
    : `<p class="fine">No tables in this shift. Pick Dinner service to see the floor.</p>`;

  if (!tables.length) {
    $("#floor-map").innerHTML = `<p class="fine">This shift is delivery and pickup only, so there is no dining room. Pick <b>Dinner service</b> to see tables.</p>`;
    return;
  }
  const groups = new Map();
  for (const table of shown) {
    const section = String(table.section);
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(table);
  }
  $("#floor-map").innerHTML = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([section, list]) => {
      const server = list.find((table) => table.waiterName)?.waiterName ?? "unassigned";
      const label = state.section === "all" ? `<div class="section-label">Section ${esc(section)} · ${esc(server)}</div>` : "";
      return label + list.map(tableTile).join("");
    })
    .join("");
}

// Top-down table drawing for the floor plan: round tops for two to four
// guests, a long rectangle with chairs on both sides for bigger parties.
function openTable(tableNo) {
  const table = floorState().find((entry) => entry.tableNo === tableNo);
  if (!table) return;
  state.selected = null;
  state.lastFocus = document.activeElement;
  const courseRows = table.courses
    .map((course) => {
      const atTable = deliveredAt(course);
      const served = atTable != null && state.clock >= atTable;
      const late = served && atTable > course.courierEtaSec ? ` · ${minutesLabel(atTable - course.courierEtaSec)} late` : "";
      return `<div class="course-row"><b>${esc(course.courseLabel)}</b><span>${esc(course.items.map((item) => item.name ?? item.itemId).join(" · "))}</span><em>${served ? `served ${clockLabel(atTable)}${late}` : statusAt(course, state.clock)}</em></div>`;
    })
    .join("");
  const alert = table.foodOverdue
    ? `Food has been at the pass for ${minutesLabel(table.longest.heldSec)}. Apologize, give a real ETA, and walk it out.`
    : table.checkOverdue
      ? `No check for ${minutesLabel(table.checkAge)}. Refill drinks, clear plates, ask about the food.`
      : `Checked ${minutesLabel(table.checkAge)} ago. Next check due in ${minutesLabel(Math.max(0, 600 - table.checkAge))}.`;
  $("#drawer-body").innerHTML = `
    <h3 id="drawer-title">Table ${table.tableNo} · section ${esc(table.section)}</h3>
    <div class="sub">${esc(table.waiterName ?? "unassigned")} · party of ${table.seats} · seated ${clockLabel(table.seatedAt)} · ${table.courses.length} courses</div>
    <p class="service-callout state-${table.state}">${esc(alert)}</p>
    <h4>Courses</h4>
    <div class="course-list">${courseRows}</div>
    <h4>Service timers</h4>
    <dl class="kv">
      <dt>Last check</dt><dd>${clockLabel(table.lastCheckAt)} · ${minutesLabel(table.checkAge)} ago</dd>
      <dt>Check standard</dt><dd>every 10 minutes</dd>
      <dt>Food at pass</dt><dd>${table.longest ? `${minutesLabel(table.longest.heldSec)} · ${esc(table.longest.course.courseLabel)}` : "none waiting"}</dd>
      <dt>Food standard</dt><dd>delivered within 15 minutes</dd>
    </dl>
    <button type="button" class="primary-action" id="mark-check">Mark table checked now</button>
    <p class="sub">Recorded on this device at ${clockLabel(state.clock)}. It does not complete a course or close the table.</p>`;
  $("#drawer").classList.remove("hidden");
  $("#scrim").classList.remove("hidden");
  document.body.classList.add("drawer-open");
  $("#drawer-close").focus();
  $("#mark-check").addEventListener("click", () => {
    state.checked[table.tableNo] = state.clock;
    renderFloor();
    openTable(table.tableNo);
  });
}

function renderPlan() {
  if (!state.result) return;
  const t = state.clock;
  const horizon = 15 * 60;
  const rows = [];
  for (const ticket of state.result.tickets) {
    for (const entry of ticket.plan?.items ?? []) {
      if (entry.fireAt < t || entry.fireAt > t + horizon) continue;
      rows.push({ ...entry, ticket });
    }
  }
  rows.sort((a, b) => a.fireAt - b.fireAt || a.ticket.id.localeCompare(b.ticket.id));
  $("#fire-plan").innerHTML = rows.length
    ? rows
        .map(({ ticket, ...entry }) => {
          const name = ticket.items.find((item) => item.lineId === entry.lineId)?.name ?? entry.itemId;
          const who = ticket.kind === "table" ? `Table ${ticket.tableNo} · ${ticket.courseLabel}` : `${ticket.id} · ${ticket.channel}`;
          return `<div class="fire-row">
            <span class="at">${clockLabel(entry.fireAt)}</span>
            <span class="stn">${esc(entry.station)}</span>
            <b>${esc(name)}</b>
            <span class="who">${esc(who)}</span>
            <span class="tgt">${ticket.kind === "table" ? "serve" : "courier"} ${clockLabel(ticket.courierEtaSec)}</span>
          </div>`;
        })
        .join("")
    : `<p class="idle">No fires in the next 15 minutes.</p>`;

  const tables = new Map();
  for (const ticket of state.result.tickets) {
    if (ticket.kind !== "table") continue;
    if (!tables.has(ticket.tableNo)) {
      tables.set(ticket.tableNo, {
        tableNo: ticket.tableNo,
        party: ticket.partySize,
        seated: ticket.arrivalSec,
        courses: [],
      });
    }
    tables.get(ticket.tableNo).courses.push(ticket);
  }
  const cards = [...tables.values()]
    .sort((a, b) => a.tableNo - b.tableNo)
    .map((group) => {
      const courses = group.courses.slice().sort((a, b) => a.courseIndex - b.courseIndex);
      const body = courses
        .map((course) => {
          const late = course.readyAt != null ? Math.max(0, course.readyAt - course.courierEtaSec) : null;
          const names = course.items.map((item) => item.name ?? item.itemId).join(" · ");
          return (
            `<div class="course"><span class="cname">${course.courseIndex + 1}. ${esc(course.courseLabel)}</span>` +
            `<span class="citems">${esc(names)}</span>` +
            `<span class="ctime">serve ${clockLabel(course.courierEtaSec)}${late ? ` · late ${Math.round(late)}s` : ""}</span></div>`
          );
        })
        .join("");
      const server = courses.find((course) => course.waiterName)?.waiterName;
      return `<article class="table-card"><header><b>Table ${group.tableNo}</b><span>${server ? `${esc(server)} · ` : ""}party of ${group.party} · seated ${clockLabel(group.seated)}</span></header>${body}</article>`;
    })
    .join("");
  $("#tables").innerHTML = cards || `<p class="idle">No tables in this shift.</p>`;
  $("#floor").innerHTML = (state.result.waiterStats ?? [])
    .map(
      (waiter) => `<div class="floor-row"><b>${esc(waiter.name)}</b><span>${waiter.courses} courses · ${waiter.tables} tables</span><span class="lag ${waiter.avgLagSec > 60 ? "bad" : ""}">+${waiter.avgLagSec}s</span></div>`,
    )
    .join("") || `<p class="idle">No servers assigned in this shift.</p>`;
}

function openDrawer(ticketId) {
  const ticket = state.result?.tickets.find((entry) => entry.id === ticketId);
  if (!ticket) return;
  state.selected = ticketId;
  state.lastFocus = document.activeElement;
  const plan = ticket.plan;
  const t = state.clock;
  const status = statusAt(ticket, t);
  const items = ticket.items
    .map((item) => {
      const planned = plan?.items?.find((entry) => entry.lineId === item.lineId);
      const start = item.startedAt ?? planned?.fireAt ?? null;
      const done = item.doneAt ?? planned?.expectedReadyAt ?? null;
      let progress = "";
      if (start != null && t >= start) {
        const pct = Math.max(0, Math.min(100, ((t - start) / Math.max(30, item.prepSec)) * 100));
        progress = `<div class="progress"><i style="width:${pct.toFixed(0)}%"></i></div>`;
      }
      const timing = [`${Math.round(item.prepSec)}s`];
      if (start != null) timing.push(`fire ${clockLabel(start)}`);
      if (done != null) timing.push(`${item.doneAt != null ? "done" : "ready"} ${clockLabel(done)}`);
      return `<div class="it"><span>${esc(item.name ?? item.itemId)}</span><span>${timing.join(" · ")}</span></div>${progress}`;
    })
    .join("");

  const why = plan
    ? `<div class="why">
         <div>${esc(plan.reason)}</div>
         <div style="margin-top:6px">fire <b>${clockLabel(plan.fireAt)}</b> · ready <b>${clockLabel(plan.expectedReadyAt)}</b> · courier <b>${clockLabel(plan.expectedCourierAt)}</b></div>
         <div style="margin-top:4px">confidence <b>${Math.round((plan.confidence ?? 0) * 100)}%</b> · sit risk <b>${minutesLabel(plan.sitRiskSec)}</b> · wait risk <b>${minutesLabel(plan.lateRiskSec)}</b></div>
         <div style="margin-top:4px">courier: ${esc(plan.courierSource ?? "—")}${plan.courierKnown ? " (assigned)" : " (estimated)"} · backlog <b>${minutesLabel(plan.backlogSec ?? 0)}</b></div>
         ${plan.items?.length ? `<div class="fires">${plan.items.map((entry) => { const item = ticket.items.find((candidate) => candidate.lineId === entry.lineId); return `${esc(item?.name ?? entry.itemId)} ${clockLabel(entry.fireAt)} → ${clockLabel(entry.expectedReadyAt)}`; }).join(" · ")}</div>` : ""}
       </div>`
    : `<p class="sub">No plan recorded — this ticket was blocked or never reached a decision.</p>`;

  $("#drawer-body").innerHTML = `
    <h3 id="drawer-title">${esc(ticket.id)} · ${esc(ticket.customerName)}</h3>
    <div class="sub">${esc(ticket.kind === "table" ? `Table ${ticket.tableNo} · ${ticket.courseLabel}` : ticket.channel)} · ${
      ticket.kind === "table" ? "serve" : "promise"
    } ${clockLabel(ticket.promisedReadySec)} · status ${esc(status)}${ticket.manual ? " · manual" : ""}</div>
    ${ticket.blockedReason ? `<p class="error">${esc(ticket.blockedReason)}</p>` : ""}
    ${ticket.stalled ? `<p class="error">${esc(ticket.stallReason ?? "Item stalled")} — the dish is still in progress, so this ticket is not counted as served.${ticket.remade ? " A backup-station remake is on the ticket." : ""}</p>` : ""}

    <h4>Items</h4>
    <div class="items-list">${items || "<span class='sub'>none</span>"}</div>

    <h4>Why this fire time</h4>
    ${why}

    <h4>Reality</h4>
    <dl class="kv">
      <dt>Arrived</dt><dd>${clockLabel(ticket.arrivalSec)}</dd>
      <dt>Fired</dt><dd>${ticket.fireAt != null ? clockLabel(ticket.fireAt) : "—"}</dd>
      <dt>Ready</dt><dd>${ticket.readyAt != null ? clockLabel(ticket.readyAt) : "—"}</dd>
      ${ticket.waiterName ? `<dt>Server</dt><dd>${esc(ticket.waiterName)}${ticket.serveLagSec != null ? ` · +${Math.round(ticket.serveLagSec)}s` : ""}</dd>` : ""}
      <dt>${ticket.kind === "table" ? "Serve target" : "Courier arrival"}</dt><dd>${ticket.courierEtaSec != null ? clockLabel(ticket.courierEtaSec) : "never"}</dd>
      <dt>${ticket.kind === "table" ? "Served" : "Handed off"}</dt><dd>${ticket.handoffAt != null ? clockLabel(ticket.handoffAt) : "—"}</dd>
      <dt>${ticket.kind === "table" ? "Held at pass" : "Sat"}</dt><dd>${ticket.sitSec != null ? `${Math.round(ticket.sitSec)}s` : "—"}</dd>
      <dt>${ticket.kind === "table" ? "Guest waited" : "Courier waited"}</dt><dd>${ticket.lateSec != null ? `${Math.round(ticket.lateSec)}s` : "—"}</dd>
    </dl>

    ${ticket.note ? `<h4>Note</h4><p class="sub">${esc(ticket.note)}</p>` : ""}

    <h4>Operator override (audited)</h4>
    <textarea id="override-reason" rows="2" placeholder="Why are you overriding the plan?"></textarea>
    <div class="audit">
      <button type="button" data-action="approve">Approve plan</button>
      <button type="button" data-action="hold">Hold ticket</button>
      <button type="button" data-action="escalate">Escalate</button>
    </div>
    <p class="sub" id="override-status"></p>
  `;
  $("#drawer").classList.remove("hidden");
  $("#scrim").classList.remove("hidden");
  document.body.classList.add("drawer-open");
  $("#drawer-close").focus();
  $("#drawer-body")
    .querySelectorAll(".audit button")
    .forEach((button) => button.addEventListener("click", () => submitOverride(button.dataset.action)));
}

async function submitOverride(action) {
  const ticketId = state.selected;
  const reason = $("#override-reason").value.trim() || "operator review";
  try {
    await api("/api/override", { ticketId, action, reason });
    $("#override-status").textContent = `Recorded ${action} for ${ticketId}.`;
  } catch (error) {
    $("#override-status").textContent = `Not recorded: ${error.message}`;
  }
}

function closeDrawer() {
  state.selected = null;
  $("#drawer").classList.add("hidden");
  $("#scrim").classList.add("hidden");
  document.body.classList.remove("drawer-open");
  if (state.lastFocus instanceof HTMLElement) state.lastFocus.focus();
  state.lastFocus = null;
}

async function writeCoach() {
  const button = $("#coach-btn");
  button.disabled = true;
  button.textContent = "Analyzing…";
  try {
    const payload = await api("/api/coach", {
      scenarioId: state.scenarioId,
      policy: state.policy,
      seed: state.seed,
      apiKey: $("#api-key")?.value || undefined,
      model: $("#model")?.value ?? "openai/gpt-4o-mini",
    });
    $("#coach-text").textContent = payload.text;
    $("#coach-source").textContent = `${payload.source === "llm" ? "model analysis" : "measured analysis"}${payload.note ? ` · ${payload.note}` : ""}`;
  } catch (error) {
    $("#coach-text").textContent = `Analysis failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "Analyze shift";
  }
}

async function writeBrief() {
  const button = $("#brief-btn");
  button.disabled = true;
  button.textContent = "Writing…";
  const apiKey = $("#api-key")?.value ?? "";
  const model = $("#model")?.value ?? "openai/gpt-4o-mini";
  try {
    const payload = await api("/api/brief", {
      scenarioId: state.scenarioId,
      policy: state.policy,
      seed: state.seed,
      apiKey: apiKey || undefined,
      model,
    });
    $("#brief-text").textContent = payload.text;
    $(".source")?.remove();
    const note = document.createElement("p");
    note.className = "source";
    note.textContent = `${payload.source === "llm" ? "model rewrite" : "measured text"}${payload.note ? ` · ${payload.note}` : ""}`;
    $("#brief-text").after(note);
  } catch (error) {
    $("#brief-text").textContent = `Brief failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "Write brief";
  }
}

function updatePlayLabel() {
  $("#play").textContent = state.result && state.playing ? "Pause" : "Play";
}

// ---------- Neural net view: real weights, drawn as a training run ----------
//
// Everything here comes from result.network, which the server builds by
// training src/sim/nn.mjs on the shift's finished dishes in the order they
// finished. The canvas shows the parameters as they were at the shift clock.

const PULSE_SEC = 45;
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const scopeFont = () => getComputedStyle(document.body).getPropertyValue("--scope-mono").trim() || "monospace";

function computeTraining(result) {
  const network = result.network;
  if (!network?.steps) return null;
  const names = new Map();
  for (const ticket of result.tickets ?? []) for (const item of ticket.items) names.set(item.itemId, item.name ?? item.itemId);
  const window = 10;
  const steps = network.steps.map((step) => ({ ...step }));
  let netSum = 0;
  let menuSum = 0;
  steps.forEach((step, index) => {
    netSum += Math.abs(step.errSec);
    menuSum += Math.abs(step.priorErrSec);
    if (index >= window) {
      netSum -= Math.abs(steps[index - window].errSec);
      menuSum -= Math.abs(steps[index - window].priorErrSec);
    }
    const n = Math.min(window, index + 1);
    step.netLoss = netSum / n;
    step.menuLoss = menuSum / n;
  });
  const inputs = network.architecture.inputs;
  const order = ["grill", "fry", "cold"];
  const used = [...new Set(steps.map((step) => step.itemId))]
    .sort((a, b) => {
      const sa = steps.find((step) => step.itemId === a).station;
      const sb = steps.find((step) => step.itemId === b).station;
      return order.indexOf(sa) - order.indexOf(sb) || String(names.get(a)).localeCompare(String(names.get(b)));
    })
    .slice(0, 9);
  const inputNodes = [
    ...used.map((id) => ({ id, index: inputs.indexOf(id), label: String(names.get(id) ?? id).toUpperCase().slice(0, 13) })),
    ...order.map((id) => ({ id, index: inputs.indexOf(id), label: id.toUpperCase(), station: true })),
  ];
  const courier = [];
  for (const ticket of result.tickets ?? []) {
    const plan = ticket.plan;
    if (plan && !plan.courierKnown && ticket.courierEtaSec != null && Number.isFinite(plan.courierMeanSec)) {
      courier.push({ t: ticket.courierEtaSec, biasSec: plan.courierMeanSec - ticket.promisedReadySec });
    }
  }
  courier.sort((a, b) => a.t - b.t);
  const maxLoss = Math.max(40, ...steps.map((step) => Math.max(step.netLoss, step.menuLoss))) * 1.2;
  return { steps, inputNodes, hidden: network.architecture.hidden, learningRate: network.learningRate, mode: network.mode, courier, maxLoss, summary: network.summary };
}

function stepIndexAt(t) {
  const steps = state.training?.steps ?? [];
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function currentParams() {
  const training = state.training;
  const index = stepIndexAt(state.clock);
  if (index >= 0) return training.steps[index].params;
  return null;
}

function renderModelReadouts() {
  const training = state.training;
  const box = $("#scope-readouts");
  if (!box || !training) return;
  const index = stepIndexAt(state.clock);
  const step = index >= 0 ? training.steps[index] : null;
  const courier = training.courier.filter((entry) => entry.t <= state.clock).at(-1);
  box.innerHTML = `
    <span>step<b>${index + 1}/${training.steps.length}</b></span>
    <span>net error<b>${step ? `${Math.round(step.netLoss)}s` : "—"}</b></span>
    <span>menu only<b>${step ? `${Math.round(step.menuLoss)}s` : "—"}</b></span>
    <span>output bias<b>${step ? `${step.params.b2 >= 0 ? "+" : ""}${Math.round(step.params.b2 * 300)}s` : "—"}</b></span>
    <span>lr<b>${step ? step.params.lr : training.learningRate}</b></span>
    <span>agent changes<b>${state.interventions.filter((entry) => entry.atSec <= state.clock).length}</b></span>
    <span>courier bias<b>${courier ? `${courier.biasSec >= 0 ? "+" : ""}${Math.round(courier.biasSec)}s` : "—"}</b></span>`;
  $("#nn-mode").textContent = `${training.mode} mode · ${training.hidden} hidden units`;

  const params = step?.params;
  const rows = [];
  if (params) {
    params.b1.forEach((value, j) => rows.push({ name: `b${j + 1}`, value, hint: `hidden ${j + 1} bias` }));
    params.w2.forEach((value, j) => rows.push({ name: `w${j + 1}→out`, value, hint: `hidden ${j + 1} to output` }));
    rows.push({ name: "b out", value: params.b2, hint: "output bias" });
  }
  const scale = Math.max(0.05, ...rows.map((row) => Math.abs(row.value)));
  $("#nn-params").innerHTML = rows.length
    ? rows
        .map((row) => {
          const width = (Math.abs(row.value) / scale) * 50;
          const left = row.value >= 0 ? 50 : 50 - width;
          return `<div class="param-row" title="${esc(row.hint)}"><span>${esc(row.name)}</span><span class="wbar"><i class="${row.value < 0 ? "neg" : ""}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i></span><b>${row.value.toFixed(4)}</b></div>`;
        })
        .join("")
    : `<p class="fine">No dish has finished yet, so the network still holds its starting weights. Press play.</p>`;
}

function renderSideModel() {
  const training = state.training;
  const box = $("#side-model");
  if (!box) return;
  if (!training?.steps.length) {
    box.innerHTML = `<b>Neural net</b>No finished dishes in this shift yet.`;
    return;
  }
  const index = stepIndexAt(state.clock);
  const seen = training.steps.slice(0, index + 1);
  const points = seen.map((step) => [step.t / Math.max(1, state.horizon), 1 - Math.min(1, step.netLoss / training.maxLoss)]);
  const line = points.map(([x, y]) => `${(x * 100).toFixed(1)},${(y * 30 + 2).toFixed(1)}`).join(" ");
  box.innerHTML = `<b>Neural net · ${esc(training.mode)}</b>
    <span class="big">${index >= 0 ? `${Math.round(seen.at(-1).netLoss)}s` : "—"}</span> error
    <div>step ${index + 1} of ${training.steps.length}</div>
    <svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><polyline points="${line}" fill="none" stroke="#1a9e8f" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

function fitCanvas(canvas) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function graticule(ctx, width, height, divisionsX, divisionsY, inset) {
  const cx = width / 2;
  const cy = height / 2;
  const w = width - inset * 2;
  const h = height - inset * 2;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#0d2216";
  for (let i = 0; i <= divisionsX; i += 1) {
    const x = inset + (w / divisionsX) * i;
    ctx.globalAlpha = Math.max(0.12, 1 - Math.abs(x - cx) / (width * 0.62));
    ctx.beginPath();
    ctx.moveTo(x, inset);
    ctx.lineTo(x, height - inset);
    ctx.stroke();
  }
  for (let i = 0; i <= divisionsY; i += 1) {
    const y = inset + (h / divisionsY) * i;
    ctx.globalAlpha = Math.max(0.12, 1 - Math.abs(y - cy) / (height * 0.62));
    ctx.beginPath();
    ctx.moveTo(inset, y);
    ctx.lineTo(width - inset, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#14361f";
  for (let i = 0; i <= divisionsX * 5; i += 1) {
    const x = inset + (w / (divisionsX * 5)) * i;
    ctx.beginPath();
    ctx.moveTo(x, cy - 3);
    ctx.lineTo(x, cy + 3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Wide dim halo, green body, near-white core: phosphor without neon.
function phosphor(ctx, draw, intensity = 1) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = `rgba(70, 255, 140, ${0.1 * intensity})`;
  ctx.lineWidth = 7;
  draw();
  ctx.shadowColor = "rgba(70, 255, 140, 0.7)";
  ctx.shadowBlur = 6;
  ctx.strokeStyle = `rgba(70, 255, 140, ${0.55 * intensity})`;
  ctx.lineWidth = 2.4;
  draw();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `rgba(215, 255, 243, ${0.9 * intensity})`;
  ctx.lineWidth = 1.1;
  draw();
  ctx.restore();
}

function drawLoss(now) {
  const canvas = $("#loss-canvas");
  const training = state.training;
  if (!canvas || !training) return;
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, width, height } = fit;
  const inset = 26;
  graticule(ctx, width, height, 10, 8, inset);
  const t = state.clock;
  const plotW = width - inset * 2;
  const plotH = height - inset * 2;
  const x = (sec) => inset + (Math.min(sec, state.horizon) / Math.max(1, state.horizon)) * plotW;
  const y = (loss) => height - inset - (Math.min(loss, training.maxLoss) / training.maxLoss) * plotH;
  const seen = training.steps.slice(0, stepIndexAt(t) + 1);

  ctx.fillStyle = "rgba(70, 255, 140, 0.28)";
  for (const step of seen) {
    ctx.beginPath();
    ctx.arc(x(step.t), y(Math.abs(step.errSec)), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.font = `12px ${scopeFont()}`;
  if (!seen.length) {
    const phase = reduceMotion() ? 0 : now / 380;
    phosphor(ctx, () => {
      ctx.beginPath();
      for (let px = inset; px <= width - inset; px += 3) {
        const wave = Math.sin((px - inset) / 26 - phase) * 10 * Math.exp(-((px - width / 2) ** 2) / (width * width * 0.12));
        if (px === inset) ctx.moveTo(px, height - inset - 12 + wave);
        else ctx.lineTo(px, height - inset - 12 + wave);
      }
      ctx.stroke();
    }, 0.8);
    ctx.fillStyle = "rgba(47, 191, 105, 0.85)";
    ctx.textAlign = "center";
    ctx.fillText("WAITING FOR THE FIRST FINISHED DISH", width / 2, height / 2);
    return;
  }

  const stepPath = (key) => () => {
    ctx.beginPath();
    ctx.moveTo(x(seen[0].t), y(seen[0][key]));
    for (let i = 1; i < seen.length; i += 1) {
      ctx.lineTo(x(seen[i].t), y(seen[i - 1][key]));
      ctx.lineTo(x(seen[i].t), y(seen[i][key]));
    }
    ctx.lineTo(x(t), y(seen.at(-1)[key]));
    ctx.stroke();
  };

  // Baseline: the menu medians alone, dim and dashed.
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(70, 255, 140, 0.35)";
  ctx.lineWidth = 1.2;
  stepPath("menuLoss")();
  ctx.restore();

  // Agent interventions: a marker where each accepted change landed.
  ctx.save();
  ctx.font = `11px ${scopeFont()}`;
  ctx.textAlign = "center";
  for (const change of state.interventions) {
    if (change.atSec > t) continue;
    const mx = x(change.atSec);
    ctx.strokeStyle = "rgba(215, 255, 243, 0.35)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(mx, inset);
    ctx.lineTo(mx, height - inset);
    ctx.stroke();
    ctx.fillStyle = "rgba(215, 255, 243, 0.85)";
    ctx.fillText(change.source === "llm" ? "AI" : "A", mx, inset - 8);
  }
  ctx.restore();

  phosphor(ctx, stepPath("netLoss"), 0.7);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x(Math.max(0, t - 240)), 0, width, height);
  ctx.clip();
  phosphor(ctx, stepPath("netLoss"), 1);
  ctx.restore();

  const headY = y(seen.at(-1).netLoss);
  ctx.save();
  ctx.fillStyle = "#d7fff3";
  ctx.shadowColor = "rgba(70, 255, 140, 0.9)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(x(t), headY, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "rgba(47, 191, 105, 0.9)";
  ctx.textAlign = "left";
  ctx.fillText(`ERROR · ${Math.round(training.maxLoss)}S FULL SCALE`, inset + 6, inset + 14);
  ctx.fillText("━ NETWORK   ┅ MENU ONLY", inset + 6, inset + 30);
  ctx.textAlign = "right";
  ctx.fillText("SHIFT TIME →", width - inset - 6, height - inset - 8);
}

function drawNet(now) {
  const canvas = $("#net-canvas");
  const training = state.training;
  if (!canvas || !training) return;
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, width, height } = fit;
  graticule(ctx, width, height, 6, 8, 18);
  const t = state.clock;
  const params = currentParams();
  const inputs = training.inputNodes;
  const top = 34;
  const bottom = height - 34;
  const span = (index, count) => (count <= 1 ? (top + bottom) / 2 : top + ((bottom - top) / (count - 1)) * index);
  const colIn = Math.max(118, width * 0.36);
  const colHid = width * 0.64;
  const colOut = width - 46;
  const inNodes = inputs.map((node, index) => ({ ...node, x: colIn, y: span(index, inputs.length) }));
  const hidNodes = Array.from({ length: training.hidden }, (_, j) => ({ j, x: colHid, y: span(j + 0.5, training.hidden + 1) * 0.86 + (top + bottom) * 0.07 }));
  const outNode = { x: colOut, y: (top + bottom) / 2 };

  const weight = (inNode, j) => (params ? params.w1[j][inNode.index] ?? 0 : 0);
  let scale = 0.05;
  if (params) {
    for (const node of inNodes) for (const h of hidNodes) scale = Math.max(scale, Math.abs(weight(node, h.j)));
    for (const value of params.w2) scale = Math.max(scale, Math.abs(value));
  }

  const lastSeen = new Map();
  const index = stepIndexAt(t);
  for (let i = 0; i <= index; i += 1) {
    const step = training.steps[i];
    lastSeen.set(step.itemId, step.t);
    lastSeen.set(step.station, step.t);
  }
  const heat = (id) => {
    const at = lastSeen.get(id);
    return at == null ? 0 : Math.exp(-(t - at) / PULSE_SEC);
  };
  const recentAny = index >= 0 ? Math.exp(-(t - training.steps[index].t) / PULSE_SEC) : 0;

  const edge = (a, b, w, glow) => {
    const mag = Math.min(1, Math.abs(w) / scale);
    ctx.save();
    if (w < 0) ctx.setLineDash([3, 4]);
    ctx.strokeStyle = `rgba(70, 255, 140, ${0.06 + mag * 0.55 + glow * 0.3})`;
    ctx.lineWidth = 0.6 + mag * 2.4;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo((a.x + b.x) / 2, a.y, (a.x + b.x) / 2, b.y, b.x, b.y);
    ctx.stroke();
    ctx.restore();
  };
  const along = (a, b, p) => {
    const mx = (a.x + b.x) / 2;
    const u = 1 - p;
    return {
      x: u ** 3 * a.x + 3 * u * u * p * mx + 3 * u * p * p * mx + p ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * p * a.y + 3 * u * p * p * b.y + p ** 3 * b.y,
    };
  };

  for (const node of inNodes) for (const h of hidNodes) edge(node, h, weight(node, h.j), heat(node.id) * 0.5);
  for (const h of hidNodes) edge(h, outNode, params ? params.w2[h.j] : 0, recentAny * 0.4);

  // Each recent training step travels input → its strongest hidden unit → output.
  ctx.save();
  ctx.fillStyle = "#d7fff3";
  ctx.shadowColor = "rgba(70, 255, 140, 0.9)";
  ctx.shadowBlur = 10;
  for (let i = Math.max(0, index - 12); i <= index; i += 1) {
    const step = training.steps[i];
    const age = t - step.t;
    if (age > PULSE_SEC) continue;
    const from = inNodes.find((node) => node.id === step.itemId);
    if (!from) continue;
    const strongest = hidNodes.reduce((best, h) => (Math.abs(step.params.w1[h.j][from.index] ?? 0) > Math.abs(step.params.w1[best.j][from.index] ?? 0) ? h : best), hidNodes[0]);
    const p = age / PULSE_SEC;
    const point = p < 0.5 ? along(from, strongest, p * 2) : along(strongest, outNode, (p - 0.5) * 2);
    ctx.globalAlpha = 1 - p * 0.6;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  const font = scopeFont();
  const node = (n, radius, glow, label, align, sub) => {
    ctx.save();
    ctx.fillStyle = "#030805";
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
    ctx.fill();
    phosphor(ctx, () => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }, 0.45 + glow * 0.55);
    if (glow > 0.02) {
      ctx.fillStyle = `rgba(70, 255, 140, ${glow * 0.6})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = `rgba(${glow > 0.3 ? "215, 255, 243" : "47, 191, 105"}, 0.95)`;
    ctx.font = `12px ${font}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = align;
    const dx = align === "right" ? -radius - 8 : 0;
    const dy = align === "center" ? radius + 13 : 0;
    ctx.fillText(label, n.x + dx, n.y + dy);
    if (sub) {
      ctx.fillStyle = "rgba(47, 191, 105, 0.7)";
      ctx.fillText(sub, n.x + dx, n.y + dy + 13);
    }
    ctx.restore();
  };

  for (const n of inNodes) node(n, n.station ? 5 : 4.5, heat(n.id), n.label, "right");
  for (const h of hidNodes) node(h, 10, recentAny * 0.6, `H${h.j + 1}`, "center", params ? `b ${params.b1[h.j].toFixed(2)}` : "b 0.00");
  const lastStep = index >= 0 ? training.steps[index] : null;
  node(outNode, 13, recentAny, "PREP", "center", lastStep ? `${lastStep.predSec}s` : "");
  if (!reduceMotion() && !lastStep) {
    ctx.fillStyle = "rgba(47, 191, 105, 0.6)";
    ctx.font = `11px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText("STARTING WEIGHTS", width * 0.5, 16 + Math.sin(now / 600) * 1.5);
  }
}

function drawModel(now) {
  if (!state.training) return;
  drawNet(now);
  drawLoss(now);
}

// ---------- AI agent: proposes changes to the network as dishes finish ----------

const AGENT_EVERY = 5; // finished dishes between agent turns in live mode

function itemLabel(itemId) {
  for (const ticket of state.result?.tickets ?? []) {
    const item = ticket.items.find((entry) => entry.itemId === itemId);
    if (item) return item.name ?? itemId;
  }
  return itemId;
}

function describeChange(change) {
  const parts = [];
  if (change.learningRate != null) parts.push(`learning rate → ${Number(change.learningRate).toFixed(3)}`);
  if (change.outputBiasSec != null) parts.push(`all dishes ${change.outputBiasSec >= 0 ? "+" : ""}${Math.round(change.outputBiasSec)}s`);
  for (const [itemId, sec] of Object.entries(change.itemBiasSec ?? {})) {
    parts.push(`${itemLabel(itemId)} ${sec >= 0 ? "+" : ""}${Math.round(sec)}s`);
  }
  return parts.join(" · ") || "no change";
}

function renderAgentLog() {
  const box = $("#agent-log");
  if (!box) return;
  if (!state.decisions.length) {
    box.innerHTML = `<li class="empty">No agent turns yet. Switch on live tuning and press play, or ask the agent now.</li>`;
    return;
  }
  box.innerHTML = state.decisions
    .slice()
    .reverse()
    .map((d) => {
      const status = d.error ? "rejected" : d.accepted ? "applied" : /no change/.test(d.verdict ?? "") ? "idle" : "rejected";
      const src = d.source === "llm" ? `<span class="src llm">${esc(d.model ?? "OpenRouter")}</span>` : `<span class="src">rule agent</span>`;
      const what = d.error
        ? "Agent call failed"
        : status === "idle"
          ? "No change: the network is tracking the kitchen"
          : `${d.accepted ? "Applied" : "Not applied"}: ${esc(describeChange(d.change ?? {}))}`;
      const meta = d.error
        ? esc(d.error)
        : `${esc(d.verdict)} · newest dishes ${d.beforeMaeSec}s → ${d.afterMaeSec}s${d.notes?.length ? ` · ${esc(d.notes.join("; "))}` : ""}`;
      return `<li class="entry ${status}">
        <span class="at">${clockLabel(d.atSec)}</span>
        <span class="what">${what}</span>
        ${src}
        ${d.reason ? `<span class="why">${esc(d.reason)}</span>` : ""}
        <span class="meta">${meta}</span>
      </li>`;
    })
    .join("");
}

function renderAgentSource(note) {
  const hasKey = Boolean($("#api-key")?.value.trim()) || state.serverKey;
  const who = hasKey
    ? `OpenRouter · ${$("#model").value}${$("#api-key")?.value.trim() ? "" : " (server key)"}`
    : "rule agent (no key)";
  $("#agent-source").textContent = `${state.agentAuto ? "Live tuning is on" : "Live tuning is off"} · proposals from ${who}. ${note ?? "Changes are applied only if they lower error on the newest finished dishes."}`;
}

async function askAgent() {
  if (!state.result || state.agentBusy) return;
  state.agentBusy = true;
  const button = $("#agent-btn");
  button.disabled = true;
  button.textContent = "Agent thinking…";
  const request = { scenarioId: state.scenarioId, policy: state.policy, seed: state.seed, runId: state.runId };
  try {
    const payload = await api("/api/network/tune", {
      scenarioId: request.scenarioId,
      policy: request.policy,
      seed: request.seed,
      atSec: Math.round(state.clock),
      interventions: state.interventions,
      apiKey: $("#api-key")?.value || undefined,
      model: $("#model")?.value ?? "openai/gpt-4o-mini",
    });
    // A new shift may have started while the agent was thinking.
    if (request.runId !== state.runId) return;
    state.interventions = payload.interventions;
    state.result.network = payload.network;
    state.training = computeTraining(state.result);
    state.decisions.push(payload.decision);
    renderAgentLog();
    renderAgentSource(payload.note);
    renderModelReadouts();
    renderSideModel();
  } catch (error) {
    if (request.runId === state.runId) {
      state.decisions.push({ atSec: Math.round(state.clock), error: error.message, source: "rules" });
      renderAgentLog();
    }
  } finally {
    state.agentBusy = false;
    button.disabled = false;
    button.textContent = "Ask agent now";
  }
}

// Live mode: one agent turn per AGENT_EVERY finished dishes, driven by the
// shift clock, so the agent sees the restaurant's data as it arrives.
function maybeAutoTune() {
  if (!state.agentAuto || !state.training || state.agentBusy) return;
  const done = stepIndexAt(state.clock) + 1;
  if (done >= state.agentLastStep + AGENT_EVERY) {
    state.agentLastStep = done;
    askAgent();
  }
}

// ---------- Model releases: the 3-week promotion cycle ----------

async function loadReleases() {
  if (state.lifecycle) return;
  try {
    state.lifecycle = await api("/api/lifecycle");
    renderReleases();
  } catch (error) {
    $("#release-chart").innerHTML = `<p class="error">Could not load the release history: ${esc(error.message)}</p>`;
  }
}

function renderReleases() {
  const data = state.lifecycle;
  if (!data) return;
  const { days, cycles, releases, production, impact, config } = data;
  const avg = (list, key) => {
    const values = list.map((entry) => entry[key]).filter((value) => value != null);
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  };
  const last = days.slice(-config.cycleDays);
  const first = days.slice(0, config.cycleDays);
  const costDelta = impact ? Math.round(((impact.avgScore - impact.avgBaselineScore) / impact.avgBaselineScore) * 100) : null;
  $("#release-kitchen").textContent = `${config.kitchen} · ${config.totalDays} service days · ${config.ordersPerDay} orders a day`;
  $("#release-kpis").innerHTML = `
    <div class="kpi"><span>In production</span><b>v${production.version}</b><small>since day ${production.sinceDay} · next review day ${production.nextReviewDay}</small></div>
    <div class="kpi"><span>Prep-time error</span><b>${avg(last, "championMaeSec")}s</b><small>last 3 weeks · was ${avg(first, "championMaeSec")}s on menu medians</small></div>
    <div class="kpi"><span>Restaurant cost</span><b>${costDelta != null ? `${costDelta > 0 ? "+" : ""}${costDelta}%` : "—"}</b><small>vs never replacing v1 · on time ${impact?.avgOnTimePct}% vs ${impact?.avgBaselineOnTimePct}%</small></div>`;

  // Chart geometry.
  const W = 720;
  const H = 240;
  const pad = { l: 40, r: 108, t: 30, b: 28 };
  const maxY = Math.ceil(Math.max(...days.flatMap((d) => [d.championMaeSec, d.challengerMaeSec, d.menuMaeSec])) / 10) * 10;
  const x = (day) => pad.l + ((day - 1) / Math.max(1, days.length - 1)) * (W - pad.l - pad.r);
  const y = (value) => pad.t + (1 - value / maxY) * (H - pad.t - pad.b);
  const line = (key) => days.map((d, i) => `${i ? "L" : "M"}${x(d.day).toFixed(1)},${y(d[key]).toFixed(1)}`).join("");
  const ticks = [0, maxY / 2, maxY];
  const grid = ticks
    .map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}s</text>`)
    .join("");
  const weekTicks = days
    .filter((d) => d.day === 1 || d.day % 7 === 0)
    .map((d) => `<text x="${x(d.day)}" y="${H - 8}" class="axis" text-anchor="middle">${d.day === 1 ? "day 1" : `wk ${d.day / 7}`}</text>`)
    .join("");
  const drift = days.find((d) => d.drift);
  const driftMark = drift
    ? `<rect x="${x(drift.day)}" y="${pad.t}" width="${Math.max(2, x(Math.min(days.length, drift.day + 6)) - x(drift.day))}" height="${H - pad.t - pad.b}" class="drift"/><text x="${x(drift.day) + 4}" y="${pad.t + 12}" class="axis">grill slows</text>`
    : "";
  const reviewMarks = cycles
    .map((c) => {
      const label = c.promoted ? `v${c.newVersion} live` : `kept v${c.championVersion}`;
      return `<line x1="${x(c.day)}" x2="${x(c.day)}" y1="${pad.t - 6}" y2="${H - pad.b}" class="review${c.promoted ? " on" : ""}"/><text x="${x(c.day)}" y="${pad.t - 12}" class="review-label" text-anchor="middle">${esc(label)}</text>`;
    })
    .join("");
  const end = days.at(-1);
  // Direct labels at the right end, nudged apart if they would collide.
  const labels = [
    { key: "championMaeSec", text: "In production", cls: "lbl prod" },
    { key: "challengerMaeSec", text: "Challenger", cls: "lbl chal" },
    { key: "menuMaeSec", text: "Menu", cls: "lbl menu" },
  ].map((entry) => ({ ...entry, y: y(end[entry.key]) }));
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i += 1) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  const direct = labels.map((entry) => `<text x="${W - pad.r + 8}" y="${entry.y + 4}" class="${entry.cls}">${entry.text}</text>`).join("");

  $("#release-chart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily prep-time error over ${days.length} days: production model, retraining challenger, and menu medians, with release reviews every ${config.cycleDays} days">
      ${grid}${weekTicks}${driftMark}${reviewMarks}
      <path d="${line("menuMaeSec")}" class="series menu"/>
      <path d="${line("challengerMaeSec")}" class="series chal"/>
      <path d="${line("championMaeSec")}" class="series prod"/>
      ${direct}
      <line class="cross hidden" id="rel-cross" y1="${pad.t}" y2="${H - pad.b}"/>
      <circle class="dot prod hidden" id="rel-dot" r="4"/>
      <rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/>
    </svg>
    <div class="tip hidden" id="rel-tip"></div>`;

  const svg = $("#release-chart svg");
  const hit = svg.querySelector(".hit");
  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const sx = ((clientX - box.left) / box.width) * W;
    const day = Math.max(1, Math.min(days.length, Math.round(((sx - pad.l) / (W - pad.l - pad.r)) * (days.length - 1)) + 1));
    const d = days[day - 1];
    const cross = $("#rel-cross");
    cross.setAttribute("x1", x(d.day));
    cross.setAttribute("x2", x(d.day));
    cross.classList.remove("hidden");
    const dot = $("#rel-dot");
    dot.setAttribute("cx", x(d.day));
    dot.setAttribute("cy", y(d.championMaeSec));
    dot.classList.remove("hidden");
    const tip = $("#rel-tip");
    tip.innerHTML = `<b>Day ${d.day} · v${d.championVersion} in production</b>
      <span><i class="sw prod"></i>In production <em>${d.championMaeSec}s</em></span>
      <span><i class="sw chal"></i>Challenger <em>${d.challengerMaeSec}s</em></span>
      <span><i class="sw menu"></i>Menu <em>${d.menuMaeSec}s</em></span>
      <span>Cost <em>${d.score}</em> · without releases <em>${d.baselineScore ?? "—"}</em></span>`;
    tip.classList.remove("hidden");
    const px = (x(d.day) / W) * box.width;
    tip.style.left = `${Math.min(box.width - 230, Math.max(0, px + 12))}px`;
  };
  const hide = () => {
    $("#rel-cross").classList.add("hidden");
    $("#rel-dot").classList.add("hidden");
    $("#rel-tip").classList.add("hidden");
  };
  hit.addEventListener("pointermove", (event) => show(event.clientX));
  hit.addEventListener("pointerdown", (event) => show(event.clientX));
  hit.addEventListener("pointerleave", hide);

  $("#release-table").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Review day</th><th>In production</th><th class="num">Its error</th><th class="num">Challenger error</th><th>Decision</th></tr></thead>
    <tbody>${cycles
      .map(
        (c) => `<tr><td>Day ${c.day}</td><td>v${c.championVersion}</td><td class="num">${c.championMaeSec}s</td><td class="num">${c.challengerMaeSec}s</td><td>${c.promoted ? `Replaced by v${c.newVersion}` : esc(c.note ?? "Kept")}</td></tr>`,
      )
      .join("")}</tbody></table></div>
    <p class="fine">${releases.map((r) => `v${r.version} (day ${r.day}): ${esc(r.note)}`).join(" · ")}</p>`;
}

let lastFrame = performance.now();
function frame(now) {
  const delta = (now - lastFrame) / 1000;
  lastFrame = now;
  if (state.playing && state.result) {
    state.clock = Math.min(state.horizon, state.clock + delta * state.speed);
    if (state.clock >= state.horizon) {
      state.playing = false;
      updatePlayLabel();
    }
    renderBoard();
  }
  if (state.tab === "model" && state.result) drawModel(now);
  requestAnimationFrame(frame);
}

bootstrap();
requestAnimationFrame(frame);
