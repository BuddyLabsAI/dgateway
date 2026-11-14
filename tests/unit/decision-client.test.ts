import { describe, expect, test } from 'bun:test';
import { authorizationHeaders, DecisionClient } from '../../src/packages/decision-client';

describe('decision client authorization', () => {
  test('builds authorization headers with and without a key', () => {
    expect(authorizationHeaders('client-key')).toEqual({ authorization: 'Bearer client-key' });
    expect(authorizationHeaders()).toEqual({});
  });

  for (const key of ['client-key', undefined]) {
    test(`models and decide send the expected authorization for ${key ?? 'no key'}`, async () => {
      const headers: Headers[] = [];
      const http = ((_input: RequestInfo | URL, init?: RequestInit) => {
        headers.push(new Headers(init?.headers));
        return Promise.resolve(Response.json({}));
      }) as unknown as typeof fetch;
      const client = new DecisionClient('http://localhost', key, http);
      await client.models();
      await client.decide({ input: 'input', questions: [] });
      expect(headers.map((header) => header.get('authorization'))).toEqual([
        key ? `Bearer ${key}` : null,
        key ? `Bearer ${key}` : null,
      ]);
      expect(headers[1]?.get('content-type')).toBe('application/json');
    });
  }

  test('models reports the gateway error message', async () => {
    const http = (() =>
      Promise.resolve(
        Response.json({ error: { message: 'invalid key' } }, { status: 401 }),
      )) as unknown as typeof fetch;
    const error = await new DecisionClient('http://localhost', 'bad', http)
      .models()
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('invalid key');
  });

  test('models falls back to the HTTP status when the gateway provides no message', async () => {
    const http = (() =>
      Promise.resolve(Response.json({}, { status: 503 }))) as unknown as typeof fetch;
    const error = await new DecisionClient('http://localhost', undefined, http)
      .models()
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('HTTP 503');
  });
});
