import { MENU, STATIONS, itemById } from "./menu.mjs";
import { mulberry32 } from "./rng.mjs";

// PrepNet: a multilayer perceptron that learns this kitchen's prep times
// while the shift runs.
//
//   item  ──► Embedding(19→8) ┐
//                             ├─ concat(12) ─► Dense(16, SiLU) ─► Dense(8, SiLU) ─► Linear(1)
//   station ► Embedding(3→4) ─┘                                                     │
//                                                                                   ▼
//   prediction(s) = menu median + 300 · ( MLP output + per-item residual bias )
//
// Training is online and supervised: every finished dish is labelled by the
// kitchen's own timestamps (done − start, seconds). Each new dish triggers one
// optimizer step on a mini-batch made of that dish plus samples drawn from a
// replay buffer of recent dishes:
//
//   loss       Huber (δ = 30 s), robust to the odd stalled or remade dish
//   optimizer  AdamW (β1 0.9, β2 0.999, decoupled weight decay 1e-4)
//   stability  global gradient-norm clipping at 1.0
//   metric     prequential MAE: every dish is predicted *before* it is learned
//
// An agent (src/tuner.mjs) may also adjust the network between dishes: the
// learning rate, the output bias, or one item's residual bias. Each change is
// an "intervention" with a timestamp, applied when the replay reaches it, so
// the whole history is reproducible.
//
// It runs in shadow mode within a shift: it reports its online error, but the
// fire decision uses the estimators in estimators.mjs. Across days, the model
// lifecycle (lifecycle.mjs) promotes it into production every three weeks.

export const SCALE = 300; // seconds per output unit
export const INPUTS = MENU.map((item) => item.id);
const N_ITEMS = INPUTS.length;
const N_ST = STATIONS.length;
const D_ITEM = 8;
const D_ST = 4;
const D_IN = D_ITEM + D_ST;
const H1 = 16;
const H2 = 8;

export const LIMITS = {
  learningRate: [0.0002, 0.02],
  outputBiasSec: 90,
  itemBiasSec: 90,
};

// Flat parameter vector layout. One contiguous array makes Adam, clipping,
// cloning and snapshots trivial and keeps the maths honest.
const LAYOUT = (() => {
  const blocks = [
    ["embedItem", N_ITEMS * D_ITEM, true],
    ["embedStation", N_ST * D_ST, true],
    ["w1", H1 * D_IN, true],
    ["b1", H1, false],
    ["w2", H2 * H1, true],
    ["b2", H2, false],
    ["w3", H2, true],
    ["b3", 1, false],
    ["residual", N_ITEMS, false],
  ];
  const map = {};
  let offset = 0;
  for (const [name, size, decay] of blocks) {
    map[name] = { offset, size, decay };
    offset += size;
  }
  map.total = offset;
  return map;
})();

export const PARAM_COUNT = LAYOUT.total;
const PER_DISH = new Set(["embedItem", "embedStation", "residual"]);

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const silu = (x) => x * sigmoid(x);
const siluGrad = (x) => {
  const s = sigmoid(x);
  return s * (1 + x * (1 - s));
};

export class PrepNet {
  constructor({ learningRate = 0.001, batchSize = 4, bufferSize = 64, weightDecay = 1e-4, clip = 1, huberSec = 30, sharedLrScale = 1, seed = 11 } = {}) {
    this.learningRate = learningRate;
    this.sharedLrScale = sharedLrScale;
    this.huberSec = huberSec;
    this.huber = huberSec / SCALE;
    this.batchSize = batchSize;
    this.bufferSize = bufferSize;
    this.weightDecay = weightDecay;
    this.clip = clip;
    this.seed = seed;
    this.rng = mulberry32(seed * 7919 + 1);
    this.theta = new Float64Array(LAYOUT.total);
    this.m = new Float64Array(LAYOUT.total);
    this.v = new Float64Array(LAYOUT.total);
    this.t = 0;
    this.steps = 0;
    this.buffer = [];
    this.lastGradNorm = 0;
    this.lastLoss = 0;
    const init = mulberry32(seed);
    const uniform = (block, scale) => {
      const { offset, size } = LAYOUT[block];
      for (let i = 0; i < size; i += 1) this.theta[offset + i] = (init() * 2 - 1) * scale;
    };
    uniform("embedItem", 0.1);
    uniform("embedStation", 0.1);
    uniform("w1", Math.sqrt(6 / D_IN) * 0.5); // He-uniform, halved for a gentle start
    uniform("w2", Math.sqrt(6 / H1) * 0.5);
    uniform("w3", 0.01); // near-zero output: a cold network predicts the menu
    this.theta0 = Float64Array.from(this.theta); // for parameter drift ‖θ − θ₀‖
  }

