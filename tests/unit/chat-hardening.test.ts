// The chat wire's hardening from the open-model run of 2026-11-11: reasoning turned off by default on OpenRouter, the
// mandatory-reasoning retry, the opaque top_logprobs 400 and its retry with 5, and logprob tokens kept in traces.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  chatBody,
  disablesReasoning,
  jsonChatBody,
  logprobsRefusal,
  mandatoryReasoning,
  optionCount,
  reasoningFields,
  reasoningTune,
  retriesTopLogprobs,
  sentTopLogprobs,
  supportsReasoning,
  REASONING_BUDGET,
  type ReasoningProvider,
} from '../../src/modules/gateway/libs/decisions/functions/chat';
import { redact } from '../../src/modules/gateway/libs/management/functions/redact';
import {
  CATALOG_RETRY_MS,
  catalogFetchDue,
  catalogFetchPlan,
  catalogParameters,
  supportedParameters,
} from '../../src/modules/gateway/libs/management/functions/admin';
import type { Question } from '../../src/modules/gateway/libs/decisions/schemas/types';

const failures = (
  JSON.parse(readFileSync(new URL('../fixtures/chat-real-open.json', import.meta.url), 'utf8')) as {
    failures: Record<string, { error: string }>;
  }
).failures;

// The upstream message the gateway put after "upstream HTTP <status>: ".
const message = (key: string) => failures[key].error.replace(/^upstream HTTP \d+: /, '');

const provider = (
  kind: ReasoningProvider['kind'],
  more: Partial<ReasoningProvider> = {},
): ReasoningProvider => ({ kind, extra_body: {}, ...more });

// supported_parameters from OpenRouter's real catalog (GET /api/v1/models, 2026-11-11).
const THINKS = [
  'include_reasoning',
  'logprobs',
  'max_tokens',
  'reasoning',
  'reasoning_effort',
  'top_logprobs',
];
// meta-llama/llama-4-maverick: no reasoning settings.
const PLAIN = ['logprobs', 'max_tokens', 'response_format', 'temperature', 'top_logprobs'];

const predicate: Question = { name: 'p', type: 'predicate', instructions: 'test' };

const choice = (count: number): Question => ({
  name: 'c',
  type: 'choice',
  instructions: 'pick',
  choices: Array.from({ length: count }, (_, i) => ({ value: i, description: String(i) })),
});

