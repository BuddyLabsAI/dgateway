// Account identifiers, such as OpenRouter's user_id: they name the account a call was made for, so they are hidden like a
// credential, in a field's name and in free text.
const ACCOUNT_IDS =
  'user[-_]?id|account[-_]?id|org(?:anization)?[-_]?id|customer[-_]?id|session[-_]?id';

const sensitive = new RegExp(
  `(?:^|[_-])(authorization|api[_-]?key|key|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|credential|${ACCOUNT_IDS})(?:$|[_-])`,
  'i',
);

// Replaces every secret in every string, and, with redactFields, the value of every field whose name looks like a
// credential. `fields` adds names of its own, such as a provider's custom auth header: a field with that name (in
// any case) is hidden too. One exception keeps chat traces readable: inside a logprobs structure, the `token` of an
// entry that carries a numeric `logprob` (logprobs.content[].token, top_logprobs[].token) is a generated token, not a
// credential, so only secrets are replaced in it.
export function redact(
  value: unknown,
  secrets: string[] = [],
  redactFields = true,
  fields: readonly string[] = [],
  inLogprobs = false,
): unknown {
  if (typeof value === 'string') {
    let v = value;
    for (const s of secrets) if (s) v = v.split(s).join('[REDACTED]');
    return v;
  }
  if (Array.isArray(value))
    return value.map((x: unknown) => redact(x, secrets, redactFields, fields, inLogprobs));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const logprobEntry = inLogprobs && typeof record.logprob === 'number';
    return Object.fromEntries(
      Object.entries(record).map(([k, v]): [string, unknown] => [
        k,
        redactFields && sensitiveField(k, fields) && !(logprobEntry && k === 'token')
          ? '[REDACTED]'
          : redact(v, secrets, redactFields, fields, inLogprobs || isLogprobsKey(k)),
      ]),
    );
  }
  return value;
}

const isLogprobsKey = (name: string) => name === 'logprobs' || name === 'top_logprobs';

function sensitiveField(name: string, fields: readonly string[]): boolean {
  return (
    sensitive.test(name) ||
    /^(apiKey|accessToken|refreshToken|authToken)$/i.test(name) ||
    fields.includes(name.toLowerCase())
  );
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Redacts "name: value" and "name=value" pairs in free text, such as an upstream body that was not JSON or an upstream
// error message. The names are the usual credential words, the account identifiers and `fields` (a custom auth header).
// A quote may close the name, and a bearer token after the name is the value. Words that are keys or account ids in
// prose are redacted too: an sk- key, and a user_ id, which always carries a digit (so user_settings is left alone).
export function redactText(text: string, fields: readonly string[] = []): string {
  const names = [
    'authorization',
    'api[-_]?key',
    'secret',
    'token',
    'password',
    ACCOUNT_IDS,
    ...fields.map(escapeRegex),
  ];
  return text
    .replace(
      new RegExp(`(${names.join('|')})(["']?)\\s*[:=]\\s*(?:bearer\\s+)?[^,;\\s}]+`, 'gi'),
      '$1$2=[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[REDACTED]')
    .replace(/\buser_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}/g, '[REDACTED]');
}
