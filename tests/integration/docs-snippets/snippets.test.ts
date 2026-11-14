import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGateway } from '../../../src/modules/gateway/apps/gateway-daemon/index';
import type { DecisionResponse } from '../../../src/packages/decision-client';

const docs = resolve('src/modules/gateway/apps/docs-web');
const snippets = join(docs, 'snippets');
const directory = mkdtempSync(join(tmpdir(), 'dgateway-docs-'));
const adminToken = 'docs-test-admin';
let gateway: ReturnType<typeof createGateway>;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  gateway = createGateway({
    env: { ADMIN_TOKEN: adminToken, DATA_DIR: directory },
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: gateway.handler });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.stop(true);
  gateway?.close();
  rmSync(directory, { recursive: true, force: true });
});

async function execute(file: string, clientKey?: string): Promise<unknown[]> {
  const path = join(snippets, file);
  const child = Bun.spawn(file.endsWith('.ts') ? [process.execPath, path] : ['sh', path], {
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      ADMIN_TOKEN: adminToken,
      CLIENT_KEY: clientKey ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, `${file}: ${stderr}`).toBe(0);
    return stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
  } finally {
    clearTimeout(timeout);
  }
}

function assertDecision(value: unknown) {
  const decision = value as DecisionResponse;
  expect(decision).toMatchObject({ object: 'decision', model: 'default' });
  expect(decision.id).toStartWith('dec_');
  expect(decision.gateway).toMatchObject({
    route: 'default',
    provider: 'mock',
    served_by: 'Mock',
    upstream_model: 'mock-1',
    cost_usd: 0,
    cost_basis: 'upstream_cost',
  });
  expect(decision.gateway.attempts).toHaveLength(1);
  expect(decision.gateway.attempts[0].ok).toBe(true);
  expect(decision.usage!.input_tokens).toBeGreaterThan(0);
  expect(decision.usage!.total_tokens).toBe(
    decision.usage!.input_tokens + decision.usage!.output_tokens,
  );
  expect(decision.answers.map((answer) => [answer.type, answer.name])).toEqual([
    ['choice', 'team'],
    ['predicate', 'urgent'],
    ['score', 'severity'],
  ]);
  expect(['billing', 'technical']).toContain(String(decision.answers[0].choice));
  expect(decision.answers[0].probabilities!.map((entry) => entry.value)).toEqual([
    'billing',
    'technical',
  ]);
  expect(decision.answers[1].probability).toBeWithin(0, 1);
  expect(decision.answers[1]).not.toHaveProperty('value');
  expect(decision.answers[2].probabilities!.map((entry) => [entry.value, entry.label])).toEqual([
    [0, 'low'],
    [1, 'high'],
  ]);
  const expectedScore = decision.answers[2].probabilities!.reduce(
    (total, entry) => total + Number(entry.value) * entry.probability,
    0,
  );
  expect(decision.answers[2].score).toBeCloseTo(expectedScore, 5);
}

test('docs snippets: curl decisions and typed decision-client match the public contract', async () => {
  const [curl] = await execute('decisions.sh');
  const [typed] = await execute('decision-client.ts');
  assertDecision(curl);
  assertDecision(typed);
  expect((curl as DecisionResponse).answers).toEqual((typed as DecisionResponse).answers);
});

test('docs snippets: public models and unauthenticated health', async () => {
  const [models, health] = await execute('models.sh');
  expect(models).toMatchObject({ object: 'list' });
  const aliases = (models as { data: { id: string }[] }).data.map((model) => model.id);
  expect(aliases).toContain('default');
  expect(health).toEqual({ ok: true });
});

test('docs snippets: provider CRUD, catalog and known-answer check', async () => {
  const [list, created, models, checked, patched, deleted] = await execute('providers.sh');
  expect(list).toBeArray();
  expect(created).toMatchObject({ name: 'docs-example', key: { source: 'none' } });
  expect(models).toMatchObject({ models: [{ id: 'mock-1', default_price_per_m_input: 0 }] });
  expect(checked).toMatchObject({
    ok: true,
    expected: 'billing',
    answer: 'billing',
    probability: 0.96,
    matched: true,
    model: 'mock-1',
    model_reason: 'requested',
  });
  expect(patched).toMatchObject({ enabled: false });
  expect(deleted).toEqual({ ok: true });
});