describe('turning reasoning off', () => {
  test('disable_reasoning defaults to true for openrouter only, and an owner setting wins', () => {
    expect(disablesReasoning(provider('openrouter'))).toBe(true);
    for (const kind of ['openai', 'openai-compatible', 'systemone', 'mock'] as const)
      expect(disablesReasoning(provider(kind))).toBe(false);
    expect(disablesReasoning(provider('openrouter', { disable_reasoning: false }))).toBe(false);
    expect(disablesReasoning(provider('openai', { disable_reasoning: true }))).toBe(true);
  });

  test('each kind sends its documented field, or nothing', () => {
    expect(reasoningFields(provider('openrouter'), 'off', THINKS)).toEqual({
      reasoning: { enabled: false },
    });
    expect(reasoningFields(provider('openrouter'), 'low', THINKS)).toEqual({
      reasoning: { effort: 'low' },
    });
    expect(reasoningFields(provider('openai'), 'off', THINKS)).toEqual({});
    expect(reasoningFields(provider('openai-compatible'), 'off', THINKS)).toEqual({});
    expect(reasoningFields(provider('openai', { disable_reasoning: true }), 'off', THINKS)).toEqual(
      {
        reasoning_effort: 'none',
      },
    );
    expect(
      reasoningFields(provider('openai-compatible', { disable_reasoning: true }), 'low', THINKS),
    ).toEqual({ reasoning_effort: 'low' });
    expect(
      reasoningFields(provider('systemone', { disable_reasoning: true }), 'off', THINKS),
    ).toEqual({});
    expect(
      reasoningFields(provider('openrouter', { disable_reasoning: false }), 'off', THINKS),
    ).toEqual({});
  });

  test('on OpenRouter, reasoning goes only to a model whose cached catalog entry lists it', () => {
    expect(supportsReasoning(THINKS)).toBe(true);
    expect(supportsReasoning(['include_reasoning'])).toBe(true);
    expect(supportsReasoning(['reasoning'])).toBe(true);
    expect(supportsReasoning(PLAIN)).toBe(false);
    expect(supportsReasoning(null)).toBe(false);
    expect(supportsReasoning([])).toBe(false);
    const router = provider('openrouter');
    expect(reasoningFields(router, 'off', PLAIN)).toEqual({});
    expect(reasoningFields(router, 'off', null)).toEqual({});
    expect(reasoningFields(router, 'low', null)).toEqual({});
    expect(reasoningTune(router, 'low', PLAIN)).toEqual({ reasoning: {}, budget: 0 });
    expect(reasoningFields(router, 'off', ['include_reasoning'])).toEqual({
      reasoning: { enabled: false },
    });
    // OpenAI kinds have no catalog: the owner's setting alone decides.
    expect(reasoningFields(provider('openai', { disable_reasoning: true }), 'off', null)).toEqual({
      reasoning_effort: 'none',
    });
    // The owner's extra_body.reasoning goes out as it is, whatever the catalog says.
    const owned = provider('openrouter', { extra_body: { reasoning: { effort: 'low' } } });
    expect(reasoningFields(owned, 'off', PLAIN)).toEqual({});
    expect(
      chatBody('in', predicate, 'm', owned.extra_body, undefined, reasoningTune(owned, 'off', null))
        .reasoning,
    ).toEqual({ effort: 'low' });
  });

  test('an owner-set extra_body.reasoning or reasoning_effort always wins', () => {
    for (const extra_body of [
      { reasoning: { effort: 'high' } },
      { reasoning: { enabled: true } },
      { reasoning_effort: 'medium' },
    ]) {
      const p = provider('openrouter', { extra_body });
      expect(reasoningFields(p, 'off', THINKS)).toEqual({});
      const body = chatBody(
        'in',
        predicate,
        'm',
        extra_body,
        undefined,
        reasoningTune(p, 'off', THINKS),
      );
      expect(body).toMatchObject(extra_body);
      if (!('reasoning' in extra_body)) expect(body.reasoning).toBeUndefined();
    }
  });

  test('the low-effort step adds the reasoning budget to every method, and the owner budget wins', () => {
    const p = provider('openrouter');
    expect(reasoningTune(p, 'off', THINKS)).toEqual({
      reasoning: { reasoning: { enabled: false } },
      budget: 0,
    });
    const low = reasoningTune(p, 'low', THINKS);
    expect(low).toEqual({ reasoning: { reasoning: { effort: 'low' } }, budget: REASONING_BUDGET });
    expect(REASONING_BUDGET).toBe(2048);
    expect(chatBody('in', predicate, 'm', {}, undefined, low)).toMatchObject({
      max_tokens: 2049,
      reasoning: { effort: 'low' },
      logprobs: true,
    });
    expect(chatBody('in', predicate, 'm', {}, 4, low)).toMatchObject({
      max_tokens: 2056,
      n: 4,
      reasoning: { effort: 'low' },
    });
    const plain = jsonChatBody('in', [{ index: 0, question: predicate }], 'm', 'prompt', {});
    const tuned = jsonChatBody('in', [{ index: 0, question: predicate }], 'm', 'prompt', {}, low);
    expect(tuned.max_tokens).toBe((plain.max_tokens as number) + 2048);
    expect(tuned.reasoning).toEqual({ effort: 'low' });
    const owned = chatBody('in', predicate, 'm', { max_completion_tokens: 900 }, undefined, low);
    expect(owned.max_tokens).toBeUndefined();
    expect(owned.max_completion_tokens).toBe(900);
    // No reasoning field, no budget: a kind that sends nothing keeps its usual limits.
    expect(reasoningTune(provider('openai'), 'low', THINKS)).toEqual({ reasoning: {}, budget: 0 });
  });

  test('the real mandatory-reasoning refusals are recognized, and unrelated errors are not', () => {
    const venice = message('openrouter-qwen3-235b-thinking-no-reasoning');
    const glm = message('openrouter-glm-5.3-flash-no-reasoning');
    expect(venice).toBe('Reasoning is mandatory for this endpoint and cannot be disabled.');
    for (const text of [venice, glm]) {
      expect(mandatoryReasoning(400, { error: { message: text, code: 400 } })).toBe(true);
      expect(mandatoryReasoning(400, text)).toBe(true);
      expect(mandatoryReasoning(500, { error: { message: text } })).toBe(false);
    }
    expect(mandatoryReasoning(422, { error: { message: 'reasoning is required' } })).toBe(true);
    for (const text of [
      message('openrouter-glm-5.3-flash-fireworks-top20-logprobs'),
      'reasoning tokens are billed. The field is required.',
      "Unsupported parameter: 'logprobs' is not supported with this model.",
    ])
      expect(mandatoryReasoning(400, { error: { message: text } })).toBe(false);
  });
});

