// JSON helpers for editable JSON fields (provider extra_body, captured payloads).

export type JsonObjectResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** Parses text that must be a JSON object. Empty text means an empty object. */
export function parseJsonObject(text: string): JsonObjectResult {
  if (text.trim().length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "the text is not valid JSON";
    return { ok: false, message: `Not valid JSON: ${detail}.` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "This must be a JSON object, for example {}." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2) ?? "";
}
