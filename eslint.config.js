// ESLint flat config for the backend (src/, tests/, scripts/) and the console app (console-web and its tests).
// Base: @eslint/js recommended and typescript-eslint recommendedTypeChecked, with eslint-config-prettier
// last so formatting stays with Prettier. The boundary rules enforce the dependency
// rules using only the built-in no-restricted-* rules.
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const root = fileURLToPath(new URL('.', import.meta.url));
const TS_FILES = ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'];

// The console is a separately bundled browser app with its own tsconfig.json. Its tests live under
// tests/unit/console-web and are type-checked with the console's tsconfig, not the root one.
const CONSOLE = 'src/modules/gateway/apps/console-web';
const CONSOLE_TESTS = 'tests/unit/console-web';
const CONSOLE_FILES = [`${CONSOLE}/**/*.{ts,tsx}`, `${CONSOLE_TESTS}/**/*.{ts,tsx}`];
const consoleRoot = join(root, CONSOLE);

// Modules are read from disk, so the cross-module rule also covers modules added later.
const modulesDir = new URL('src/modules/', import.meta.url);
const modules = existsSync(modulesDir)
  ? readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

const PURE = 'functions/ and schemas/ must stay pure';
const LIBS_INWARD =
  'libs/ must not import api/ or apps/: dependencies point inward, from apps and api toward effects, functions and schemas';
const PACKAGES =
  'packages/ must not import module code: packages stay independent of every module';
// Modules that do I/O or depend on the runtime. Pure code must not import them.
const EFFECTFUL_MODULES = [
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
];

// Import specifiers are matched as text, so a relative path is caught by the folder it names.
const EFFECTS_OR_PROVIDERS = '(^|/)(effects|providers)(/|$)';
const API_OR_APPS = '(^|/)(api|apps)(/|$)';
const MODULE_CODE = '(^|/)modules(/|$)';

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const effectfulImports = EFFECTFUL_MODULES.map((module) => ({
  name: module,
  regex: `^${escapeRegex(module)}$`,
  message: `${PURE}: ${module} is an effectful dependency; move this code into providers/ and pass the result in`,
}));

// Cross-module check for one module. A relative import into a sibling module climbs out of this
// module and names the sibling (../../other/...), so the pattern looks for that climb as well as for
// an explicit modules/<name> segment.
function crossModuleCheck(self) {
  const others = modules.filter((name) => name !== self).map(escapeRegex);
  if (others.length === 0) return null;
  const alternatives = others.join('|');
  return {
    regex: `^(\\.\\./)+(${alternatives})(/|$)|(^|/)modules/(${alternatives})(/|$)`,
    message: `module ${self} must not import another module's code: call it through an API instead`,
  };
}

// no-restricted-imports sees static imports and re-exports only. The ImportExpression selector covers
// dynamic imports with fixed string or template paths using the same pattern.
const importPatterns = (checks) => checks.map(({ regex, message }) => ({ regex, message }));
const dynamicImportSelectors = (checks) =>
  checks.flatMap(({ regex, message }) => [
    {
      selector: `ImportExpression > Literal[value=/${regex.replaceAll('/', '\\/')}/]`,
      message,
    },
    {
      selector: `ImportExpression > TemplateLiteral[expressions.length=0][quasis.0.value.cooked=/${regex.replaceAll('/', '\\/')}/]`,
      message,
    },
  ]);

const computedPureImport = {
  selector:
    'ImportExpression:not([source.type="Literal"][source.value=type(string)]):not([source.type="TemplateLiteral"][source.expressions.length=0])',
  message: `${PURE}: a computed dynamic import cannot be checked; import a fixed path`,
};