  get outputBias() {
    return this.theta[LAYOUT.b3.offset];
  }

  forward(itemId) {
    const th = this.theta;
    const i = Math.max(0, INPUTS.indexOf(itemId));
    const s = Math.max(0, STATIONS.indexOf(itemById(itemId).station));
    const z0 = new Array(D_IN);
    for (let k = 0; k < D_ITEM; k += 1) z0[k] = th[LAYOUT.embedItem.offset + i * D_ITEM + k];
    for (let k = 0; k < D_ST; k += 1) z0[D_ITEM + k] = th[LAYOUT.embedStation.offset + s * D_ST + k];
    const a1 = new Array(H1);
    const h1 = new Array(H1);
    for (let j = 0; j < H1; j += 1) {
      let sum = th[LAYOUT.b1.offset + j];
      const row = LAYOUT.w1.offset + j * D_IN;
      for (let k = 0; k < D_IN; k += 1) sum += th[row + k] * z0[k];
      a1[j] = sum;
      h1[j] = silu(sum);
    }
    const a2 = new Array(H2);
    const h2 = new Array(H2);
    for (let j = 0; j < H2; j += 1) {
      let sum = th[LAYOUT.b2.offset + j];
      const row = LAYOUT.w2.offset + j * H1;
      for (let k = 0; k < H1; k += 1) sum += th[row + k] * h1[k];
      a2[j] = sum;
      h2[j] = silu(sum);
    }
    let out = th[LAYOUT.b3.offset] + th[LAYOUT.residual.offset + i];
    for (let j = 0; j < H2; j += 1) out += th[LAYOUT.w3.offset + j] * h2[j];
    const prior = itemById(itemId).medianSec / SCALE;
    return { i, s, z0, a1, h1, a2, h2, y: prior + out };
  }

  predict(itemId) {
    return this.forward(itemId).y * SCALE;
  }

  // Accumulates d(loss)/d(theta) for one example into grad.
  backward(cache, dy, grad) {
    const th = this.theta;
    const { i, s, z0, a1, h1, a2, h2 } = cache;
    grad[LAYOUT.b3.offset] += dy;
    grad[LAYOUT.residual.offset + i] += dy;
    const da2 = new Array(H2);
    for (let j = 0; j < H2; j += 1) {
      grad[LAYOUT.w3.offset + j] += dy * h2[j];
      da2[j] = dy * th[LAYOUT.w3.offset + j] * siluGrad(a2[j]);
    }
    const dh1 = new Array(H1).fill(0);
    for (let j = 0; j < H2; j += 1) {
      const row = LAYOUT.w2.offset + j * H1;
      grad[LAYOUT.b2.offset + j] += da2[j];
      for (let k = 0; k < H1; k += 1) {
        grad[row + k] += da2[j] * h1[k];
        dh1[k] += da2[j] * th[row + k];
      }
    }
    const dz0 = new Array(D_IN).fill(0);
    for (let j = 0; j < H1; j += 1) {
      const da1 = dh1[j] * siluGrad(a1[j]);
      const row = LAYOUT.w1.offset + j * D_IN;
      grad[LAYOUT.b1.offset + j] += da1;
      for (let k = 0; k < D_IN; k += 1) {
        grad[row + k] += da1 * z0[k];
        dz0[k] += da1 * th[row + k];
      }
    }
    for (let k = 0; k < D_ITEM; k += 1) grad[LAYOUT.embedItem.offset + i * D_ITEM + k] += dz0[k];
    for (let k = 0; k < D_ST; k += 1) grad[LAYOUT.embedStation.offset + s * D_ST + k] += dz0[D_ITEM + k];
  }

