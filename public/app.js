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
    bindEvents();
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
  for (const name of ["board", "plan", "evidence", "idea"]) {
    $(`#view-${name}`).classList.toggle("hidden", name !== view);
  }
  if (view === "plan") renderPlan();
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
    state.clock = 0;
    state.horizon = Math.max(result.durationSec, ...result.events.map((event) => event.t)) + 120;
    state.playing = true;
    state.lastRendered = -1;
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
  if (state.tab === "plan") renderPlan();
}

function renderBoard(force = false) {
  if (!state.result) return;
  // Rebuilding 40 cards every animation frame makes taps land on nodes that are
  // about to disappear. One update per second is enough for a countdown and
  // keeps the board stable under a gloved finger.
  if (!force && Math.abs(state.clock - state.lastRendered) < 1) return;
  state.lastRendered = state.clock;
  renderMetrics();
  renderLanes();
  renderTickets();
  if (state.tab === "plan") renderPlan();
  const scrub = $("#scrub");
  scrub.max = String(Math.round(state.horizon));
  if (document.activeElement !== scrub) scrub.value = String(Math.round(state.clock));
  $("#clock").textContent = `${clockLabel(state.clock)} / ${clockLabel(state.horizon)}`;
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

function renderTickets() {
  const t = state.clock;
  const decorated = state.result.tickets.map((ticket) => ({ ticket, status: statusAt(ticket, t) }));
  const order = { cooking: 0, ready: 1, waiting: 2, blocked: 3, done: 4, scheduled: 5 };
  decorated.sort((a, b) => {
    const byStatus = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    const aTime = a.ticket.plan?.fireAt ?? a.ticket.arrivalSec;
    const bTime = b.ticket.plan?.fireAt ?? b.ticket.arrivalSec;
    return aTime - bTime;
  });

  const visible = decorated.filter((entry) => entry.status !== "scheduled" || entry.ticket.arrivalSec < t + 300).slice(0, 40);
  if (!visible.length) {
    $("#tickets").innerHTML = `<p class="idle">No tickets yet. Press play.</p>`;
    return;
  }
  $("#tickets").innerHTML = visible
    .map(({ ticket, status }) => {
      const plan = ticket.plan;
      const urgent = status === "waiting" && plan?.fireAt != null && plan.fireAt - t < 60;
      const items = ticket.items.map((item) => esc(item.name ?? item.itemId)).join(" · ");
      const chan = ticket.kind === "table" ? `table ${ticket.tableNo} · ${ticket.courseLabel}` : ticket.channel;
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
      }
      else if (status === "ready") eta = ticket.kind === "table" ? "waiting for service" : "waiting for courier";
      else if (status === "done") eta = ticket.sitSec > 0 ? `sat ${minutesLabel(ticket.sitSec)}` : `late ${minutesLabel(ticket.lateSec)}`;
      else if (status === "blocked") eta = ticket.blockedReason ?? "blocked";
      const label = status === "done" ? (ticket.kind === "table" ? "served" : "handed off") : status;
      return `<button type="button" class="ticket ${status}${urgent ? " urgent" : ""}" data-id="${esc(ticket.id)}">
        <div class="thead"><span class="id">${esc(ticket.id)}</span><span class="chan">${esc(chan)}</span></div>
        <div class="cust">${esc(ticket.customerName)}</div>
        <div class="items">${items || "no items"}</div>
        <div class="trow"><span class="pill ${status}">${esc(label)}</span><span class="time">${esc(eta)}</span></div>
      </button>`;
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
      return `<article class="table-card"><header><b>Table ${group.tableNo}</b><span>party of ${group.party} · seated ${clockLabel(group.seated)}</span></header>${body}</article>`;
    })
    .join("");
  $("#tables").innerHTML = cards || `<p class="idle">No tables in this shift.</p>`;
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

    <h4>Items</h4>
    <div class="items-list">${items || "<span class='sub'>none</span>"}</div>

    <h4>Why this fire time</h4>
    ${why}

    <h4>Reality</h4>
    <dl class="kv">
      <dt>Arrived</dt><dd>${clockLabel(ticket.arrivalSec)}</dd>
      <dt>Fired</dt><dd>${ticket.fireAt != null ? clockLabel(ticket.fireAt) : "—"}</dd>
      <dt>Ready</dt><dd>${ticket.readyAt != null ? clockLabel(ticket.readyAt) : "—"}</dd>
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
  requestAnimationFrame(frame);
}

bootstrap();
requestAnimationFrame(frame);