// ESLint replaces a rule's options, rather than merging them, when a later override matches a file.
// The overrides below are disjoint, so each file gets one complete set of restrictions: the pure core,
// the rest of libs/, the rest of a module, or a package.
const moduleBoundaries = (name) => {
  const pureGlobs = [
    `src/modules/${name}/libs/*/functions/**/*.ts`,
    `src/modules/${name}/libs/*/schemas/**/*.ts`,
  ];
  const libsGlob = `src/modules/${name}/libs/**/*.ts`;
  const moduleGlob = `src/modules/${name}/**/*.ts`;
  const cross = crossModuleCheck(name);
  const libsChecks = [{ regex: API_OR_APPS, message: LIBS_INWARD }, ...(cross ? [cross] : [])];
  const pureChecks = [
    {
      regex: EFFECTS_OR_PROVIDERS,
      message: `${PURE}: they must not import effects/ or providers/; pass the value in as an argument instead`,
    },
    ...libsChecks,
  ];
  const overrides = [
    {
      files: pureGlobs,
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: effectfulImports.map(({ name, message }) => ({ name, message })),
            patterns: importPatterns(pureChecks),
          },
        ],
        'no-restricted-globals': [
          'error',
          {
            globals: [
              {
                name: 'fetch',
                message: `${PURE}: no network I/O here; move fetch into providers/ and pass it in`,
              },
              {
                name: 'Bun',
                message: `${PURE}: no Bun runtime access here; move it into providers/`,
              },
              {
                name: 'process',
                message: `${PURE}: no process or environment access here; pass configuration in explicitly`,
              },
            ],
            checkGlobalObject: true,
          },
        ],
        'no-restricted-properties': [
          'error',
          {
            object: 'Date',
            property: 'now',
            message: `${PURE}: pass time in explicitly instead of reading the clock`,
          },
          {
            object: 'Math',
            property: 'random',
            message: `${PURE}: pass randomness in explicitly instead of calling Math.random()`,
          },
          {
            object: 'crypto',
            property: 'randomUUID',
            message: `${PURE}: pass generated ids in explicitly instead of calling crypto.randomUUID()`,
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
            message: `${PURE}: pass time in explicitly; new Date() reads the clock (new Date(value) is fine)`,
          },
          {
            selector: 'CallExpression[callee.name="Date"][arguments.length=0]',
            message: `${PURE}: pass time in explicitly; calling Date() reads the clock`,
          },
          ...dynamicImportSelectors([...effectfulImports, ...pureChecks]),
          computedPureImport,
        ],
      },
    },
    {
      files: [libsGlob],
      ignores: pureGlobs,
      rules: {
        'no-restricted-imports': ['error', { patterns: importPatterns(libsChecks) }],
        'no-restricted-syntax': ['error', ...dynamicImportSelectors(libsChecks)],
      },
    },
  ];
  if (cross) {
    overrides.push({
      files: [moduleGlob],
      ignores: [libsGlob],
      rules: {
        'no-restricted-imports': ['error', { patterns: importPatterns([cross]) }],
        'no-restricted-syntax': ['error', ...dynamicImportSelectors([cross])],
      },
    });
  }
  return overrides;
};

const packageBoundary = {
  message: PACKAGES,
  regex: MODULE_CODE,
};

