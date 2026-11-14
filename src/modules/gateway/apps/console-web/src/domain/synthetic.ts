import type { Answer, Provider, Question, SyntheticMethod } from "../api/types";

/** Mock mode follows the configured method order; markers let the fallback states be exercised. */
export function mockSyntheticMethod(provider: Provider, q: Question, input: string): SyntheticMethod | null {
  return (provider.synthetic_methods ?? ["logprobs", "sampling", "json"]).find((method) =>
    method === "logprobs" ? (q.choices?.length ?? 0) <= 20 && !input.includes("[no-logprobs]") : method === "sampling" ? !input.includes("[invalid-samples]") : true,
  ) ?? null;
}

export function mockSyntheticAnswer(answer: Answer, method: SyntheticMethod, n: number): Answer {
  if ("refusal" in answer) return answer;
  let p = answer.type === "predicate" ? [answer.probability, 1 - answer.probability] : answer.probabilities.map((entry) => entry.probability);
  if (method === "sampling" || method === "json") {
    const scale = method === "sampling" ? n : 100;
    const counts = p.map((v) => Math.floor(v * scale));
    const order = p.map((v, i) => ({ i, rest: v * scale - (counts[i] ?? 0) })).sort((a, b) => b.rest - a.rest);
    let remaining = scale - counts.reduce((sum, value) => sum + value, 0);
    for (const { i } of order) { if (remaining-- <= 0) break; counts[i] = (counts[i] ?? 0) + 1; }
    p = counts.map((count) => count / scale);
  }
  const entropy = -p.reduce((sum, v) => sum + (v > 0 ? v * Math.log(v) : 0), 0);
  const confidence = Math.max(0, Math.min(1, 1 - entropy / Math.log(p.length)));
  const base = { confidence, confidence_method: method };
  if (answer.type === "predicate") return { ...answer, ...base, probability: p[0] ?? 0 };
  const probabilities = answer.probabilities.map((entry, i) => ({ ...entry, probability: p[i] ?? 0 }));
  if (answer.type === "score") return { ...answer, ...base, probabilities: answer.probabilities.map((entry, i) => ({ ...entry, probability: p[i] ?? 0 })), score: p.reduce((sum, v, i) => sum + i * v, 0) };
  return { ...answer, ...base, probabilities, choice: probabilities[p.indexOf(Math.max(...p))]?.value ?? answer.choice };
}
