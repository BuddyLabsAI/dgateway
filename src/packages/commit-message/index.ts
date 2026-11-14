// Checks commit messages against Conventional Commits 1.0 with a gitmoji after the colon:
// `type(scope)!: <emoji> subject`. Every function here is pure; the CLI in scripts/commit-msg.ts
// reads files and git history and passes the text in.

export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

// The emoji each type needs at the start of its subject. A message may write each one with or
// without the U+FE0F variation selector.
export const TYPE_EMOJI: Readonly<Record<CommitType, string>> = {
  feat: '✨',
  fix: '🐛',
  docs: '📝',
  style: '💄',
  refactor: '♻️',
  perf: '⚡️',
  test: '✅',
  build: '📦️',
  ci: '👷',
  chore: '🔧',
  revert: '⏪️',
};

export const MAX_HEADER_LENGTH = 100;

export const EXAMPLE_HEADERS = [
  'feat(console): ✨ add route search',
  'fix!: 🐛 reject empty question lists',
];

export type CheckOptions = {
  // Accept `fixup!`, `squash!` and `amend!` headers. The local hook allows them; CI does not.
  allowFixup?: boolean;
};

export type CommitKind = 'conventional' | 'merge' | 'revert' | 'fixup' | 'invalid';

export type CommitCheck = {
  ok: boolean;
  kind: CommitKind;
  header: string;
  type?: CommitType;
  scope?: string;
  subject?: string;
  breaking: boolean;
  errors: string[];
  // A corrected header, when the type is known and only the form is wrong.
  suggestion?: string;
};

const VARIATION_SELECTOR = /\uFE0F/g;
const HEADER = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?:(?<rest>.*)$/;
const SCOPE = /^[a-z0-9-]+$/;
const LEADING_EMOJI = /^\p{Extended_Pictographic}\uFE0F?/u;
const MERGE = /^Merge (branch(es)?|remote-tracking branch(es)?|tag|commit|pull request) \S/;
const REVERT = /^(Revert|Reapply) ".+"$/;
const FIXUP = /^(fixup|squash|amend)! \S/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: \S/;
const BREAKING_LIKE = /^breaking[ -]change\s*:/i;

const isCommitType = (value: string): value is CommitType =>
  (COMMIT_TYPES as readonly string[]).includes(value);

const baseEmoji = (emoji: string): string => emoji.replace(VARIATION_SELECTOR, '');

