import { MENU, STATIONS, itemById } from "./menu.mjs";
import { mulberry32 } from "./rng.mjs";

// A small neural network that learns prep times during the shift.
//
// Input: one-hot menu item plus one-hot station. One tanh hidden layer, plus a
// linear skip connection from each input straight to the output. Output: a
// correction to the menu's prior median, so on a cold start (all weights near
// zero) the network predicts what the menu says. Every finished dish moves
// the weights and biases by one gradient step.
//
// An agent (src/tuner.mjs) may also change the network between dishes: the
// learning rate, the output bias, or one item's skip weight. Each change is an
// "intervention" with a timestamp, applied when the replay reaches it, so the
// whole history stays reproducible.
//
// It runs in shadow mode: it reports its online error, but the fire decision
// still uses the estimators in estimators.mjs.

export const SCALE = 300; // seconds per output unit
export const INPUTS = MENU.map((item) => item.id);
const N_IN = INPUTS.length + STATIONS.length;

export const LIMITS = {
  learningRate: [0.005, 0.2],
  outputBiasSec: 90,
  itemBiasSec: 90,
};

export class PrepNet {
  constructor({ hidden = 4, learningRate = 0.03, seed = 11 } = {}) {
    const rng = mulberry32(seed);
    const init = () => (rng() - 0.5) * 0.2;
    this.hidden = hidden;
    this.learningRate = learningRate;
    this.w1 = Array.from({ length: hidden }, () => Array.from({ length: N_IN }, init));
    this.b1 = Array.from({ length: hidden }, () => 0);
    this.w2 = Array.from({ length: hidden }, init);
    this.ws = new Array(N_IN).fill(0);
    this.b2 = 0;
    this.steps = 0;
  }

  features(itemId) {
    const x = new Array(N_IN).fill(0);
    const index = INPUTS.indexOf(itemId);
    if (index >= 0) x[index] = 1;
    const station = STATIONS.indexOf(itemById(itemId).station);
    if (station >= 0) x[INPUTS.length + station] = 1;
    return x;
  }

  forward(itemId) {
    const x = this.features(itemId);
    const h = this.w1.map((row, j) => Math.tanh(row.reduce((sum, w, i) => sum + w * x[i], this.b1[j])));
    let residual = h.reduce((sum, value, j) => sum + value * this.w2[j], this.b2);
    for (let i = 0; i < N_IN; i += 1) if (x[i] !== 0) residual += this.ws[i] * x[i];
    const prior = itemById(itemId).medianSec / SCALE;
    return { x, h, y: prior + residual };
  }

  predict(itemId) {
    return this.forward(itemId).y * SCALE;
  }

  // One SGD step on squared error. Returns the prediction made before the
  // update, so reported error is honest online error.
  train(itemId, actualSec) {
    const { x, h, y } = this.forward(itemId);
    const target = actualSec / SCALE;
    const grad = y - target;
    const lr = this.learningRate;
    for (let j = 0; j < this.hidden; j += 1) {
      const back = grad * this.w2[j] * (1 - h[j] * h[j]);
      this.w2[j] -= lr * grad * h[j];
      this.b1[j] -= lr * back;
      for (let i = 0; i < N_IN; i += 1) {
        if (x[i] !== 0) this.w1[j][i] -= lr * back * x[i];
      }
    }
    for (let i = 0; i < N_IN; i += 1) if (x[i] !== 0) this.ws[i] -= lr * grad * x[i];
    this.b2 -= lr * grad;
    this.steps += 1;
    return { predSec: y * SCALE, errSec: y * SCALE - actualSec, loss: 0.5 * grad * grad };
  }

  // Applies one agent intervention. Values are clamped here as well as in the
  // tuner, so nothing outside LIMITS can reach the weights.
  apply(change) {
    if (Number.isFinite(change.learningRate)) {
      this.learningRate = clamp(change.learningRate, ...LIMITS.learningRate);
    }
    if (Number.isFinite(change.outputBiasSec)) {
      this.b2 += clamp(change.outputBiasSec, -LIMITS.outputBiasSec, LIMITS.outputBiasSec) / SCALE;
    }
    for (const [itemId, sec] of Object.entries(change.itemBiasSec ?? {})) {
      const index = INPUTS.indexOf(itemId);
      if (index < 0 || !Number.isFinite(sec)) continue;
      this.ws[index] += clamp(sec, -LIMITS.itemBiasSec, LIMITS.itemBiasSec) / SCALE;
    }
  }

