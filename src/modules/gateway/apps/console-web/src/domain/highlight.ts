// Token streams for the code blocks: JSON bodies and the equivalent curl command. Joining the
// tokens' text always gives back the input exactly, so highlighting never changes what is copied.

export type JsonTokenKind = "key" | "string" | "number" | "literal" | "punct" | "space" | "text";

export interface Token<K extends string> {
  kind: K;
  text: string;
}

const JSON_PATTERN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)/g;

/** Splits JSON text into tokens. A quoted string followed by a colon is a key. */
export function tokenizeJson(text: string): Token<JsonTokenKind>[] {
  const tokens: Token<JsonTokenKind>[] = [];
  let cursor = 0;
  for (const match of text.matchAll(JSON_PATTERN)) {
    const index = match.index;
    if (index > cursor) tokens.push({ kind: "text", text: text.slice(cursor, index) });
    const [whole, quoted, colon, number, literal, punct, space] = match;
    if (quoted !== undefined) {
      tokens.push({ kind: colon !== undefined ? "key" : "string", text: quoted });
      if (colon !== undefined) {
        const gap = colon.slice(0, -1);
        if (gap.length > 0) tokens.push({ kind: "space", text: gap });
        tokens.push({ kind: "punct", text: ":" });
      }
    } else if (number !== undefined) tokens.push({ kind: "number", text: number });
    else if (literal !== undefined) tokens.push({ kind: "literal", text: literal });
    else if (punct !== undefined) tokens.push({ kind: "punct", text: punct });
    else if (space !== undefined) tokens.push({ kind: "space", text: space });
    cursor = index + whole.length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
  return tokens;
}

export type ShellTokenKind = "command" | "flag" | "string" | "variable" | "url" | "continuation" | "space" | "text";

const SHELL_PATTERN =
  /('[^']*'|"(?:[^"\\]|\\.)*")|(\\\n)|(\\[\s\S])|(\s+)|(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)|(--?[A-Za-z][\w-]*)|(https?:\/\/[^\s'"]+)|([^\s'"$\\]+)|([\s\S])/g;

/** Splits a shell command into tokens. The first bare word is the command. */
export function tokenizeShell(text: string): Token<ShellTokenKind>[] {
  const tokens: Token<ShellTokenKind>[] = [];
  let sawCommand = false;
  for (const match of text.matchAll(SHELL_PATTERN)) {
    const [whole, quoted, continuation, escaped, space, variable, flag, url, word] = match;
    if (quoted !== undefined) tokens.push({ kind: "string", text: quoted });
    else if (continuation !== undefined) tokens.push({ kind: "continuation", text: continuation });
    else if (escaped !== undefined) tokens.push({ kind: "text", text: escaped });
    else if (space !== undefined) tokens.push({ kind: "space", text: space });
    else if (variable !== undefined) tokens.push({ kind: "variable", text: variable });
    else if (flag !== undefined) tokens.push({ kind: "flag", text: flag });
    else if (url !== undefined) tokens.push({ kind: "url", text: url });
    else if (word !== undefined && !sawCommand) {
      tokens.push({ kind: "command", text: word });
      sawCommand = true;
    } else tokens.push({ kind: "text", text: whole });
  }
  return tokens;
}

export type CodeTokenKind = JsonTokenKind | ShellTokenKind;

/**
 * A curl command with the JSON inside its single-quoted body highlighted as JSON, so the
 * payload reads like the trace blocks beside it.
 */
export function tokenizeCurl(text: string): Token<CodeTokenKind>[] {
  return tokenizeShell(text).flatMap((token): Token<CodeTokenKind>[] => {
    const inner = token.text.slice(1, -1);
    if (token.kind !== "string" || !token.text.startsWith("'") || !/^\s*[{[]/.test(inner)) return [token];
    return [{ kind: "string", text: "'" }, ...tokenizeJson(inner), { kind: "string", text: "'" }];
  });
}
