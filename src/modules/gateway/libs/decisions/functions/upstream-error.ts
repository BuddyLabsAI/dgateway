// The readable message in an upstream error body, for an attempt's error text: OpenAI's and OpenRouter's
// {"error": {"message"}}, a top-level {"message"} or FastAPI's {"detail"}, an array of issues (zod's, which some
// providers send as a JSON-encoded string), or a plain-text body. Only those fields are read, never metadata. The text
// is redacted with the attempt's secrets and field names, and kept to about 300 characters. Pure.
import { redact, redactText } from '../../management/functions/redact';

// The longest message kept, in characters. A longer one is cut at a space, with an ellipsis.
const LIMIT = 300;
// How deep a message may nest: an error inside a message inside a detail, JSON inside a string, and so on.
const DEPTH = 6;

// What a message must not show: the secrets so far and the field names to hide (see hiddenValues in execution.ts).
export type Hidden = { secrets: string[]; fields: string[] };

export function upstreamErrorMessage(body: unknown, hidden: Hidden): string | null {
  const found = readMessage(body, 0);
  if (found === null) return null;
  const collapsed = found.replace(/\s+/g, ' ').trim();
  const redacted = redactText(String(redact(collapsed, hidden.secrets)), hidden.fields).trim();
  return redacted === '' ? null : fit(redacted);
}

// The message a value carries, or null when none is readable.
function readMessage(value: unknown, depth: number): string | null {
  if (depth > DEPTH) return null;
  if (typeof value === 'string') return readText(value, depth);
  if (Array.isArray(value)) return readIssues(value);
  if (!isRecord(value)) return null;
  // OpenAI and OpenRouter nest the message in error. A body that carries it at the top, as message or detail, is
  // read after that. A bare string under error is not read: the gateway has always reported such a body as its status.
  const nested =
    isRecord(value.error) || Array.isArray(value.error)
      ? readMessage(value.error, depth + 1)
      : null;
  return nested ?? readMessage(value.message, depth + 1) ?? readMessage(value.detail, depth + 1);
}

// A string is a message, unless it is JSON that carries one (read as the JSON it is) or markup, which is not one.
function readText(text: string, depth: number): string | null {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    const parsed = parseJson(trimmed);
    if (parsed !== undefined) return readMessage(parsed, depth + 1);
  }
  if (/^</.test(trimmed) && /<\/\w|<!doctype/i.test(trimmed)) return null;
  return trimmed === '' ? null : trimmed;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// An array of issues: each issue's message, with its path in front, in the order given.
function readIssues(items: unknown[]): string | null {
  const lines = items.map(readIssue).filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join('; ') : null;
}

function readIssue(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() || null;
  if (!isRecord(item)) return null;
  const text = [item.message, item.msg].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  if (text === undefined) return null;
  const path = pathOf(item.path ?? item.loc);
  return path ? `${path}: ${text.trim()}` : text.trim();
}

// A path as a dotted name, such as questions.q0.criteria.
function pathOf(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
    .join('.');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Cut to LIMIT at the last space before it, with an ellipsis, so that no word is cut in two. A cut never splits a
// surrogate pair, so the text stays well formed.
function fit(text: string): string {
  if (text.length <= LIMIT) return text;
  const head = text.slice(0, LIMIT).replace(/[\uD800-\uDBFF]$/, '');
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}