describe('the top_logprobs refusal', () => {
  // OpenRouter's body for a host error: the message names nothing; the host's own text sits in metadata.raw.
  const opaque = (raw: string, provider_name: string) => ({
    error: { message: 'Provider returned error', code: 400, metadata: { raw, provider_name } },
  });

  test('an opaque 400 from Novita or Fireworks, or a 400 naming top_logprobs, is a top_logprobs refusal', () => {
    expect(message('openrouter-qwen3.8-27b-novita-top20-logprobs')).toBe('Provider returned error');
    expect(logprobsRefusal(400, opaque('invalid request error', 'Novita'))).toBe('top_logprobs');
    expect(logprobsRefusal(400, opaque('Request failed with HTTP status 400.', 'Fireworks'))).toBe(
      'top_logprobs',
    );
    expect(logprobsRefusal(400, 'Bad Request')).toBe('top_logprobs');
    expect(
      logprobsRefusal(400, { error: { message: 'top_logprobs must be at most 5', param: 'x' } }),
    ).toBe('top_logprobs');
  });

  test('a 4xx naming logprobs means no logprobs, as OpenAI reasoning models answer', () => {
    const openai = {
      error: {
        message: "Unsupported parameter: 'logprobs' is not supported with this model.",
        type: 'invalid_request_error',
        param: 'logprobs',
        code: 'unsupported_parameter',
      },
    };
    expect(logprobsRefusal(400, openai)).toBe('unsupported');
    expect(logprobsRefusal(422, { error: { message: 'top_logprobs too large' } })).toBe(
      'unsupported',
    );
  });

  test('a 400 about another parameter or the model, and every other status, keeps its normal rules', () => {
    for (const text of [
      'qwen/x is not a valid model ID',
      'messages: too long',
      'max_tokens must be positive',
      "This endpoint's maximum context length is 8192 tokens",
      'temperature out of range',
      message('openrouter-glm-5.3-flash-no-reasoning'),
    ])
      expect(logprobsRefusal(400, { error: { message: text } })).toBe('other');
    expect(logprobsRefusal(400, { error: { message: 'bad', param: 'messages' } })).toBe('other');
    for (const status of [401, 403, 404, 422, 429, 500, 502, undefined])
      expect(logprobsRefusal(status, opaque('invalid request error', 'Novita'))).toBe('other');
  });

  test('the retry with 5 needs a larger first request and at most 5 options', () => {
    expect(optionCount(predicate)).toBe(2);
    expect(optionCount(choice(7))).toBe(7);
    expect(retriesTopLogprobs(20, predicate)).toBe(true);
    expect(retriesTopLogprobs(20, choice(5))).toBe(true);
    expect(retriesTopLogprobs(20, choice(6))).toBe(false);
    expect(retriesTopLogprobs(20, choice(7))).toBe(false);
    const tenLevels: Question = {
      name: 's',
      type: 'score',
      instructions: 'rate',
      levels: Array.from({ length: 10 }, (_, i) => ({ description: String(i) })),
    };
    expect(retriesTopLogprobs(20, tenLevels)).toBe(false);
    expect(retriesTopLogprobs(5, predicate)).toBe(false);
    expect(retriesTopLogprobs(3, predicate)).toBe(false);
  });

  test('the sent top_logprobs is the learned value, else extra_body, else 20', () => {
    expect(sentTopLogprobs({})).toBe(20);
    expect(sentTopLogprobs({ top_logprobs: 5 })).toBe(5);
    expect(sentTopLogprobs({ top_logprobs: 10 }, 5)).toBe(5);
  });

  test('the retry value replaces extra_body top_logprobs on logprobs calls only', () => {
    const extra = { top_logprobs: 20 };
    expect(chatBody('in', predicate, 'm', extra, undefined, { topLogprobs: 5 }).top_logprobs).toBe(
      5,
    );
    expect(chatBody('in', predicate, 'm', extra).top_logprobs).toBe(20);
    expect(
      chatBody('in', predicate, 'm', extra, 4, { topLogprobs: 5 }).top_logprobs,
    ).toBeUndefined();
  });
});

