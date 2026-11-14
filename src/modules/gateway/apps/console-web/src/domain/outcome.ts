// A request's outcome as one plain sentence, read from its attempts: "Answered by Mock after
// OpenRouter's key was missing", "Failed: OpenAI key not set, OpenRouter key not set", and, when
// the upstream names who served it, "Answered by Perplexity via OpenRouter · <resolved model>". Pure.

import type { Attempt } from "../api/types";

type TitleOf = (name: string) => string;

export interface AttemptReason {
  /** For "Answered by X after …": "OpenRouter's key was missing". */
  clause: string;
  /** For "Failed: …": "OpenRouter key not set". */
  short: string;
}

// The gateway's text for an HTTP error: "upstream HTTP 404", with the upstream's own message after it when it gave one.
const HTTP_FAILURE = /^upstream HTTP (\d{3})(?::([\s\S]*))?$/i;

/** Why one attempt failed, from the gateway's error text. Unknown errors are quoted as they came. */
export function attemptReason(error: string | null | undefined, who: string): AttemptReason {
  const text = (error ?? "").trim();
  // The upstream's message is shown whole and read for no words: the patterns below would take its words for the gateway's.
  const http = HTTP_FAILURE.exec(text);
  if (http) {
    const [, code = "", message = ""] = http;
    const said = `${who} returned ${code}`;
    const detail = message.trim();
    return detail ? { clause: `${said} (${detail})`, short: `${said}: ${detail}` } : { clause: said, short: said };
  }
  const lower = text.toLowerCase();
  if (/is not set/.test(lower) || /key (is )?missing/.test(lower) || /no key/.test(lower)) {
    return { clause: `${who}'s key was missing`, short: `${who} key not set` };
  }
  if (/cannot be decrypted|gateway_secret/.test(lower)) {
    return { clause: `${who}'s stored key could not be read`, short: `${who} key unreadable` };
  }
  if (lower === "provider disabled") return { clause: `${who} was disabled`, short: `${who} disabled` };
  if (lower === "provider not found") return { clause: `${who} no longer existed`, short: `${who} not found` };
  if (lower === "provider limits exceeded") return { clause: `the request was over ${who}'s limits`, short: `over ${who}'s limits` };
  if (/timed? ?out|timeout/.test(lower)) return { clause: `${who} timed out`, short: `${who} timed out` };
  const status = /returned (\d{3})/.exec(lower);
  if (status) return { clause: `${who} returned ${status[1]}`, short: `${who} returned ${status[1]}` };
  if (text.length === 0) return { clause: `${who} failed`, short: `${who} failed` };
  return { clause: `${who} failed (${text})`, short: `${who}: ${text}` };
}

/** "a", "a and b", "a, b and c". */
export function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface OutcomeInput {
  status: "ok" | "error";
  attempts: readonly Attempt[];
  /** The connection that answered (or was tried last), as the log names it. */
  provider: string;
  error: string | null;
  /** Who the upstream says served the answer ("Perplexity"), when it says. */
  served_by?: string | null;
  /** The model id the upstream resolved the requested one to, when it says. */
  upstream_model_resolved?: string | null;
}

/**
 * Who answered, in words: the connection's title, or "Perplexity via OpenRouter" when the upstream
 * names who served it. A name the same as the connection's is said once.
 */
export function answeredBy(connection: string, servedBy: string | null | undefined): string {
  const served = servedBy?.trim();
  if (!served || served.toLowerCase() === connection.toLowerCase()) return connection;
  return `${served} via ${connection}`;
}

/**
 * The answering side as one line: "Perplexity via OpenRouter · perplexity/pplx-decider-flash-v1.2-20261016"
 * when the upstream names who served it, else the connection and the model it was sent.
 */
export function answeredByLine(
  answer: { provider: string; upstream_model: string; served_by?: string | null; upstream_model_resolved?: string | null },
  titleOf: TitleOf = (name) => name,
): string {
  if (!answer.served_by) return `${titleOf(answer.provider)} · ${answer.upstream_model}`;
  const who = answeredBy(titleOf(answer.provider), answer.served_by);
  return answer.upstream_model_resolved ? `${who} · ${answer.upstream_model_resolved}` : who;
}

/** The outcome of a request in one sentence. */
export function outcomeSentence(entry: OutcomeInput, titleOf: TitleOf = (name) => name): string {
  const failures = entry.attempts.filter((attempt) => !attempt.ok);
  if (entry.status === "ok") {
    const winner = [...entry.attempts].reverse().find((attempt) => attempt.ok);
    const who = answeredBy(titleOf(winner?.provider ?? entry.provider), entry.served_by);
    const after =
      failures.length === 0
        ? ""
        : ` after ${joinWords(failures.map((attempt) => attemptReason(attempt.error, titleOf(attempt.provider)).clause))}`;
    const model = entry.served_by && entry.upstream_model_resolved ? ` · ${entry.upstream_model_resolved}` : "";
    return `Answered by ${who}${after}${model}`;
  }
  if (failures.length === 0) return `Failed: ${entry.error ?? "no attempt was made"}`;
  return `Failed: ${failures.map((attempt) => attemptReason(attempt.error, titleOf(attempt.provider)).short).join(", ")}`;
}