test('docs snippets: route CRUD retains ordered mock target', async () => {
  const [list, created, patched, deleted] = await execute('routes.sh');
  expect(list).toBeArray();
  expect(created).toMatchObject({ alias: 'docs-example', targets: [{ model: 'mock-1' }] });
  expect(patched).toMatchObject({ description: 'Updated documentation example' });
  expect(deleted).toEqual({ ok: true });
});

test('docs snippets: log filters and statistics', async () => {
  await execute('decisions.sh');
  const [logs, stats] = await execute('observability.sh');
  const entries = (logs as { items: { fallback_used: boolean; cost_basis: string }[] }).items;
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every((entry) => !entry.fallback_used)).toBe(true);
  expect(entries.some((entry) => entry.cost_basis === 'upstream_cost')).toBe(true);
  expect(stats).toMatchObject({ window: '1h', cost_usd: 0, unpriced: 0 });
  expect((stats as { timeseries: unknown[] }).timeseries).toHaveLength(24);
});

test('docs snippets: client key lifecycle and settings PATCH', async () => {
  const [created, list, deleted, settings, patched] = await execute('clients-settings.sh');
  const key = (created as { key: string }).key;
  expect(key).toStartWith('dgk_');
  expect(created).toMatchObject({ name: 'Documentation example' });
  expect(list).toBeArray();
  expect(JSON.stringify(list)).not.toContain(key);
  expect(deleted).toEqual({ ok: true });
  expect(settings).toEqual({
    require_client_keys: false,
    capture_payloads: false,
    default_route: 'default',
  });
  expect(patched).toEqual(settings);
});

test('docs snippets: playground success, HTTP-200 decision failure and admin health', async () => {
  const [success, failure, health] = await execute('playground-health.sh');
  expect(success).toMatchObject({
    response: { object: 'decision' },
    trace: { attempts: [{ ok: true }] },
  });
  expect(failure).toMatchObject({ response: null, error: { type: 'not_found_error' } });
  expect(health).toMatchObject({
    ok: true,
    secret_configured: false,
  });
  expect((health as { providers: unknown[] }).providers).toBeArray();
});

test('docs snippets: public curl and client examples send required client keys', async () => {
  const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const created = await fetch(`${baseUrl}/admin/api/clients`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Snippet auth' }),
  });
  const { key } = (await created.json()) as { key: string };
  await fetch(`${baseUrl}/admin/api/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ require_client_keys: true }),
  });
  try {
    expect((await fetch(`${baseUrl}/v1/models`)).status).toBe(401);
    assertDecision((await execute('decisions.sh', key))[0]);
    assertDecision((await execute('decision-client.ts', key))[0]);
    expect((await execute('models.sh', key))[0]).toMatchObject({ object: 'list' });
  } finally {
    await fetch(`${baseUrl}/admin/api/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ require_client_keys: false }),
    });
  }
});

async function referenceText(folder: string): Promise<string> {
  const entries = await readdir(folder, { withFileTypes: true });
  const text = await Promise.all(
    entries.map(async (entry) => {
      const path = join(folder, entry.name);
      return entry.isDirectory() ? referenceText(path) : readFile(path, 'utf8');
    }),
  );
  return text.join('\n');
}

test('docs snippets: every executable example is included and exercised', async () => {
  const files = (await readdir(snippets)).sort();
  expect(files).toEqual([
    'clients-settings.sh',
    'decision-client.ts',
    'decisions.sh',
    'models.sh',
    'observability.sh',
    'playground-health.sh',
    'providers.sh',
    'routes.sh',
  ]);
  const content = await referenceText(join(docs, 'content/docs/reference'));
  for (const file of files)
    expect(content).toMatch(new RegExp(`>\\s*snippets/${file.replace('.', '\\.')}\\s*</include>`));
});
