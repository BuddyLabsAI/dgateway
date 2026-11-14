import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/modules/gateway/libs/management/providers/store';
import { createGateway } from '../../src/modules/gateway/apps/gateway-daemon/index';
import type { DecisionResponse } from '../../src/modules/gateway/libs/decisions/schemas/types';
import type { Provider } from '../../src/modules/gateway/libs/management/schemas/types';
import { openrouter } from '../fixtures/upstreams';

const CHAT_NAMES = ['openai-chat', 'openrouter-chat'];

const isChatSeed = (p: Provider) => CHAT_NAMES.includes(p.name);

test('a fresh start lists openai-chat and openrouter-chat disabled with no routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-seed-new-'));
  try {
    const lines: string[] = [];
    const store = new Store(
      dir,
      { OPENAI_API_KEY: 'oa-test', OPENROUTER_API_KEY: 'or-test' },
      (l) => lines.push(l),
    );
    const seeds = store.providers().filter(isChatSeed);
    expect(seeds.map((p) => [p.name, p.wire, p.enabled])).toEqual([
      ['openai-chat', 'chat', false],
      ['openrouter-chat', 'chat', false],
    ]);
    // Each reads the same env var as its native provider, through its own key setting.
    expect(seeds.map((p) => store.key(p))).toEqual(['oa-test', 'or-test']);
    const used = new Set(store.routes().flatMap((r) => r.targets.map((t) => t.provider_id)));
    expect(seeds.some((p) => used.has(p.id))).toBe(false);
    expect(lines).toEqual([]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 7 adds them once to an existing database, and a deleted one stays deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-seed-migrate-'));
  try {
    const first = new Store(dir, {}, () => undefined);
    const [openaiChat, openrouterChat] = first.providers().filter(isChatSeed);
    // A database from before migration 7: no openai-chat, and the owner's own OpenRouter chat provider.
    first.deleteProvider(openaiChat.id);
    first.deleteProvider(openrouterChat.id);
    first.putProvider({ ...openrouterChat, id: 'prv_mine', name: 'openai-chat', enabled: true });
    first.db.query('DELETE FROM migrations WHERE version=7').run();
    first.close();

    const lines: string[] = [];
    const migrated = new Store(dir, {}, (l) => lines.push(l));
    const chat = migrated.providers().filter((p) => p.wire === 'chat');
    expect(chat.map((p) => [p.name, p.kind, p.enabled])).toEqual([
      ['openai-chat', 'openrouter', true],
      ['openai-chat-2', 'openai', false],
    ]);
    expect(lines).toEqual([
      'Added the disabled provider "openai-chat-2": openai chat models as synthetic decisions, key from OPENAI_API_KEY.',
    ]);
    migrated.deleteProvider(chat[1].id);
    migrated.close();

    const reopened = new Store(dir, {}, (l) => lines.push(l));
    expect(reopened.providers().filter((p) => p.wire === 'chat')).toHaveLength(1);
    expect(lines).toHaveLength(1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart after deleting the fresh seeds does not re-add them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-seed-delete-'));
  try {
    const first = new Store(dir, {});
    for (const p of first.providers().filter(isChatSeed)) first.deleteProvider(p.id);
    first.close();
    const reopened = new Store(dir, {});
    expect(reopened.providers().some(isChatSeed)).toBe(false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The fake OpenRouter answers the native decisions API with the live capture and the chat API with logprobs that
// favour the first label. Nothing reaches the network.
function fakeOpenRouter(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'openrouter.ai') return new Response('not served', { status: 599 });
  if (url.pathname === '/api/v1/models') return Response.json({ data: [{ id: 'vendor/chat-1' }] });
  if (url.pathname === '/api/alpha/decisions')
    return Response.json(openrouter.captured_2026_11_08_live.response_choice_predicate);
  if (url.pathname !== '/api/v1/chat/completions') return new Response('no', { status: 404 });
  const body = JSON.parse(init?.body as string) as { messages: { content: string }[] };
  const question = JSON.parse(body.messages[2].content) as { options: { label: string }[] };
  const labels = question.options.map((o) => o.label);
  return Response.json({
    model: 'vendor/chat-1',
    choices: [
      {
        message: { content: labels[0] },
        logprobs: {
          content: [
            {
              top_logprobs: labels.map((token, i) => ({
                token,
                logprob: Math.log(i === 0 ? 0.8 : 0.2 / (labels.length - 1)),
              })),
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0.0001 },
  });
}

test('a route to openrouter-chat answers synthetically while openrouter stays native', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-seed-route-'));
  const gateway = createGateway({
    env: { ADMIN_TOKEN: 'admin', DATA_DIR: dir, OPENROUTER_API_KEY: 'or-test' },
    http: ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(fakeOpenRouter(input, init))) as typeof fetch,
  });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: gateway.handler });

  const api = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as unknown };
  };

  try {
    const providers = (await api('/admin/api/providers')).body as Provider[];
    const chat = providers.find((p) => p.name === 'openrouter-chat')!;
    const native = providers.find((p) => p.name === 'openrouter')!;
    expect(chat).toMatchObject({ enabled: false, wire: 'chat' });
    expect((await api(`/admin/api/providers/${chat.id}`, { enabled: true }, 'PATCH')).status).toBe(
      200,
    );
    expect(
      (
        await api('/admin/api/routes', {
          alias: 'or-synthetic',
          enabled: true,
          description: '',
          targets: [{ provider_id: chat.id, model: 'vendor/chat-1' }],
        })
      ).status,
    ).toBe(200);
    const questions = [
      {
        name: 'team',
        type: 'choice',
        instructions: 'Which team?',
        choices: [
          { value: 'payments', description: 'Payments' },
          { value: 'bugs', description: 'Bugs' },
        ],
      },
      { name: 'urgent', type: 'predicate', instructions: 'Is it urgent?' },
    ];
    const input = 'I was charged twice for my subscription.';

    const synthetic = (await api('/v1/decisions', { model: 'or-synthetic', input, questions }))
      .body as DecisionResponse;
    expect(synthetic.gateway).toMatchObject({
      provider: 'openrouter-chat',
      synthetic: true,
      confidence_method: 'logprobs',
    });
    expect(synthetic.answers[0]).toMatchObject({ choice: 'payments' });

    const nativeAnswer = (
      await api('/v1/decisions', {
        model: 'openrouter::perplexity/pplx-decider-flash-v1.2',
        input,
        questions,
      })
    ).body as DecisionResponse;
    expect(nativeAnswer.gateway).toMatchObject({ provider: 'openrouter', synthetic: false });

    const after = ((await api('/admin/api/providers')).body as Provider[]).find(
      (p) => p.id === native.id,
    )!;
    expect(after).toMatchObject({ wire: 'map', path: '/api/alpha/decisions', enabled: true });
  } finally {
    await server.stop(true);
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
