import { describe, expect, test } from 'bun:test';
import { upstreamErrorMessage } from '../../src/modules/gateway/libs/decisions/functions/upstream-error';
import {
  failedOutcome,
  reduceAttempt,
} from '../../src/modules/gateway/libs/decisions/functions/execution';
import {
  CallFailure,
  type State,
} from '../../src/modules/gateway/libs/decisions/schemas/execution';

// The 404 OpenRouter answered live. The user_id that came with it is removed from the captured copy; the variant below
// puts one back in the metadata, where it must never be read.
const OPENROUTER_404 = {
  error: {
    message:
      '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\nZDR violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy',
    code: 404,
    metadata: {
      input_endpoint_count: 1,
      ineligibility_reasons: [
        {
          reason: 'zdr-violation-by-account',
          endpoint_count: 1,
          configure_url: 'https://openrouter.ai/settings/privacy',
        },
      ],
    },
  },
};
const OPENROUTER_MESSAGE =
  '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons): ZDR violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy';
const USER_ID = 'user_2Zq9xYzAbc';
const WITH_USER_ID = {
  error: {
    ...OPENROUTER_404.error,
    metadata: { ...OPENROUTER_404.error.metadata, user_id: USER_ID },
  },
};
const NOTHING_HIDDEN = { secrets: [], fields: [] };