  // One online training step. The new dish is predicted first (that is the
  // reported error), then the network takes one AdamW step on a mini-batch:
  // the new dish plus up to batchSize−1 dishes replayed from the buffer.
  train(itemId, actualSec) {
    const first = this.forward(itemId);
    const target = actualSec / SCALE;
    const predSec = first.y * SCALE;

    this.buffer.push({ itemId, target });
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    const batch = [{ cache: first, target }];
    const older = this.buffer.length - 1;
    for (let b = 1; b < this.batchSize && older > 0; b += 1) {
      const pick = this.buffer[Math.floor(this.rng() * older)];
      batch.push({ cache: this.forward(pick.itemId), target: pick.target });
    }

    const grad = new Float64Array(LAYOUT.total);
    let loss = 0;
    for (const { cache, target: y } of batch) {
      const err = cache.y - y;
      const abs = Math.abs(err);
      const delta = this.huber;
      loss += abs <= delta ? 0.5 * err * err : delta * (abs - 0.5 * delta);
      this.backward(cache, Math.max(-delta, Math.min(delta, err)), grad);
    }
    const n = batch.length;
    let norm = 0;
    for (let p = 0; p < grad.length; p += 1) {
      grad[p] /= n;
      norm += grad[p] * grad[p];
    }
    norm = Math.sqrt(norm);
    const scale = norm > this.clip ? this.clip / norm : 1;

    this.t += 1;
    const b1 = 0.9;
    const b2 = 0.999;
    const c1 = 1 - b1 ** this.t;
    const c2 = 1 - b2 ** this.t;
    for (const block of ["embedItem", "embedStation", "w1", "b1", "w2", "b2", "w3", "b3", "residual"]) {
      const { offset, size, decay } = LAYOUT[block];
      // Shared layers serve every dish, so they move more slowly than the
      // per-dish parameters (embeddings and residual biases).
      const lr = PER_DISH.has(block) ? this.learningRate : this.learningRate * this.sharedLrScale;
      for (let p = offset; p < offset + size; p += 1) {
        const g = grad[p] * scale;
        this.m[p] = b1 * this.m[p] + (1 - b1) * g;
        this.v[p] = b2 * this.v[p] + (1 - b2) * g * g;
        if (decay) this.theta[p] -= lr * this.weightDecay * this.theta[p];
        this.theta[p] -= (lr * (this.m[p] / c1)) / (Math.sqrt(this.v[p] / c2) + 1e-8);
      }
    }
    this.steps += 1;
    this.lastGradNorm = norm;
    this.lastLoss = loss / n;
    return { predSec, errSec: predSec - actualSec, loss: this.lastLoss, gradNorm: norm };
  }

  // Applies one agent intervention. Values are clamped here as well as in the
  // tuner, so nothing outside LIMITS can reach the parameters.
  apply(change) {
    if (Number.isFinite(change.learningRate)) {
      this.learningRate = clamp(change.learningRate, ...LIMITS.learningRate);
    }
    if (Number.isFinite(change.outputBiasSec)) {
      this.theta[LAYOUT.b3.offset] += clamp(change.outputBiasSec, -LIMITS.outputBiasSec, LIMITS.outputBiasSec) / SCALE;
    }
    for (const [itemId, sec] of Object.entries(change.itemBiasSec ?? {})) {
      const index = INPUTS.indexOf(itemId);
      if (index < 0 || !Number.isFinite(sec)) continue;
      this.theta[LAYOUT.residual.offset + index] += clamp(sec, -LIMITS.itemBiasSec, LIMITS.itemBiasSec) / SCALE;
    }
  }

  clone() {
    const copy = new PrepNet({
      learningRate: this.learningRate,
      batchSize: this.batchSize,
      bufferSize: this.bufferSize,
      weightDecay: this.weightDecay,
      clip: this.clip,
      huberSec: this.huberSec,
      sharedLrScale: this.sharedLrScale,
      seed: this.seed,
    });
    copy.theta = Float64Array.from(this.theta);
    copy.theta0 = Float64Array.from(this.theta0);
    copy.m = Float64Array.from(this.m);
    copy.v = Float64Array.from(this.v);
    copy.t = this.t;
    copy.steps = this.steps;
    copy.buffer = this.buffer.slice();
    return copy;
  }

