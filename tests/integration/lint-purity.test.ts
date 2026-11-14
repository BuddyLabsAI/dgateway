import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const pureFile = 'src/modules/gateway/libs/decisions/functions/hosts.ts';
const effectsFile = 'src/modules/gateway/libs/decisions/effects/decide.ts';

test.each([
  'bun',
  'bun:sqlite',
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'crypto',
  'node:crypto',
])(
  'pure code rejects static and dynamic imports of %s with the same explanation',
  async (module) => {
    const [staticResult] = await eslint.lintText(`import '${module}';`, { filePath: pureFile });
    const [dynamicResult] = await eslint.lintText(`void import('${module}');`, {
      filePath: pureFile,
    });
    const explanation = `functions/ and schemas/ must stay pure: ${module} is an effectful dependency; move this code into providers/ and pass the result in`;

    expect(staticResult.fatalErrorCount).toBe(0);
    expect(dynamicResult.fatalErrorCount).toBe(0);
    expect(staticResult.messages).toMatchObject([
      {
        ruleId: 'no-restricted-imports',
        severity: 2,
        message: `'${module}' import is restricted from being used. ${explanation}`,
      },
    ]);
    expect(dynamicResult.messages).toMatchObject([
      {
        ruleId: 'no-restricted-syntax',
        severity: 2,
        message: explanation,
      },
    ]);
  },
);

test('pure code still rejects dynamic provider imports', async () => {
  const [result] = await eslint.lintText("void import('../providers/mock');", {
    filePath: pureFile,
  });

  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages).toMatchObject([
    {
      ruleId: 'no-restricted-syntax',
      severity: 2,
      message:
        'functions/ and schemas/ must stay pure: they must not import effects/ or providers/; pass the value in as an argument instead',
    },
  ]);
});

test.each(['./wire', './fs', 'fs-extra', 'fs/other'])(
  'pure code allows a dynamic import outside the restricted paths: %s',
  async (module) => {
    const [result] = await eslint.lintText(`void import('${module}');`, { filePath: pureFile });

    expect(result.messages).toEqual([]);
  },
);

test('schemas reject dynamic runtime imports too', async () => {
  const [result] = await eslint.lintText("void import('fs');", {
    filePath: 'src/modules/gateway/libs/decisions/schemas/types.ts',
  });

  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages).toMatchObject([{ ruleId: 'no-restricted-syntax', severity: 2 }]);
});

test('effects may import runtime modules dynamically', async () => {
  const [result] = await eslint.lintText("void import('fs');", { filePath: effectsFile });

  expect(result.messages).toEqual([]);
});

test.each(['fs', 'node:fs', 'bun:sqlite', '../providers/mock'])(
  'pure code rejects a fixed template import of %s with the same explanation as a string',
  async (module) => {
    const [stringResult] = await eslint.lintText(`void import('${module}');`, {
      filePath: pureFile,
    });
    const [templateResult] = await eslint.lintText('void import(`' + module + '`);', {
      filePath: pureFile,
    });

    expect(templateResult.fatalErrorCount).toBe(0);
    expect(templateResult.messages).toMatchObject([
      {
        ruleId: 'no-restricted-syntax',
        severity: 2,
        message: stringResult.messages[0].message,
      },
    ]);
  },
);

test.each([pureFile, 'src/modules/gateway/libs/decisions/schemas/types.ts'])(
  '%s rejects computed dynamic imports',
  async (filePath) => {
    for (const code of [
      "const name = './wire'; void import(name);",
      "const part = 'wire'; void import(`./${part}`);",
      'void import(123);',
    ]) {
      const [result] = await eslint.lintText(code, { filePath });

      expect(result.fatalErrorCount).toBe(0);
      expect(result.messages).toMatchObject([
        {
          ruleId: 'no-restricted-syntax',
          severity: 2,
          message:
            'functions/ and schemas/ must stay pure: a computed dynamic import cannot be checked; import a fixed path',
        },
      ]);
    }
  },
);

test('pure code allows a fixed template import outside restricted paths', async () => {
  const [result] = await eslint.lintText('void import(`./wire`);', { filePath: pureFile });

  expect(result.messages).toEqual([]);
});

test.each([
  'void import(`fs`);',
  'void import(`node:fs`);',
  'void import(`bun:sqlite`);',
  'void import(`../providers/mock`);',
  "const name = 'fs'; void import(name);",
  "const part = 'fs'; void import(`node:${part}`);",
])('effects allow fixed template and computed imports: %s', async (code) => {
  const [result] = await eslint.lintText(code, { filePath: effectsFile });

  expect(result.messages).toEqual([]);
});

test('libs reject fixed template imports from api', async () => {
  const [result] = await eslint.lintText('void import(`../../../api/http`);', {
    filePath: effectsFile,
  });

  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages).toMatchObject([
    {
      ruleId: 'no-restricted-syntax',
      severity: 2,
      message:
        'libs/ must not import api/ or apps/: dependencies point inward, from apps and api toward effects, functions and schemas',
    },
  ]);
});
