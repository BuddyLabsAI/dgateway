import { describe, expect, test } from 'bun:test';
import {
  COMMIT_TYPES,
  TYPE_EMOJI,
  addMissingEmoji,
  checkCommitMessage,
  cleanMessage,
  formatReport,
  suggestHeader,
} from '../../src/packages/commit-message';

const VS = '\uFE0F';

describe('checkCommitMessage: valid headers', () => {
  test('accepts every type with its emoji', () => {
    for (const type of COMMIT_TYPES) {
      const check = checkCommitMessage(`${type}: ${TYPE_EMOJI[type]} change something`);
      expect(check.errors).toEqual([]);
      expect(check).toMatchObject({ ok: true, kind: 'conventional', type, breaking: false });
    }
  });

  test('accepts each emoji with or without the variation selector', () => {
    for (const type of COMMIT_TYPES) {
      const bare = TYPE_EMOJI[type].replaceAll(VS, '');
      expect(checkCommitMessage(`${type}: ${bare} change`).ok).toBe(true);
      expect(checkCommitMessage(`${type}: ${bare}${VS} change`).ok).toBe(true);
    }
  });

  test('reads scope, subject and the breaking marker', () => {
    expect(checkCommitMessage('feat(console-web)!: ✨ drop the old screen')).toMatchObject({
      ok: true,
      type: 'feat',
      scope: 'console-web',
      subject: '✨ drop the old screen',
      breaking: true,
    });
  });

  test('a BREAKING CHANGE footer marks the commit as breaking', () => {
    const message =
      'fix: 🐛 rename a field\n\nLonger body.\n\nBREAKING CHANGE: `cost` is now `cost_usd`';
    expect(checkCommitMessage(message)).toMatchObject({ ok: true, breaking: true });
    expect(checkCommitMessage('fix: 🐛 x\n\nBREAKING-CHANGE: gone').breaking).toBe(true);
  });

  test('accepts a header of exactly 100 characters', () => {
    const header = `feat: ✨ ${'a'.repeat(100 - 'feat: ✨ '.length)}`;
    expect([...header].length).toBe(100);
    expect(checkCommitMessage(header).ok).toBe(true);
  });

  test("accepts git's merge and revert headers without emoji", () => {
    for (const header of [
      "Merge branch 'main' into feature",
      "Merge remote-tracking branch 'origin/main'",
      'Merge pull request #12 from someone/branch',
      "Merge tag 'v0.1.0'",
      'Revert "feat: ✨ add route search"',
      'Reapply "Revert "feat: ✨ add route search""',
    ]) {
      const check = checkCommitMessage(`${header}\n\nThis reverts commit abc.`);
      expect(check.errors).toEqual([]);
      expect(['merge', 'revert']).toContain(check.kind);
    }
  });

  test("accepts release-please's release title", () => {
    expect(checkCommitMessage('chore(main): 🔧 release 0.2.0').ok).toBe(true);
    expect(checkCommitMessage('chore(main): 🔧 release 0.2.0 (#14)').ok).toBe(true);
  });
});

