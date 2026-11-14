// Presentation of decision answers and attempts: bar order, where a score sits on its rubric,
// how confidence is described, and the attempts as segments of one timeline.

import type { Attempt, ChoiceProbability, ChoiceValue, LevelProbability } from "../api/types";

export interface ProbabilityRow {
  label: string;
  value: number;
  chosen: boolean;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The same option: the same value of the same type, so true is not "true". */
function sameValue(a: ChoiceValue, b: ChoiceValue): boolean {
  return typeof a === typeof b && a === b;
}

/** Choice probabilities, most likely first, with the answered value marked. */
export function choiceRows(probabilities: readonly ChoiceProbability[], chosen: ChoiceValue): ProbabilityRow[] {
  return probabilities
    .map((entry) => ({ label: String(entry.value), value: clamp01(entry.probability), chosen: sameValue(entry.value, chosen) }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** The most likely level of a score: the position of its highest probability, the first on a tie. */
export function topLevel(probabilities: readonly LevelProbability[]): number {
  let best = 0;
  probabilities.forEach((entry, index) => {
    if (entry.probability > (probabilities[best]?.probability ?? -Infinity)) best = index;
  });
  return best;
}

/** A level's name on screen: its label, or its index when it has none. */
export function levelName(entry: LevelProbability): string {
  return entry.label ?? String(entry.value);
}

/** Score levels in rubric order, lowest first, with the most likely level marked. */
export function levelRows(probabilities: readonly LevelProbability[]): ProbabilityRow[] {
  const top = topLevel(probabilities);
  return probabilities.map((entry, index) => ({ label: levelName(entry), value: clamp01(entry.probability), chosen: index === top }));
}

export interface RubricTick {
  label: string;
  /** Position along the rubric, from 0 to 1. */
  at: number;
}

export interface Rubric {
  ticks: RubricTick[];
  /** Where the score sits, from 0 to 1. */
  marker: number;
}

/** Ticks for each level and the score's place between them. Scores are zero-based level indexes. */
export function rubric(levels: readonly string[], score: number): Rubric {
  const span = Math.max(1, levels.length - 1);
  return {
    ticks: levels.map((label, index) => ({ label, at: levels.length > 1 ? index / span : 0 })),
    marker: clamp01((Number.isFinite(score) ? score : 0) / span),
  };
}

export function methodLabel(method: string | undefined): string {
  if (method === "upstream") return "reported by the upstream";
  if (method === "normalized-entropy") return "normalized entropy";
  if (method === "logprobs") return "logprobs · best calibration of synthetic methods";
  if (method === "sampling") return "sampling · coarse frequencies";
  if (method === "json") return "JSON · model-stated estimates, weakest calibration";
  if (method === "mixed") return "mixed methods";
  if (method === "none") return "no confidence reported";
  return "method not reported";
}

export interface TimelineSegment {
  index: number;
  attempt: Attempt;
  /** Start and width as fractions of the whole timeline. */
  start: number;
  width: number;
}

/**
 * Attempts laid end to end in the order they ran, each as wide as its latency. Very short
 * attempts keep a minimum width so a fast failure is still visible and clickable.
 */
export function attemptTimeline(attempts: readonly Attempt[], minimum = 0.06): TimelineSegment[] {
  if (attempts.length === 0) return [];
  const floor = Math.min(minimum, 1 / attempts.length);
  const raw = attempts.map((attempt) => (Number.isFinite(attempt.latency_ms) ? Math.max(0, attempt.latency_ms) : 0));
  const total = raw.reduce((sum, value) => sum + value, 0);
  const shares = raw.map((value) => (total > 0 ? value / total : 1 / attempts.length));
  const lifted = shares.map((share) => Math.max(floor, share));
  const scale = lifted.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return attempts.map((attempt, index) => {
    const width = (lifted[index] ?? 0) / scale;
    const segment = { index, attempt, start: cursor, width };
    cursor += width;
    return segment;
  });
}

/** Total time spent across all attempts, in milliseconds. */
export function attemptsTotal(attempts: readonly Attempt[]): number {
  return attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.latency_ms) ? Math.max(0, attempt.latency_ms) : 0), 0);
}
