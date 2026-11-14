import { describe, expect, test } from 'bun:test';
import {
  isIPv4,
  isIPv6,
  resolveListen,
} from '../../src/modules/gateway/libs/management/functions/listen';

describe('resolveListen', () => {
  test('defaults to 0.0.0.0:8790 with no warnings', () => {
    expect(resolveListen({})).toEqual({ hostname: '0.0.0.0', port: 8790, warnings: [] });
  });

  test('DGATEWAY_HOST and DGATEWAY_PORT win over HOST and PORT', () => {
    expect(
      resolveListen({
        DGATEWAY_HOST: '127.0.0.1',
        HOST: '10.0.0.1',
        DGATEWAY_PORT: '9000',
        PORT: '9001',
      }),
    ).toEqual({ hostname: '127.0.0.1', port: 9000, warnings: [] });
  });

  test('a valid HOST and PORT are still used', () => {
    expect(resolveListen({ HOST: '192.168.1.5', PORT: '8080' })).toEqual({
      hostname: '192.168.1.5',
      port: 8080,
      warnings: [],
    });
    expect(resolveListen({ HOST: 'localhost' }).hostname).toBe('localhost');
    expect(resolveListen({ HOST: '0.0.0.0' }).hostname).toBe('0.0.0.0');
    expect(resolveListen({ HOST: '::' }).hostname).toBe('::');
  });

  test('IPv6 literals are accepted, with or without brackets', () => {
    expect(resolveListen({ HOST: '::1' }).hostname).toBe('::1');
    expect(resolveListen({ HOST: 'fe80::1' }).hostname).toBe('fe80::1');
    expect(resolveListen({ DGATEWAY_HOST: '[::1]' }).hostname).toBe('::1');
  });

  test('a machine name in HOST is ignored with a warning', () => {
    expect(resolveListen({ HOST: 'myhost' })).toEqual({
      hostname: '0.0.0.0',
      port: 8790,
      warnings: [
        'HOST="myhost" is not a listen address; ignoring it. Set DGATEWAY_HOST to choose the address.',
      ],
    });
    expect(resolveListen({ HOST: '256.1.1.1' }).hostname).toBe('0.0.0.0');
  });

  test('DGATEWAY_HOST hides an invalid HOST without a warning', () => {
    expect(resolveListen({ DGATEWAY_HOST: '::', HOST: 'myhost' })).toEqual({
      hostname: '::',
      port: 8790,
      warnings: [],
    });
  });

  test('an invalid DGATEWAY_HOST fails and names the variable', () => {
    expect(() => resolveListen({ DGATEWAY_HOST: 'myhost' })).toThrow(
      'DGATEWAY_HOST="myhost" is not a listen address',
    );
  });

  test('empty variables count as unset', () => {
    expect(resolveListen({ DGATEWAY_HOST: '', HOST: '', DGATEWAY_PORT: '', PORT: '' })).toEqual({
      hostname: '0.0.0.0',
      port: 8790,
      warnings: [],
    });
  });

  test('ports must be whole numbers from 1 to 65535, and errors name the variable', () => {
    expect(resolveListen({ PORT: '1' }).port).toBe(1);
    expect(resolveListen({ PORT: '65535' }).port).toBe(65535);
    for (const bad of ['abc', '80.5', '-1', '0', '65536', '1e3', '0x50'])
      expect(() => resolveListen({ PORT: bad })).toThrow(`PORT="${bad}" is not a port`);
    expect(() => resolveListen({ DGATEWAY_PORT: '70000', PORT: '8080' })).toThrow(
      'DGATEWAY_PORT="70000" is not a port; use a whole number from 1 to 65535',
    );
  });
});

describe('address checks', () => {
  test('IPv4 needs four octets from 0 to 255', () => {
    for (const ok of ['0.0.0.0', '127.0.0.1', '255.255.255.255']) expect(isIPv4(ok)).toBe(true);
    for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', ''])
      expect(isIPv4(bad)).toBe(false);
  });

  test('IPv6 needs eight hex groups, one :: or a trailing IPv4 address', () => {
    for (const ok of ['::', '::1', 'fe80::1', '2001:db8:0:0:0:0:0:1', '::ffff:127.0.0.1', '1::'])
      expect(isIPv6(ok)).toBe(true);
    for (const bad of [
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '1::2::3',
      '12345::',
      ':1:2:3:4:5:6:7',
      '1.2.3.4::',
      'g::1',
      'myhost',
      '',
    ])
      expect(isIPv6(bad)).toBe(false);
  });
});