describe('the readable message of an upstream error body', () => {
  test("OpenRouter's 404 comes through whole, and a user_id beside it is never read", () => {
    expect(upstreamErrorMessage(OPENROUTER_404, NOTHING_HIDDEN)).toBe(OPENROUTER_MESSAGE);
    const message = upstreamErrorMessage(WITH_USER_ID, NOTHING_HIDDEN);
    expect(message).toBe(OPENROUTER_MESSAGE);
    expect(message).not.toContain('user_id');
    expect(message).not.toContain(USER_ID);
  });

  test("OpenAI's style, with the message under error, reads the same way", () => {
    expect(
      upstreamErrorMessage(
        {
          error: {
            message: 'The model `gpt-6-luna` does not exist or you do not have access to it.',
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        },
        NOTHING_HIDDEN,
      ),
    ).toBe('The model `gpt-6-luna` does not exist or you do not have access to it.');
  });

  test('a top-level message, and FastAPI detail as text or as issues', () => {
    expect(upstreamErrorMessage({ message: 'Rate limit exceeded' }, NOTHING_HIDDEN)).toBe(
      'Rate limit exceeded',
    );
    expect(upstreamErrorMessage({ detail: 'Not found' }, NOTHING_HIDDEN)).toBe('Not found');
    expect(
      upstreamErrorMessage(
        { detail: [{ loc: ['body', 'model'], msg: 'Field required', type: 'missing' }] },
        NOTHING_HIDDEN,
      ),
    ).toBe('body.model: Field required');
  });

  test("an array of zod's issues, sent as the message string, reads as its issues", () => {
    const issues = [
      {
        expected: 'array',
        code: 'invalid_type',
        path: ['questions', 'q0', 'criteria'],
        message: 'Invalid input: expected array, received object',
      },
    ];
    const asString = { error: { message: JSON.stringify(issues), code: 400 } };
    expect(upstreamErrorMessage(asString, NOTHING_HIDDEN)).toBe(
      'questions.q0.criteria: Invalid input: expected array, received object',
    );
    expect(upstreamErrorMessage(issues, NOTHING_HIDDEN)).toBe(
      'questions.q0.criteria: Invalid input: expected array, received object',
    );
    const two = [
      { code: 'invalid_type', path: ['questions', 'q0'], message: 'Required' },
      { code: 'too_small', path: [], message: 'Too few questions' },
    ];
    expect(upstreamErrorMessage({ error: { message: JSON.stringify(two) } }, NOTHING_HIDDEN)).toBe(
      'questions.q0: Required; Too few questions',
    );
  });

  test('a plain-text body is its text, with the whitespace collapsed', () => {
    expect(upstreamErrorMessage('Bad Gateway', NOTHING_HIDDEN)).toBe('Bad Gateway');
    expect(upstreamErrorMessage('Service\n   Unavailable\n', NOTHING_HIDDEN)).toBe(
      'Service Unavailable',
    );
  });

  test('a JSON message inside a string reads as the JSON it is', () => {
    expect(
      upstreamErrorMessage({ error: { message: '{"detail":"Gone for good"}' } }, NOTHING_HIDDEN),
    ).toBe('Gone for good');
    expect(upstreamErrorMessage('{"error":{"message":"Nested"}}', NOTHING_HIDDEN)).toBe('Nested');
  });

  test('an empty body, or one with nothing readable, has no message', () => {
    for (const body of [
      '',
      '  \n ',
      null,
      42,
      [],
      {},
      { error: {} },
      { error: { code: 404 } },
      { error: 'boom' },
      '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>',
    ])
      expect(upstreamErrorMessage(body, NOTHING_HIDDEN)).toBeNull();
  });

  test('a credential in the message is redacted: the attempt keys, key-shaped words and name pairs', () => {
    expect(
      upstreamErrorMessage(
        { error: { message: 'Key exact-secret-value-9 is not valid' } },
        { secrets: ['exact-secret-value-9'], fields: [] },
      ),
    ).toBe('Key [REDACTED] is not valid');
    expect(
      upstreamErrorMessage(
        { error: { message: 'Incorrect API key provided: sk-proj-9f8e7d6c5b4a' } },
        NOTHING_HIDDEN,
      ),
    ).toBe('Incorrect API key provided: [REDACTED]');
    expect(
      upstreamErrorMessage(
        { error: { message: 'api_key=abc123, token: t0k3n, Authorization: Bearer b3areR' } },
        NOTHING_HIDDEN,
      ),
    ).toBe('api_key=[REDACTED], token=[REDACTED], Authorization=[REDACTED]');
    expect(
      upstreamErrorMessage(
        { error: { message: 'x-vendor-pass: pass-7788 was refused' } },
        { secrets: [], fields: ['x-vendor-pass'] },
      ),
    ).toBe('x-vendor-pass=[REDACTED] was refused');
  });

  test('an account identifier in the message is redacted, named or bare, and a word is left alone', () => {
    expect(
      upstreamErrorMessage(
        { error: { message: 'user_id: user_2Zq9xYzAbc is not allowed here' } },
        NOTHING_HIDDEN,
      ),
    ).toBe('user_id=[REDACTED] is not allowed here');
    expect(
      upstreamErrorMessage(
        { error: { message: 'the user user_2Zq9xYzAbc cannot use user_settings' } },
        NOTHING_HIDDEN,
      ),
    ).toBe('the user [REDACTED] cannot use user_settings');
  });

  test('a long message is kept to about 300 characters, cut at a space and never mid-word', () => {
    const long = Array.from({ length: 120 }, () => 'word').join(' ');
    const message = upstreamErrorMessage({ error: { message: long } }, NOTHING_HIDDEN);
    expect(message).not.toBeNull();
    expect(message!.length).toBeLessThanOrEqual(301);
    expect(message!.endsWith('…')).toBe(true);
    expect(
      message!
        .slice(0, -1)
        .split(' ')
        .every((word) => word === 'word'),
    ).toBe(true);
  });

  test('a secret is redacted before the message is cut, so no part of it survives the cut', () => {
    const text = `${'x'.repeat(290)} sk-proj-9f8e7d6c5b4a and the rest of the text`;
    const message = upstreamErrorMessage({ error: { message: text } }, NOTHING_HIDDEN);
    expect(message).toBe(`${'x'.repeat(290)}…`);
    expect(message).not.toContain('sk-proj');
    expect(message).not.toContain('9f8e');
  });
});

describe('the attempt error text, as the attempt reduces to state', () => {
  const start: State = {
    route: 'decider',
    attempts: [],
    secrets: [],
    fields: [],
    provider: null,
    model: null,
    upstreamRequest: null,
    upstreamResponse: null,
    answered: null,
    error: null,
    status: 200,
    stop: false,
  };

  const attempt = (status: number, body: unknown, message = `upstream HTTP ${status}`) =>
    failedOutcome(
      'openrouter',
      'perplexity/pplx-decider-flash-v1.2',
      0,
      12,
      new CallFailure('http', message, status, body),
      { input: 'classify' },
      'sk-live-key-abcdef123456',
    );

  test('an HTTP error reads upstream HTTP <status>: <message> in the attempt, the response and the trace', () => {
    const state = reduceAttempt(start, attempt(404, WITH_USER_ID));
    const text = `upstream HTTP 404: ${OPENROUTER_MESSAGE}`;
    expect(state.attempts[0]?.error).toBe(text);
    expect(state.error).toEqual({ message: text, type: 'upstream_error' });
    // The trace keeps the body's shape, but its user_id value is redacted like any account identifier.
    expect(JSON.stringify(state.upstreamResponse)).not.toContain(USER_ID);
    expect(state.stop).toBe(false);
    expect(state.status).toBe(502);
  });

  test('the status still decides the fallback: a 400 stops the route, a 404 moves on', () => {
    expect(reduceAttempt(start, attempt(400, OPENROUTER_404)).stop).toBe(true);
    expect(reduceAttempt(start, attempt(404, OPENROUTER_404)).stop).toBe(false);
  });

  test('an HTTP error with nothing readable keeps the bare status', () => {
    expect(reduceAttempt(start, attempt(502, { error: 'boom' })).attempts[0]?.error).toBe(
      'upstream HTTP 502',
    );
    expect(reduceAttempt(start, attempt(500, 'boom')).attempts[0]?.error).toBe(
      'upstream HTTP 500: boom',
    );
  });

  test('the attempt key is redacted from the message, and errors without a body are unchanged', () => {
    const leaky = { error: { message: 'Bad key sk-live-key-abcdef123456' } };
    expect(reduceAttempt(start, attempt(401, leaky)).attempts[0]?.error).toBe(
      'upstream HTTP 401: Bad key [REDACTED]',
    );
    const timeout = failedOutcome('openrouter', 'm', 0, 12, new CallFailure('timeout', 'timeout'));
    expect(reduceAttempt(start, timeout).attempts[0]?.error).toBe('timeout');
  });
});
