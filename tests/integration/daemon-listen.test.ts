import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Starts the daemon as `bun run start` does, with HOST set to a machine name as many shells export it.
const dir = mkdtempSync(join(tmpdir(), 'gateway-listen-'));
const entry = resolve('src/modules/gateway/apps/gateway-daemon/index.ts');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

function daemon(env: Record<string, string>) {
  return Bun.spawn([process.execPath, entry], {
    env: {
      PATH: process.env.PATH ?? '',
      ADMIN_TOKEN: 'admin-token',
      GATEWAY_SECRET: 'encryption-password',
      DATA_DIR: join(dir, `data-${Object.values(env).join('-')}`),
      CONSOLE_DIR: join(dir, 'console'),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function firstLine(stream: ReadableStream<Uint8Array>, match: string): Promise<string> {
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    text += decoder.decode(chunk);
    if (text.includes(match)) return text;
  }
  return text;
}

test('the daemon ignores a machine name in HOST, warns, and answers /healthz', async () => {
  const port = await freePort();
  const child = daemon({ HOST: 'somehostname', DGATEWAY_PORT: String(port) });
  try {
    const out = await firstLine(child.stdout, 'dgateway listening');
    expect(out).toContain(`dgateway listening on 0.0.0.0:${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  } finally {
    child.kill();
    await child.exited;
  }
  const err = await new Response(child.stderr).text();
  expect(err).toContain(
    'HOST="somehostname" is not a listen address; ignoring it. Set DGATEWAY_HOST to choose the address.',
  );
}, 20000);

test('an invalid DGATEWAY_HOST stops startup with an error naming the variable', async () => {
  const child = daemon({ DGATEWAY_HOST: 'somehostname', DGATEWAY_PORT: String(await freePort()) });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain(
    'DGATEWAY_HOST="somehostname" is not a listen address',
  );
}, 20000);