  clone() {
    const copy = new PrepNet({ hidden: this.hidden, learningRate: this.learningRate });
    copy.w1 = this.w1.map((row) => row.slice());
    copy.b1 = this.b1.slice();
    copy.w2 = this.w2.slice();
    copy.ws = this.ws.slice();
    copy.b2 = this.b2;
    copy.steps = this.steps;
    return copy;
  }

  snapshot() {
    const r = (value) => Math.round(value * 10000) / 10000;
    return {
      w1: this.w1.map((row) => row.map(r)),
      b1: this.b1.map(r),
      w2: this.w2.map(r),
      ws: this.ws.map(r),
      b2: r(this.b2),
      lr: r(this.learningRate),
    };
  }
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function orderSamples(samples) {
  return samples
    .filter((sample) => Number.isFinite(sample.serviceSec) && sample.serviceSec > 0 && Number.isFinite(sample.t))
    .slice()
    .sort((a, b) => a.t - b.t);
}

// Replays the finished dishes of a shift in the order they finished, training
// the network after each one and applying each intervention at its time.
// With stopAtSec, it stops before the first dish that finished later and
// returns the live network too (used by the tuner to judge a proposal).
export function trainShadow(samples, options = {}) {
  const { interventions = [], stopAtSec = Infinity, ...netOptions } = options;
  const net = new PrepNet(netOptions);
  const pending = interventions.slice().sort((a, b) => a.atSec - b.atSec);
  const applied = [];
  const ordered = orderSamples(samples);
  const steps = [];
  for (const sample of ordered) {
    while (pending.length && pending[0].atSec <= sample.t && pending[0].atSec <= stopAtSec) {
      const change = pending.shift();
      net.apply(change);
      applied.push(change);
    }
    if (sample.t > stopAtSec) break;
    const { predSec, errSec } = net.train(sample.itemId, sample.serviceSec);
    const priorSec = itemById(sample.itemId).medianSec;
    steps.push({
      t: sample.t,
      itemId: sample.itemId,
      station: itemById(sample.itemId).station,
      actualSec: Math.round(sample.serviceSec),
      predSec: Math.round(predSec),
      errSec: Math.round(errSec),
      priorErrSec: Math.round(priorSec - sample.serviceSec),
      params: net.snapshot(),
    });
  }
  while (pending.length && pending[0].atSec <= stopAtSec && Number.isFinite(stopAtSec)) {
    const change = pending.shift();
    net.apply(change);
    applied.push(change);
  }
  const mae = (list, key) => (list.length ? Math.round(list.reduce((sum, step) => sum + Math.abs(step[key]), 0) / list.length) : null);
  const head = steps.slice(0, 10);
  const tail = steps.slice(-10);
  return {
    architecture: {
      inputs: [...INPUTS, ...STATIONS],
      hidden: net.hidden,
      activation: "tanh",
      skip: true,
      output: "prep seconds = menu median + correction",
    },
    learningRate: netOptions.learningRate ?? 0.03,
    mode: "shadow",
    steps,
    interventions: applied,
    net,
    summary: {
      steps: steps.length,
      firstTenMaeSec: mae(head, "errSec"),
      lastTenMaeSec: mae(tail, "errSec"),
      menuOnlyMaeSec: mae(steps, "priorErrSec"),
      networkMaeSec: mae(steps, "errSec"),
      agentChanges: applied.length,
    },
  };
}

// The JSON-safe part of a training run (the live PrepNet stays server-side).
export function publicNetwork(run) {
  const { net, ...rest } = run;
  return rest;
}

export function samplesFromSteps(steps) {
  return steps.map((step) => ({ itemId: step.itemId, serviceSec: step.actualSec, t: step.t }));
}