describe('checkCommitMessage: invalid messages', () => {
  const errorsOf = (message: string) => checkCommitMessage(message).errors.join('\n');

  test('rejects an empty message and a free-form header', () => {
    expect(errorsOf('')).toContain('empty');
    expect(checkCommitMessage('update stuff')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(errorsOf('update stuff')).toContain('type(scope): emoji subject');
  });

  test('rejects an unknown or uppercase type', () => {
    expect(errorsOf('feature: ✨ add x')).toContain('"feature" is not a commit type');
    expect(errorsOf('Feat: ✨ add x')).toContain('lowercase: "feat"');
  });

  test('rejects a bad scope', () => {
    expect(errorsOf('feat(Console): ✨ add x')).toContain('scope');
    expect(errorsOf('feat(): ✨ add x')).toContain('scope');
    expect(errorsOf('feat(a b): ✨ add x')).toContain('scope');
  });

  test('rejects a missing, empty or badly spaced subject', () => {
    expect(errorsOf('feat:')).toContain('write a subject');
    expect(errorsOf('feat: ')).toContain('write a subject');
    expect(errorsOf('feat:✨ add x')).toContain('one space');
    expect(errorsOf('feat:  ✨ add x')).toContain('one space');
    expect(errorsOf('feat: ✨')).toContain('subject text');
    expect(errorsOf('feat: ✨add x')).toContain('subject text');
  });

  test('requires the emoji of the type', () => {
    expect(errorsOf('feat: add x')).toContain('start the subject with ✨');
    expect(errorsOf('feat: 🐛 add x')).toContain('needs ✨ at the start of the subject, not 🐛');
    expect(errorsOf('fix: add ✨ later')).toContain('start the subject with 🐛');
  });

  test('rejects a header over 100 characters', () => {
    expect(errorsOf(`feat: ✨ ${'a'.repeat(100)}`)).toContain('100 characters or fewer');
  });

  test('requires a blank line before the body', () => {
    expect(errorsOf('feat: ✨ add x\nbody right away')).toContain('blank line');
  });

  test('rejects a lowercase breaking change footer', () => {
    expect(errorsOf('feat: ✨ add x\n\nbreaking change: gone')).toContain('BREAKING CHANGE');
  });

  test('fixup, squash and amend headers pass only when allowed', () => {
    for (const header of ['fixup! feat: ✨ add x', 'squash! fix: 🐛 y', 'amend! docs: 📝 z']) {
      expect(checkCommitMessage(header)).toMatchObject({ ok: false, kind: 'fixup' });
      expect(checkCommitMessage(header).errors[0]).toContain('autosquash');
      expect(checkCommitMessage(header, { allowFixup: true }).ok).toBe(true);
    }
  });
});

describe('suggestHeader', () => {
  test('corrects the type case, the emoji and the spacing', () => {
    expect(suggestHeader('feat: add x')).toBe('feat: ✨ add x');
    expect(suggestHeader('Fix(API)!: 🐛 y')).toBe('fix(api)!: 🐛 y');
    expect(suggestHeader('feat(console): 🐛 add x')).toBe('feat(console): ✨ add x');
    expect(suggestHeader('perf:  faster')).toBe('perf: ⚡️ faster');
  });

  test('gives nothing for an unknown type, an empty subject or a valid header', () => {
    expect(suggestHeader('feature: add x')).toBeUndefined();
    expect(suggestHeader('feat: ')).toBeUndefined();
    expect(suggestHeader('feat: ✨ add x')).toBeUndefined();
  });

  test('a failed check carries the suggestion and the report shows it with examples', () => {
    const check = checkCommitMessage('docs: explain routes');
    expect(check.suggestion).toBe('docs: 📝 explain routes');
    const report = formatReport(check, 'abc123');
    expect(report).toContain('abc123: invalid commit message');
    expect(report).toContain('corrected header: docs: 📝 explain routes');
    expect(report).toContain('feat(console): ✨ add route search');
    expect(report).toContain('chore 🔧');
  });
});

describe('cleanMessage', () => {
  test('drops comments, the scissors section and extra blank lines', () => {
    const raw = [
      '',
      'feat: ✨ add x   ',
      '',
      '',
      'Body line.',
      '# Please enter the commit message',
      '# ------------------------ >8 ------------------------',
      'diff --git a/x b/x',
      '',
    ].join('\n');
    expect(cleanMessage(raw)).toBe('feat: ✨ add x\n\nBody line.');
  });

  test('keeps # lines when comments are off and handles CRLF', () => {
    expect(cleanMessage('fix: 🐛 y\r\n\r\n#123 is the issue\r\n', null)).toBe(
      'fix: 🐛 y\n\n#123 is the issue',
    );
  });

  test('uses another comment character', () => {
    expect(cleanMessage('; note\nfix: 🐛 y', ';')).toBe('fix: 🐛 y');
  });
});

describe('addMissingEmoji', () => {
  test('inserts the emoji of the type and keeps the rest of the file', () => {
    const raw = '# comment\nfeat(api)!: add x\n\nbody\n# more\n';
    expect(addMissingEmoji(raw)).toEqual({
      message: '# comment\nfeat(api)!: ✨ add x\n\nbody\n# more\n',
      changed: true,
    });
  });

  test('keeps CRLF line endings', () => {
    expect(addMissingEmoji('chore: tidy\r\n').message).toBe('chore: 🔧 tidy\r\n');
  });

  test('changes nothing when an emoji is present, the type is unknown or the header is special', () => {
    for (const raw of [
      'feat: ✨ add x',
      'feat: 🐛 wrong emoji stays for the check',
      'feature: add x',
      'Feat: add x',
      "Merge branch 'main'",
      'fixup! feat: ✨ add x',
      'feat: ',
      '# only comments\n',
    ]) {
      expect(addMissingEmoji(raw)).toEqual({ message: raw, changed: false });
    }
  });

  test('a fixed message passes the check', () => {
    const { message } = addMissingEmoji('refactor(routing): split the planner');
    expect(checkCommitMessage(cleanMessage(message)).ok).toBe(true);
  });
});
