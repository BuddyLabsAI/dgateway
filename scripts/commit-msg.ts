// Checks commit messages with src/packages/commit-message.
//
//   bun scripts/commit-msg.ts --file <path> [--fix] [--allow-fixup]   message file (commit-msg hook)
//   bun scripts/commit-msg.ts --range <from>..<to>                    every commit in a range (CI)
//   bun scripts/commit-msg.ts --commit <rev>                          one commit (CI)
//   bun scripts/commit-msg.ts --message <text>                        one string, such as a PR title
//
// --fix inserts the type's missing emoji into the message file before the check. Exit codes: 0 when
// every message passes, 1 when one fails, 2 for a usage or git error.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  addMissingEmoji,
  checkCommitMessage,
  cleanMessage,
  formatReport,
  type CheckOptions,
} from '../src/packages/commit-message';

type Labeled = { label?: string; message: string };

const USAGE =
  'usage: bun scripts/commit-msg.ts (--file <path> [--fix] [--allow-fixup] | --range <a>..<b> | --commit <rev> | --message <text>)';

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString());
    throw new Error(`git ${args.join(' ')} failed`);
  }
  return result.stdout.toString();
}

// Reads commit messages from history as sha + raw body records.
function commitMessages(args: string[]): Labeled[] {
  return git(['log', '--format=%H%x1f%B%x1e', ...args])
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.includes('\x1f'))
    .map((record) => {
      const [sha, body] = record.split('\x1f');
      return { label: sha.slice(0, 12), message: cleanMessage(body, null) };
    });
}

function fromFile(path: string, fix: boolean): Labeled[] {
  let raw = readFileSync(path, 'utf8');
  if (fix) {
    const fixed = addMissingEmoji(raw);
    if (fixed.changed) {
      writeFileSync(path, fixed.message);
      raw = fixed.message;
      process.stderr.write(`commit-msg: added the emoji: ${cleanMessage(raw).split('\n')[0]}\n`);
    }
  }
  return [{ message: cleanMessage(raw) }];
}

function report(messages: Labeled[], options: CheckOptions): number {
  let failed = 0;
  for (const { label, message } of messages) {
    const check = checkCommitMessage(message, options);
    if (check.ok) continue;
    failed += 1;
    process.stderr.write(`${formatReport(check, label)}\n\n`);
  }
  if (failed > 0)
    process.stderr.write(`${failed} of ${messages.length} commit message(s) failed\n`);
  else console.log(`${messages.length} commit message(s) passed`);
  return failed > 0 ? 1 : 0;
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string' },
      range: { type: 'string' },
      commit: { type: 'string' },
      message: { type: 'string' },
      fix: { type: 'boolean', default: false },
      'allow-fixup': { type: 'boolean', default: false },
    },
  });
  const modes = [values.file, values.range, values.commit, values.message].filter(
    (value) => value !== undefined,
  );
  if (modes.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const options = { allowFixup: values['allow-fixup'] };
  if (values.file !== undefined) return report(fromFile(values.file, values.fix), options);
  if (values.message !== undefined)
    return report([{ label: 'title', message: values.message.trim() }], options);
  const messages =
    values.range !== undefined
      ? commitMessages([values.range])
      : commitMessages(['-1', values.commit ?? 'HEAD']);
  return report(messages, options);
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`commit-msg: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
