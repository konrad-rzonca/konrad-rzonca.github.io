// Builds git-options.json, the options block-destructive-git.js reads git's arguments by, from the
// help the installed git prints (`LC_ALL=C git <verb> [<sub>] -h`). The hook reads only the JSON, so
// it never runs git to learn its options. Run `node git-options.js` after a git upgrade;
// test-destructive-git.js fails while the file and the installed git disagree.
//
// Each option maps to how it takes a value:
// - `none`: never.
// - `next`: an attached value (`--name=value`, `-nvalue`) or else the next word.
// - `attached`: only an attached one, as `--name[=<arg>]` prints.
// - `last`: an attached one, or else the next word when one follows (git's PARSE_OPT_LASTARG_DEFAULT,
//   which help cannot show).
// A `--[no-]name` option also has `no-name`, which never takes a value.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TABLE = path.join(__dirname, 'git-options.json');

// The commands whose arguments the hook reads: the ones it guards, and the ones that create a
// repository in a place a later command may name.
const COMMANDS = [
  'stash push', 'stash save', 'stash pop', 'stash apply', 'stash drop', 'stash clear', 'stash list', 'stash show',
  'stash create', 'stash store', 'stash branch', 'reset', 'clean', 'restore', 'checkout', 'checkout-index', 'switch',
  'rm', 'revert', 'branch', 'worktree add', 'pull', 'rebase', 'merge', 'clone', 'init'
];

// Options whose value git takes only when a word follows (ref-filter's OPT_CONTAINS and OPT_MERGED).
const LAST_ARGUMENT_DEFAULT = { branch: ['contains', 'no-contains', 'merged', 'no-merged'] };

// git.c reads its own options before the command, by exact spelling, with no abbreviations. `-C`
// and `-c` take only the next word. `git -h` lists some of them, which the harness checks.
const GLOBAL = {
  '-C': 'separate', '-c': 'separate', '--git-dir': 'next', '--work-tree': 'next', '--namespace': 'next',
  '--config-env': 'next', '--attr-source': 'next', '--exec-path': 'attached', '--list-cmds': 'attached',
  '--html-path': 'none', '--man-path': 'none', '--info-path': 'none', '-p': 'none', '--paginate': 'none',
  '-P': 'none', '--no-pager': 'none', '--no-replace-objects': 'none', '--no-lazy-fetch': 'none',
  '--no-optional-locks': 'none', '--no-advice': 'none', '--bare': 'none', '--literal-pathspecs': 'none',
  '--glob-pathspecs': 'none', '--noglob-pathspecs': 'none', '--icase-pathspecs': 'none',
  '-v': 'exit', '--version': 'exit', '-h': 'exit', '--help': 'exit'
};

// parse-options.c prints each option's description at this column (USAGE_OPTS_WIDTH plus its gap).
const DESCRIPTION_COLUMN = 26;

// `git stash <sub> -h` needs a repository, so help is read inside an empty one.
function helpText(args, repository) {
  const result = spawnSync('git', [...args, '-h'], { cwd: repository, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return (result.stdout || '') + (result.stderr || '');
}

function withRepository(read) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'git-options-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: repository });
    return read(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

// The options one help text lists: `long` by name without dashes, `short` by letter, each with how it
// takes a value and, for a short one, the long name it stands for.
function parseHelp(text, lastDefault = []) {
  const long = {};
  const short = {};
  for (const line of text.split(/\r?\n/)) {
    if (!/^ {4}-/.test(line)) continue;
    // A description starts at column 26 after a blank, or on the next line after a longer option.
    const spec = (line.length > DESCRIPTION_COLUMN && line[DESCRIPTION_COLUMN - 1] === ' '
      ? line.slice(0, DESCRIPTION_COLUMN) : line).trim();
    const match = /^(?:-([^-\s,]))?(?:, )?(?:--(\[no-\])?([A-Za-z0-9][\w-]*))?(.*)$/.exec(spec);
    if (!match || (!match[1] && !match[3])) continue;
    const [, letter, negatable, name, rest] = match;
    const takes = rest === '' ? 'none' : rest.startsWith('[=') || rest.startsWith('[<') ? 'attached' : 'next';
    const kind = name && lastDefault.includes(name) ? 'last' : takes;
    if (name) {
      long[name] = kind;
      if (negatable) long[`no-${name}`] = 'none';
    }
    if (letter) short[letter] = { takes: kind, name: name || null };
  }
  return { long, short };
}

function buildTable() {
  return withRepository(repository => {
    const commands = {};
    for (const command of COMMANDS) {
      const words = command.split(' ');
      commands[command] = parseHelp(helpText(words, repository), LAST_ARGUMENT_DEFAULT[words[0]]);
    }
    return { global: GLOBAL, commands };
  });
}

// The global options `git -h` prints, which the table must agree with.
function listedGlobals() {
  const usage = withRepository(repository => helpText([], repository)).split(/\r?\n\r?\n/)[0];
  const found = {};
  for (const [, name, value] of usage.matchAll(/\[?(--?[A-Za-z][\w-]*)(\[=<[^>]+>\]|=<[^>]+>| <[^>]+>)?/g)) {
    found[name] = value === undefined ? 'none' : value.startsWith('[=') ? 'attached' : value.startsWith(' ') ? 'separate' : 'next';
  }
  return found;
}

function readTable() {
  return JSON.parse(fs.readFileSync(TABLE, 'utf8'));
}

if (require.main === module) {
  fs.writeFileSync(TABLE, JSON.stringify(buildTable(), null, 1) + '\n');
  console.log(`wrote ${TABLE}`);
}

module.exports = { buildTable, listedGlobals, readTable };