describe('trace redaction and logprob tokens', () => {
  const completion = {
    choices: [
      {
        message: { content: 'A' },
        logprobs: {
          content: [
            {
              token: 'A',
              logprob: -0.01,
              bytes: [65],
              top_logprobs: [
                { token: 'A', logprob: -0.01, bytes: [65] },
                { token: 'B', logprob: -4.6, bytes: [66] },
              ],
            },
          ],
        },
      },
    ],
  };

  test('logprob tokens and bytes stay readable', () => {
    expect(redact(completion)).toEqual(completion);
    expect(redact({ top_logprobs: [{ token: 'Yes', logprob: -0.1 }] })).toEqual({
      top_logprobs: [{ token: 'Yes', logprob: -0.1 }],
    });
  });

  test('every credential rule still redacts, inside and outside logprobs', () => {
    expect(redact({ token: 'tok-123', logprob: -0.1 })).toEqual({
      token: '[REDACTED]',
      logprob: -0.1,
    });
    expect(
      redact({
        headers: { Authorization: 'Bearer x', token: 'y' },
        token: 'z',
        access_token: 'w',
        api_key: 'v',
      }),
    ).toEqual({
      headers: { Authorization: '[REDACTED]', token: '[REDACTED]' },
      token: '[REDACTED]',
      access_token: '[REDACTED]',
      api_key: '[REDACTED]',
    });
    // Inside logprobs, a token without a numeric logprob beside it and every other credential name are hidden.
    expect(
      redact({
        logprobs: {
          token: 'not-an-entry',
          content: [{ token: 'A', logprob: 'x', access_token: 'q', api_key: 'r' }],
        },
      }),
    ).toEqual({
      logprobs: {
        token: '[REDACTED]',
        content: [
          { token: '[REDACTED]', logprob: 'x', access_token: '[REDACTED]', api_key: '[REDACTED]' },
        ],
      },
    });
  });

  test('a trace with a real-looking secret beside logprobs keeps the tokens and hides the secret', () => {
    const secret = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const trace = {
      headers: { authorization: `Bearer ${secret}` },
      token: secret,
      user_id: 'user_2abcdefgh123',
      echo: `key was ${secret}`,
      ...completion,
      choices: [
        {
          ...completion.choices[0],
          logprobs: {
            content: [
              {
                token: secret,
                logprob: -9,
                top_logprobs: [{ token: 'A', logprob: -0.01, bytes: [65] }],
              },
            ],
          },
        },
      ],
    };
    const out = redact(trace, [secret]) as typeof trace;
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.headers.authorization).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.user_id).toBe('[REDACTED]');
    expect(out.echo).toBe('key was [REDACTED]');
    expect(out.choices[0].logprobs.content[0].token).toBe('[REDACTED]');
    expect(out.choices[0].logprobs.content[0].top_logprobs[0]).toEqual({
      token: 'A',
      logprob: -0.01,
      bytes: [65],
    });
  });
});

describe('supported_parameters in the OpenRouter catalog', () => {
  test('the listing gives each model its supported_parameters, and malformed lists are left out', () => {
    const body = {
      data: [
        { id: 'qwen/qwen3.8-27b', supported_parameters: THINKS },
        { id: 'meta-llama/llama-4-maverick', supported_parameters: PLAIN },
        { id: 'no-list' },
        { id: 'bad-list', supported_parameters: ['reasoning', 3] },
        { supported_parameters: ['reasoning'] },
      ],
    };
    const parameters = catalogParameters(body);
    expect(parameters).toEqual({
      'qwen/qwen3.8-27b': THINKS,
      'meta-llama/llama-4-maverick': PLAIN,
    });
    expect(catalogParameters({})).toEqual({});
    const entry = { expires: 0, models: [], parameters };
    expect(supportedParameters(entry, 'qwen/qwen3.8-27b')).toEqual(THINKS);
    expect(supportedParameters(entry, 'no-list')).toBeNull();
    expect(supportedParameters(undefined, 'qwen/qwen3.8-27b')).toBeNull();
    expect(supportedParameters({ expires: 0, models: [] }, 'qwen/qwen3.8-27b')).toBeNull();
  });
});

describe('when a decision fetches the catalog', () => {
  const router = { kind: 'openrouter' as const, wire: 'chat' as const };

  test('only a chat-wire OpenRouter provider without a cached catalog, outside the retry backoff', () => {
    expect(CATALOG_RETRY_MS).toBe(300000);
    expect(catalogFetchDue(router, false, undefined, 0)).toBe(true);
    expect(catalogFetchDue(router, true, undefined, 0)).toBe(false);
    expect(catalogFetchDue({ ...router, wire: 'map' }, false, undefined, 0)).toBe(false);
    expect(catalogFetchDue({ kind: 'openai', wire: 'chat' }, false, undefined, 0)).toBe(false);
    expect(catalogFetchDue(router, false, 1000, 1000 + CATALOG_RETRY_MS - 1)).toBe(false);
    expect(catalogFetchDue(router, false, 1000, 1000 + CATALOG_RETRY_MS)).toBe(true);
  });

  test('it makes the models endpoint request and waits at most 2 seconds', () => {
    expect(
      catalogFetchPlan({
        base_url: 'https://openrouter.ai',
        path: '/api/v1/chat/completions',
        timeout_ms: 20000,
      }),
    ).toEqual({ url: 'https://openrouter.ai/api/v1/models', timeout: 2000 });
    expect(
      catalogFetchPlan({
        base_url: 'https://x.test',
        path: '/api/v1/chat/completions',
        timeout_ms: 500,
      }).timeout,
    ).toBe(500);
  });
});