// Every folder of the console app that holds TypeScript, relative to the app root ('' is the root).
// The folders are read from disk, so folders added later are covered too.
const CONSOLE_SKIP = new Set(['node_modules', 'dist']);
function consoleFolders(folder = '') {
  const entries = readdirSync(join(consoleRoot, folder), { withFileTypes: true });
  const here = entries.some((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    ? [folder]
    : [];
  const nested = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !CONSOLE_SKIP.has(entry.name))
    .flatMap((entry) => consoleFolders(folder ? `${folder}/${entry.name}` : entry.name));
  return [...here, ...nested];
}

// The console talks to the backend only over HTTP, so its files may import only from their own folder.
// A relative specifier must not climb above the console root. How far it may climb depends on the
// folder's depth, so each folder gets its own override (ESLint replaces rule options per file). The
// check reads the leading ../ run of a specifier, which is how an import leaves a folder in practice.
function consoleBoundaries() {
  return consoleFolders().map((folder) => {
    const depth = folder === '' ? 0 : folder.split('/').length;
    const checks = [
      {
        regex: `^(?:\\./)?(?:\\.\\.(?:/|$)){${depth + 1},}`,
        message: `${CONSOLE} must not import from outside its own folder: the console is a separately bundled browser app and talks to the backend over HTTP only`,
      },
      {
        regex: '^/',
        message: `${CONSOLE} must not import absolute paths: import from its own folder with a relative path`,
      },
    ];
    return {
      files: [`${CONSOLE}/${folder ? `${folder}/` : ''}*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': ['error', { patterns: importPatterns(checks) }],
        'no-restricted-syntax': ['error', ...dynamicImportSelectors(checks)],
      },
    };
  });
}

// Functions and classes sit apart from their neighbours: a blank line before and after, in the backend
// and the console alike. Plain function declarations and classes are padded by the stylistic rule. Its
// statement types cannot see inside an export or a const, so exported functions, exported classes and
// function-valued consts are padded by the local rule below. The two never judge the same gap.
const STATEMENT_PADDING = [
  { blankLine: 'always', prev: '*', next: ['function', 'class'] },
  { blankLine: 'always', prev: ['function', 'class'], next: '*' },
];
const isPlainDeclaration = (s) => s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration';
const isFunctionLike = (s) => {
  const declaration =
    (s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration') && s.declaration
      ? s.declaration
      : s;
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration')
    return true;
  return (
    declaration.type === 'VariableDeclaration' &&
    declaration.declarations.some(
      (d) => d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression',
    )
  );
};
// True when a blank line separates `before` from `after`, counting comments as lines of their own.
function blankLineBetween(sourceCode, before, after) {
  let previous = sourceCode.getLastToken(before);
  let next = sourceCode.getTokenAfter(previous, { includeComments: true });
  while (next && next.range[0] < after.range[0]) {
    if (next.loc.start.line - previous.loc.end.line > 1) return true;
    previous = next;
    next = sourceCode.getTokenAfter(next, { includeComments: true });
  }
  return after.loc.start.line - previous.loc.end.line > 1;
}
const blankLineAround = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    messages: {
      padding:
        'Expected a blank line before and after functions, classes and function-valued constants.',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    function check(statements) {
      for (let i = 1; i < statements.length; i += 1) {
        const before = statements[i - 1];
        const after = statements[i];
        if (isPlainDeclaration(before) || isPlainDeclaration(after)) continue;
        if (!isFunctionLike(before) && !isFunctionLike(after)) continue;
        if (blankLineBetween(sourceCode, before, after)) continue;
        context.report({
          node: after,
          messageId: 'padding',
          fix(fixer) {
            // Open the gap at the first comment or token that starts on a later line than `before` ends.
            let item = sourceCode.getTokenAfter(sourceCode.getLastToken(before), {
              includeComments: true,
            });
            while (
              item &&
              item.range[0] < after.range[0] &&
              item.loc.start.line === before.loc.end.line
            )
              item = sourceCode.getTokenAfter(item, { includeComments: true });
            if (item && item.loc.start.line > before.loc.end.line) {
              const lineStart = item.range[0] - item.loc.start.column;
              return fixer.insertTextBeforeRange([lineStart, lineStart], '\n');
            }
            return fixer.insertTextBefore(after, '\n\n');
          },
        });
      }
    }
    return {
      Program: (node) => check(node.body),
      BlockStatement: (node) => check(node.body),
      StaticBlock: (node) => check(node.body),
      TSModuleBlock: (node) => check(node.body),
      SwitchCase: (node) => check(node.consequent),
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/.*',
      // Docs has its own Next.js/MDX toolchain; root checks cover its HTTP snippet tests.
      'src/modules/gateway/apps/docs-web/**',
      'data/**',
      'dist/**',
      `${CONSOLE}/dist/**`,
      `${CONSOLE}/node_modules/**`,
    ],
  },
  {
    files: TS_FILES,
    ignores: CONSOLE_FILES,
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
  },
  {
    files: CONSOLE_FILES,
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: ['tsconfig.json'], tsconfigRootDir: consoleRoot },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  ...consoleBoundaries(),
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    plugins: {
      '@stylistic': stylistic,
      local: { rules: { 'blank-line-around': blankLineAround } },
    },
    rules: {
      '@stylistic/padding-line-between-statements': ['error', ...STATEMENT_PADDING],
      '@stylistic/lines-between-class-members': ['error', 'always'],
      'local/blank-line-around': 'error',
    },
  },
  ...modules.flatMap(moduleBoundaries),
  {
    files: ['src/packages/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: importPatterns([packageBoundary]) }],
      'no-restricted-syntax': ['error', ...dynamicImportSelectors([packageBoundary])],
    },
  },
  {
    files: ['src/modules/*/libs/*/effects/**/*.ts'],
    rules: {
      complexity: ['error', 6],
      'max-depth': ['error', 2],
      'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
    },
  },
  prettier,
);
