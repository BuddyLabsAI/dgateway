import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DecisionClient } from '../../src/packages/decision-client';

// compose.yaml publishes the service on 127.0.0.1:8790, and the daemon listens on 8790 inside the container. This test
// publishes on a host port of its own, so it never collides with a gateway already running on this machine: E2E_PORT
// when it is set, otherwise a port the OS reports as free. Only this test's copy of the compose file changes.
const CONTAINER_PORT = 8790;
const MAPPING = `"127.0.0.1:${CONTAINER_PORT}:${CONTAINER_PORT}"`;

// A localhost port the OS reports as free: bind port 0, read the port it picked, and release it.
async function freeLocalPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error('the OS did not report a free localhost port');
  return port;
}

// E2E_PORT, when it is set, must be a port number.
function requestedPort(): number | undefined {
  const raw = process.env.E2E_PORT;
  if (raw === undefined || raw === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`E2E_PORT must be a port number from 1 to 65535, got "${raw}"`);
  return port;
}

const port = requestedPort() ?? (await freeLocalPort());
const base = `http://127.0.0.1:${port}`;
const root = resolve('.');
const source = readFileSync(resolve('compose.yaml'), 'utf8');
// If compose.yaml stops publishing the container port this way, fail here rather than publish on the wrong port.
if (!source.includes(MAPPING))
  throw new Error(`compose.yaml must publish ${MAPPING}; update tests/e2e/compose.ts to match`);
console.log(`e2e: publishing the gateway on ${base}`);
const dir = mkdtempSync(join(tmpdir(), 'dgateway-e2e-'));
const compose = join(dir, 'compose.yaml'),
  envFile = join(dir, '.env');
const project = `dgateway-e2e-${process.pid}`;
writeFileSync(
  envFile,
  'ADMIN_TOKEN=e2e-admin-token\nGATEWAY_SECRET=e2e-secret\nOPENAI_API_KEY=\nOPENROUTER_API_KEY=\n',
);
const yaml = source
  .replace('ghcr.io/buddylabsai/dgateway:latest', `dgateway-e2e:${process.pid}`)
  .replace('context: .', `context: ${JSON.stringify(root)}`)
  .replace('env_file: .env', `env_file: ${JSON.stringify(envFile)}`)
  .replace(MAPPING, `"127.0.0.1:${port}:${CONTAINER_PORT}"`);
writeFileSync(compose, yaml);

async function run(...args: string[]) {
  const p = Bun.spawn(['docker', 'compose', '-p', project, '-f', compose, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`docker compose ${args.join(' ')} exited ${code}`);
}

try {
  await run('build', '--build-arg', 'SKIP_CONSOLE=true');
  await run('up', '-d');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) {
        ready = true;
        break;
      }
    } catch {
      // Not accepting connections yet; retry after the pause below.
    }
    await Bun.sleep(1000);
  }
  if (!ready) throw new Error(`Health check timed out on ${base}`);
  const page = await (await fetch(`${base}/`)).text();
  if (!page.includes('Console is not built')) throw new Error('Expected console not-built page');
  const client = new DecisionClient(base);
  const response = await client.decide({
    model: 'default',
    input: 'test decision',
    questions: [{ name: 'ready', type: 'predicate', instructions: 'Is the service ready?' }],
  });
  // Answers come in OpenAI's Decisions shape: a predicate is its name, its type and a probability.
  const [answer] = response.answers;
  if (
    response.object !== 'decision' ||
    response.gateway.provider !== 'mock' ||
    response.answers.length !== 1 ||
    answer?.name !== 'ready' ||
    answer.type !== 'predicate' ||
    typeof answer.probability !== 'number' ||
    'value' in answer ||
    typeof response.usage?.input_tokens !== 'number'
  )
    throw new Error('Unexpected decision response');
  // The mock reports what it billed, 0, and who it is, so its decision carries cost 0, basis upstream_cost and Mock.
  const costed = (await (
    await fetch(`${base}/v1/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        input: 'test decision',
        questions: [{ name: 'ready', type: 'predicate', instructions: 'Is the service ready?' }],
      }),
    })
  ).json()) as {
    gateway: { cost_usd: number | null; cost_basis: string; served_by: string | null };
  };
  if (
    costed.gateway.cost_usd !== 0 ||
    costed.gateway.cost_basis !== 'upstream_cost' ||
    costed.gateway.served_by !== 'Mock'
  )
    throw new Error('Expected a mock decision billed at 0 (upstream_cost) and served by Mock');
  const admin = await fetch(`${base}/admin/api/settings`, {
    headers: { authorization: 'Bearer e2e-admin-token' },
  });
  if (
    !admin.ok ||
    ((await admin.json()) as { default_route?: unknown }).default_route !== 'default'
  )
    throw new Error('Admin settings check failed');
  console.log(
    `E2E PASS on port ${port}: compose build, console placeholder, health, decision client, cost fields, and admin settings`,
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  try {
    // --rmi local also removes the image this run built, so repeated runs leave nothing behind.
    await run('down', '-v', '--remove-orphans', '--rmi', 'local');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  rmSync(dir, { recursive: true, force: true });
}