  // What the UI draws. Input edges are the effective weights from each one-hot
  // input to the first hidden layer (W1 · embedding), so every edge is a real
  // number the network uses.
  snapshot() {
    const r = (value) => Math.round(value * 1000) / 1000;
    const th = this.theta;
    const block = (name) => Array.from(th.subarray(LAYOUT[name].offset, LAYOUT[name].offset + LAYOUT[name].size), r);
    const effective = [];
    for (let input = 0; input < N_ITEMS + N_ST; input += 1) {
      const isItem = input < N_ITEMS;
      const base = isItem ? LAYOUT.embedItem.offset + input * D_ITEM : LAYOUT.embedStation.offset + (input - N_ITEMS) * D_ST;
      const shift = isItem ? 0 : D_ITEM;
      const dims = isItem ? D_ITEM : D_ST;
      const row = [];
      for (let j = 0; j < H1; j += 1) {
        let sum = 0;
        for (let k = 0; k < dims; k += 1) sum += th[LAYOUT.w1.offset + j * D_IN + shift + k] * th[base + k];
        row.push(r(sum));
      }
      effective.push(row);
    }
    const w2 = block("w2");
    const norm = (name) => {
      const { offset, size } = LAYOUT[name];
      let sum = 0;
      for (let p = offset; p < offset + size; p += 1) sum += th[p] * th[p];
      return r(Math.sqrt(sum));
    };
    const drift = (...names) => {
      let sum = 0;
      for (const name of names) {
        const { offset, size } = LAYOUT[name];
        for (let p = offset; p < offset + size; p += 1) sum += (th[p] - this.theta0[p]) ** 2;
      }
      return Math.round(Math.sqrt(sum) * 10000) / 10000;
    };
    return {
      inputToH1: effective,
      h1ToH2: Array.from({ length: H2 }, (_, j) => w2.slice(j * H1, (j + 1) * H1)),
      h2ToOut: block("w3"),
      b1: block("b1"),
      b2: block("b2"),
      b3: r(th[LAYOUT.b3.offset]),
      residual: block("residual"),
      norms: {
        embedding: r(Math.hypot(norm("embedItem"), norm("embedStation"))),
        dense1: norm("w1"),
        dense2: norm("w2"),
        output: norm("w3"),
        residual: norm("residual"),
      },
      drift: {
        embedding: drift("embedItem", "embedStation"),
        dense1: drift("w1", "b1"),
        dense2: drift("w2", "b2"),
        output: drift("w3", "b3"),
        residual: drift("residual"),
      },
      gradNorm: r(this.lastGradNorm),
      loss: Math.round(this.lastLoss * 1e6) / 1e6,
      lr: Math.round(this.learningRate * 1e5) / 1e5,
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

export const ARCHITECTURE = {
  name: "PrepNet",
  inputs: [...INPUTS, ...STATIONS],
  layers: [
    { name: "Item embedding", shape: `${N_ITEMS} × ${D_ITEM}`, params: N_ITEMS * D_ITEM },
    { name: "Station embedding", shape: `${N_ST} × ${D_ST}`, params: N_ST * D_ST },
    { name: "Dense 1 · SiLU", shape: `${D_IN} → ${H1}`, params: H1 * D_IN + H1 },
    { name: "Dense 2 · SiLU", shape: `${H1} → ${H2}`, params: H2 * H1 + H2 },
    { name: "Output · linear", shape: `${H2} → 1`, params: H2 + 1 },
    { name: "Per-item residual bias", shape: `${N_ITEMS}`, params: N_ITEMS },
  ],
  hidden: [H1, H2],
  params: LAYOUT.total,
  loss: "Huber, δ = 30 s",
  optimizer: "AdamW · β1 0.9 · β2 0.999 · weight decay 1e-4",
  clipping: "global gradient norm ≤ 1.0",
  initialization: "He-uniform dense layers, near-zero output layer",
  labels: "self-labelled: done − start seconds from the kitchen's own timestamps",
  output: "prep seconds = menu median + 300 × (network output + residual bias)",
};

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
    architecture: ARCHITECTURE,
    learningRate: net.learningRate,
    batchSize: net.batchSize,
    bufferSize: net.bufferSize,
    mode: "shadow",
    steps,
    interventions: applied,
    net,
    summary: {
      steps: steps.length,
      params: LAYOUT.total,
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