const lengthOf = (text: string): number => [...text].length;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Normalizes a message the way git's default cleanup does: drops everything from the scissors line
// on, drops comment lines (pass null to keep them, as for messages read back from history), trims
// trailing spaces, folds runs of blank lines and trims blank lines at both ends.
export function cleanMessage(raw: string, commentChar: string | null = '#'): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const scissors =
    commentChar === null ? null : new RegExp(`^${escapeRegex(commentChar)} -+ >8 -+$`);
  const kept: string[] = [];
  for (const line of lines) {
    if (scissors?.test(line)) break;
    if (commentChar !== null && line.startsWith(commentChar)) continue;
    const trimmed = line.trimEnd();
    if (trimmed === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(trimmed);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

// The subject text after its leading emoji, if it has one.
function splitSubject(subject: string): { emoji?: string; text: string } {
  const match = LEADING_EMOJI.exec(subject);
  if (!match) return { text: subject };
  return { emoji: match[0], text: subject.slice(match[0].length).trimStart() };
}

function buildHeader(type: string, scope: string | undefined, bang: boolean, subject: string) {
  return `${type}${scope === undefined ? '' : `(${scope})`}${bang ? '!' : ''}: ${subject}`;
}

// Checks the subject part (after `: `) of a conventional header for one type.
function subjectErrors(type: CommitType, rest: string): string[] {
  if (rest.trim() === '') return ['write a subject after the colon'];
  if (!rest.startsWith(' ') || rest.startsWith('  '))
    return ['put exactly one space after the colon'];
  const subject = rest.slice(1);
  const expected = TYPE_EMOJI[type];
  const { emoji, text } = splitSubject(subject);
  const errors: string[] = [];
  if (emoji === undefined)
    errors.push(`start the subject with ${expected}, the emoji for "${type}"`);
  else if (baseEmoji(emoji) !== baseEmoji(expected))
    errors.push(`"${type}" needs ${expected} at the start of the subject, not ${emoji}`);
  else if (!subject.slice(emoji.length).startsWith(' ') || text === '')
    errors.push(`put one space and then the subject text after ${expected}`);
  return errors;
}

function bodyErrors(lines: string[]): { errors: string[]; breaking: boolean } {
  const errors: string[] = [];
  if (lines.length > 1 && lines[1].trim() !== '')
    errors.push('leave a blank line between the header and the body');
  let breaking = false;
  for (const line of lines.slice(1)) {
    if (BREAKING_FOOTER.test(line)) breaking = true;
    else if (BREAKING_LIKE.test(line))
      errors.push('write the footer as "BREAKING CHANGE: <description>", in capital letters');
  }
  return { errors, breaking };
}

// A corrected header when the type can be recognized: lowercase type, the right emoji, one space.
export function suggestHeader(header: string): string | undefined {
  const match = HEADER.exec(header);
  if (!match?.groups) return undefined;
  const type = match.groups.type.toLowerCase();
  if (!isCommitType(type)) return undefined;
  const { text } = splitSubject(match.groups.rest.trim());
  if (text === '') return undefined;
  const scope = match.groups.scope?.trim().toLowerCase();
  const suggestion = buildHeader(
    type,
    scope === '' ? undefined : scope,
    match.groups.bang === '!',
    `${TYPE_EMOJI[type]} ${text}`,
  );
  return suggestion === header ? undefined : suggestion;
}

type HeaderCheck = Omit<CommitCheck, 'ok' | 'suggestion'>;

function checkConventional(header: string): HeaderCheck {
  const match = HEADER.exec(header);
  if (!match?.groups)
    return {
      kind: 'invalid',
      header,
      breaking: false,
      errors: ['the header must look like "type(scope): emoji subject"'],
    };
  const { type: rawType, scope, bang, rest } = match.groups;
  const lower = rawType.toLowerCase();
  const type = isCommitType(lower) ? lower : undefined;
  const errors: string[] = [];
  if (type === undefined) errors.push(`"${rawType}" is not a commit type`);
  else if (rawType !== type) errors.push(`write the type in lowercase: "${type}"`);
  if (scope !== undefined && !SCOPE.test(scope))
    errors.push('the scope may use only lowercase letters, digits and hyphens');
  if (type !== undefined) errors.push(...subjectErrors(type, rest));
  if (lengthOf(header) > MAX_HEADER_LENGTH)
    errors.push(`keep the header at ${MAX_HEADER_LENGTH} characters or fewer`);
  return {
    kind: 'conventional',
    header,
    type,
    scope,
    subject: rest.trim(),
    breaking: bang === '!',
    errors,
  };
}

// Checks a cleaned commit message (see cleanMessage). The header is the first line.
export function checkCommitMessage(message: string, options: CheckOptions = {}): CommitCheck {
  const lines = message.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0].trimEnd();
  if (header.trim() === '')
    return {
      ok: false,
      kind: 'invalid',
      header,
      breaking: false,
      errors: ['the message is empty'],
    };
  if (FIXUP.test(header)) {
    const errors = options.allowFixup
      ? []
      : ['squash fixup!, squash! and amend! commits before you merge (git rebase -i --autosquash)'];
    return { ok: errors.length === 0, kind: 'fixup', header, breaking: false, errors };
  }
  const body = bodyErrors(lines);
  if (MERGE.test(header) || REVERT.test(header)) {
    const kind = MERGE.test(header) ? 'merge' : 'revert';
    return { ok: body.errors.length === 0, kind, header, breaking: false, errors: body.errors };
  }
  const result = checkConventional(header);
  const errors = [...result.errors, ...body.errors];
  const suggestion = errors.length > 0 ? suggestHeader(header) : undefined;
  return {
    ...result,
    ok: errors.length === 0,
    breaking: result.breaking || body.breaking,
    errors,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

// Inserts the type's emoji into a raw message file when the header is a conventional header whose
// subject has no emoji yet. Comment lines and line endings stay as they are. A wrong emoji is left
// for checkCommitMessage to report.
export function addMissingEmoji(
  raw: string,
  commentChar = '#',
): { message: string; changed: boolean } {
  const lines = raw.split('\n');
  const index = lines.findIndex((line) => line.trim() !== '' && !line.startsWith(commentChar));
  if (index === -1) return { message: raw, changed: false };
  const line = lines[index];
  const ending = line.endsWith('\r') ? '\r' : '';
  const header = line.slice(0, line.length - ending.length);
  const match = HEADER.exec(header);
  if (!match?.groups || !isCommitType(match.groups.type)) return { message: raw, changed: false };
  const subject = match.groups.rest.trim();
  if (subject === '' || LEADING_EMOJI.test(subject)) return { message: raw, changed: false };
  const { type, scope, bang } = match.groups;
  lines[index] =
    `${buildHeader(type, scope, bang === '!', `${TYPE_EMOJI[type]} ${subject}`)}${ending}`;
  return { message: lines.join('\n'), changed: true };
}

// A readable report for a failed check, ending with valid examples.
export function formatReport(check: CommitCheck, label?: string): string {
  const lines = [`${label ? `${label}: ` : ''}invalid commit message`, `  header: ${check.header}`];
  for (const error of check.errors) lines.push(`  - ${error}`);
  if (check.suggestion) lines.push(`  corrected header: ${check.suggestion}`);
  lines.push(
    `  format: type(scope)!: <emoji> subject, at most ${MAX_HEADER_LENGTH} characters`,
    `  types and emoji: ${COMMIT_TYPES.map((type) => `${type} ${TYPE_EMOJI[type]}`).join(', ')}`,
    `  examples: ${EXAMPLE_HEADERS.join(' | ')}`,
  );
  return lines.join('\n');
}
