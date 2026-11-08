// Saved training configurations for PrepNet. "production" is the default the
// rest of the app uses; the others exist to compare against it on the same
// shift, so a choice between them is a measured one.
export const NET_PRESETS = [
  {
    id: "production",
    label: "Production",
    note: "Tuned default: small steps, small replay batches. Best over weeks of service.",
    options: { learningRate: 0.001, batchSize: 4 },
  },
  {
    id: "fast-adapt",
    label: "Fast adapt",
    note: "Three times the learning rate and bigger batches: reacts quickly, overreacts to noise.",
    options: { learningRate: 0.003, batchSize: 8 },
  },
  {
    id: "conservative",
    label: "Conservative",
    note: "Half the learning rate: steadier, slower to learn a new kitchen.",
    options: { learningRate: 0.0005, batchSize: 4 },
  },
  {
    id: "no-replay",
    label: "No replay",
    note: "Batch of one, no replay buffer: plain online learning, for comparison.",
    options: { learningRate: 0.001, batchSize: 1 },
  },
];

export function netPreset(id = "production") {
  return NET_PRESETS.find((preset) => preset.id === id) ?? null;
}
