// Reads one git invocation's arguments the way git does, by the option table in git-options.json,
// and says what it does to a repository agents share: which rule refuses it, what a guard save must
// keep before it runs, or nothing.
//
// A word the shell builds at run time reads as one opaque word. An invocation git would refuse (an
// option it does not know, an ambiguous abbreviation, an unknown word before the command) is
// unreadable and passes: it writes nothing, or the hook cannot tell what it writes.

const { readTable } = require('./git-options');

const TABLE = readTable();

// The names that mean the current commit.
const HEAD_NAMES = new Set(['HEAD', '@']);

// The subcommands of `git stash` and `git worktree`. A stash whose first word starts with `-`, or
// that has none, is a push.
const SUBCOMMANDS = {
  stash: new Set(['push', 'save', 'pop', 'apply', 'drop', 'clear', 'list', 'show', 'create', 'store', 'branch']),
  worktree: new Set(['add', 'list', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock'])
};

class Unreadable extends Error {}

// The global options before the command, the command, and the words after it.
function readGlobals(words, unknown) {
  const globals = { C: [], gitDir: null, workTree: null, config: [], exits: false };
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (unknown[index]) throw new Unreadable('a word before the git command is built at run time');
    if (!word.startsWith('-')) break;
    const [name, attached] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, null];
    const kind = TABLE.global[name];
    if (!kind) throw new Unreadable(`git does not know the option ${word}`);
    let value = attached;
    if (kind === 'exit') globals.exits = true;
    if ((kind === 'separate' || kind === 'next') && attached === null) {
      if (index + 1 >= words.length) throw new Unreadable(`${name} needs a value`);
      value = { text: words[index + 1], unknown: unknown[index + 1] };
      index++;
    } else if (value !== null) {
      value = { text: value, unknown: unknown[index] };
    }
    if (kind === 'separate' && attached !== null) throw new Unreadable(`${name} takes its value as the next word`);
    if (name === '-C') globals.C.push(value);
    if (name === '--git-dir') globals.gitDir = value;
    if (name === '--work-tree') globals.workTree = value;
    if (name === '-c' || name === '--config-env') globals.config.push(configSetting(name, value));
    index++;
  }
  return { globals, index };
}

// A `-c` or `--config-env` setting as { key, value }, null where the hook cannot read it. `-c key`
// without `=` sets true, and `--config-env` reads its value from a variable.
function configSetting(name, spelled) {
  if (spelled.unknown) return { key: null, value: null };
  const equals = spelled.text.indexOf('=');
  if (equals === -1) return { key: spelled.text, value: name === '-c' ? 'true' : null };
  return { key: spelled.text.slice(0, equals), value: name === '-c' ? spelled.text.slice(equals + 1) : null };
}

// The long option `name` names in `options`: an exact name, or the one name it abbreviates.
function longOption(options, name) {
  if (Object.prototype.hasOwnProperty.call(options.long, name)) return name;
  const candidates = Object.keys(options.long).filter(candidate => candidate.startsWith(name));
  if (candidates.length === 1) return candidates[0];
  throw new Unreadable(candidates.length === 0 ? `git does not know --${name}` : `--${name} is ambiguous`);
}

// Reads the words after a command by its options, as parse-options does: options and operands
// interleave, `--` starts the pathspecs, and `-h` or `--help` shows help.
function readArguments(words, unknown, quoted, start, options) {
  const read = { options: new Map(), operands: [], pathspecs: [], dashDash: false, help: false, runTime: false };
  const set = (name, value) => {
    if (!read.options.has(name)) read.options.set(name, []);
    read.options.get(name).push(value);
  };
  const valueAt = at => ({ text: words[at], unknown: unknown[at] });
  let index = start;
  let optionsEnded = false;
  while (index < words.length) {
    const word = words[index];
    const opaque = unknown[index];
    if (opaque) {
      // A word built at run time is one operand. An unquoted one may split or vanish, and one that
      // starts with a dash may be an option.
      if (!optionsEnded && word.startsWith('-')) throw new Unreadable('an option is built at run time');
      if (!quoted[index]) read.runTime = true;
      (read.dashDash ? read.pathspecs : read.operands).push(valueAt(index));
      index++;
      continue;
    }
    if (optionsEnded || word === '-' || !word.startsWith('-')) {
      (read.dashDash ? read.pathspecs : read.operands).push(valueAt(index));
      index++;
      continue;
    }
    if (word === '--') {
      read.dashDash = true;
      optionsEnded = true;
      index++;
      continue;
    }
    if (word === '--end-of-options') {
      optionsEnded = true;
      index++;
      continue;
    }
    if (word === '-h' || word === '--help') {
      read.help = true;
      return read;
    }
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = longOption(options, equals === -1 ? word.slice(2) : word.slice(2, equals));
      const kind = options.long[name];
      const attached = equals === -1 ? null : word.slice(equals + 1);
      if (kind === 'none') {
        if (attached !== null) throw new Unreadable(`--${name} takes no value`);
        set(name, true);
      } else if (attached !== null) {
        set(name, { text: attached, unknown: false });
      } else if (kind === 'next' || (kind === 'last' && index + 1 < words.length)) {
        if (index + 1 >= words.length) throw new Unreadable(`--${name} needs a value`);
        set(name, valueAt(index + 1));
        index++;
      } else {
        set(name, true);
      }
      index++;
      continue;
    }
    // A cluster of short options. One that takes a value takes the rest of the cluster, or the next
    // word.
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      const entry = options.short[letter];
      if (!entry) {
        if (letter === 'h' && at === 1 && word.length === 2) {
          read.help = true;
          return read;
        }
        throw new Unreadable(`git does not know -${letter}`);
      }
      const name = entry.name || `-${letter}`;
      const rest = word.slice(at + 1);
      if (entry.takes === 'none') {
        set(name, true);
        continue;
      }
      if (rest !== '') set(name, { text: rest, unknown: false });
      else if (entry.takes === 'next' || (entry.takes === 'last' && index + 1 < words.length)) {
        if (index + 1 >= words.length) throw new Unreadable(`-${letter} needs a value`);
        set(name, valueAt(index + 1));
        index++;
      } else set(name, true);
      break;
    }
    index++;
  }
  return read;
}

// Reads a git invocation's words, `words[0]` being the program. Returns the global options, the
// command (`stash pop` for a stash subcommand) and its arguments, or `unreadable` with the reason.
function parseGit(words, unknown, quoted) {
  try {
    const { globals, index } = readGlobals(words, unknown);
    if (globals.exits || index >= words.length) return { globals, command: null };
    let command = words[index];
    let start = index + 1;
    if (SUBCOMMANDS[command]) {
      const next = words[start];
      if (next !== undefined && unknown[start]) throw new Unreadable(`the ${command} subcommand is built at run time`);
      if (next !== undefined && SUBCOMMANDS[command].has(next)) {
        command = `${command} ${next}`;
        start++;
      } else if (command === 'stash' && (next === undefined || next.startsWith('-'))) {
        command = 'stash push';
      } else if (command === 'stash') {
        throw new Unreadable(`git stash does not know ${next}`);
      }
    }
    const options = TABLE.commands[command];
    if (!options) return { globals, command };
    return { globals, command, ...readArguments(words, unknown, quoted, start, options) };
  } catch (error) {
    if (error instanceof Unreadable) return { unreadable: error.message };
    throw error;
  }
}

const has = (read, ...names) => names.some(name => read.options.has(name));
const lastValue = (read, name) => {
  const values = read.options.get(name);
  return values ? values[values.length - 1] : undefined;
};
// The reset mode: the last of the mode options, as git takes it.
function resetMode(read) {
  let mode = 'mixed';
  for (const [name] of read.options) if (['soft', 'mixed', 'hard', 'merge', 'keep'].includes(name)) mode = name;
  return mode;
}

// Whether a pathspec covers the whole work tree: `:/` in any spelling git gives it, or `.` and `*`
// at the top of the work tree.
function coversRoot(spec, atTop) {
  if (spec.unknown) return false;
  const text = spec.text.replace(/\\/g, '/');
  if (/^:(?:\/|\(top\))(?:\.|\*|\/)?$/.test(text)) return true;
  return atTop && /^(?:\.\/?|\*)$/.test(text);
}

// What an invocation does where it runs, given its reading and `repo`, which answers the lookups a
// few forms need (repositoryLookups in git-place.js). Returns one of:
// - { deny: rule, target } for a form that works on a branch other than the shared one
//   (git-head.js) or detaches HEAD, which applies where the git directory is shared;
// - { save } for a form that discards work or undoes a commit or the index, which applies where the
//   work tree or index it names is shared. `save` says what to keep: `tree` (null, `tracked`, or
//   `all` with untracked files), `paths` (the pathspecs, or null for the whole tree),
//   `pathspecFile`, `index`, `branches` and `stash`;
// - null for everything else.
function classify(parsed, repo) {
  if (!parsed.command || parsed.help || !TABLE.commands[parsed.command]) return null;
  const read = parsed;
  const atTop = repo.atTop;
  const specs = [...read.operands, ...read.pathspecs];
  const wholeTree = list => list.length === 0 || list.some(spec => coversRoot(spec, atTop));
  const pathsSave = (list, extra = {}) => {
    const fromFile = lastValue(read, 'pathspec-from-file');
    if (fromFile) return { tree: extra.tree || 'tracked', paths: null, pathspecFile: fromFile, ...extra };
    const unknownPath = list.some(spec => spec.unknown);
    return { tree: 'tracked', paths: wholeTree(list) || unknownPath ? null : list.map(spec => spec.text), ...extra };
  };
  const currentBranchSave = () => ({ branches: [repo.head().attached ? `refs/heads/${repo.head().attached}` : 'HEAD'] });

  switch (read.command) {
    case 'stash list': case 'stash show': case 'stash create': case 'stash store':
      return null;
    case 'stash branch':
      return { deny: 'branch', target: read.operands[0] ? read.operands[0].text : '' };
    case 'stash push': case 'stash save': {
      const untracked = has(read, 'include-untracked', 'all');
      const list = read.command === 'stash push' ? read.pathspecs.concat(read.operands) : [];
      return { save: pathsSave(list, { tree: untracked ? 'all' : 'tracked' }) };
    }
    case 'stash pop': case 'stash apply': {
      const entry = stashEntry(read);
      return { save: { tree: 'tracked', paths: null, stash: read.command === 'stash pop' ? [entry] : [] } };
    }
    case 'stash drop':
      return { save: { stash: [stashEntry(read)] } };
    case 'stash clear':
      return { save: { stash: ['all'] } };

    case 'reset': {
      if (has(read, 'patch')) return null;
      const mode = resetMode(read);
      const fromFile = has(read, 'pathspec-from-file');
      let commit = null;
      let paths;
      if (read.dashDash) {
        commit = read.operands[0] || null;
        paths = read.pathspecs;
      } else if (read.operands.length > 0 && (read.operands[0].unknown || repo.isRevision(read.operands[0].text))) {
        commit = read.operands[0];
        paths = read.operands.slice(1);
      } else {
        paths = read.operands;
      }
      const pathLimited = fromFile || (paths.length > 0 && !wholeTree(paths));
      if (pathLimited) return null;
      const namesHead = commit === null || (!commit.unknown && HEAD_NAMES.has(commit.text));
      const save = {};
      if (mode === 'hard' || mode === 'merge') Object.assign(save, { tree: 'tracked', paths: null });
      if (mode === 'mixed') save.index = true;
      if (!namesHead) Object.assign(save, currentBranchSave());
      return Object.keys(save).length > 0 ? { save } : null;
    }

    case 'clean':
      if (has(read, 'dry-run') || !has(read, 'force', 'interactive')) return null;
      return { save: pathsSave(specs, { tree: 'all' }) };

    case 'restore': {
      const staged = has(read, 'staged');
      const worktree = has(read, 'worktree') || !staged;
      if (specs.length === 0 && !has(read, 'pathspec-from-file')) return null;
      if (worktree) return { save: { ...pathsSave(specs), index: staged && wholeTree(specs) } };
      return wholeTree(specs) && !has(read, 'pathspec-from-file') ? { save: { index: true } } : null;
    }

    case 'checkout-index':
      if (!has(read, 'force') || has(read, 'prefix', 'temp')) return null;
      return { save: has(read, 'all', 'stdin') ? { tree: 'tracked', paths: null } : pathsSave(specs) };

    case 'rm':
      if (has(read, 'dry-run')) return null;
      if (has(read, 'cached')) return wholeTree(specs) && !has(read, 'pathspec-from-file') ? { save: { index: true } } : null;
      return has(read, 'force') ? { save: pathsSave(specs) } : null;

    case 'revert':
      return null;

    case 'worktree add':
      return { deny: 'worktree', target: '' };

    case 'pull': case 'rebase': case 'merge':
      return autostashes(parsed, repo) ? { save: { tree: 'tracked', paths: null } } : null;

    case 'checkout':
      return classifyCheckout(read, repo, pathsSave);

    case 'switch':
      return classifySwitch(read, repo);

    case 'branch':
      return classifyBranch(read, repo);

    default:
      return null;
  }
}

// The save that keeps the shared branch, or every branch while there is none.
const sharedSave = repo => ({ branches: [repo.head().shared ? `refs/heads/${repo.head().shared}` : 'all'] });

// Whether HEAD on local branch `name` stays on the shared branch: it is the shared branch, or there
// is none and `name` is a local branch.
function keepsShared(name, repo) {
  const { shared } = repo.head();
  return shared === null ? repo.isBranch(name) : name === shared;
}

// A branch switch in a shared repository passes when it keeps HEAD on the shared branch. `-` and
// `@{-N}` resolve through the repository first.
function switchTarget(target, repo) {
  if (target.unknown) return null;
  const previous = target.text === '-' || /^@\{-\d+\}$/.test(target.text);
  const name = previous ? repo.previousBranch(target.text === '-' ? '@{-1}' : target.text) : target.text;
  // With no previous branch git refuses the switch itself.
  if (name === null) return null;
  return keepsShared(previous ? name.replace(/^refs\/heads\//, '') : name, repo) ? null : { deny: 'switch', target: target.text };
}

// `checkout -B <name>` or `switch -C <name>` passes only for the shared branch. With a start point,
// or while HEAD is not on it, it moves the shared branch.
function forceCreate(name, startPoint, repo) {
  const { attached, shared } = repo.head();
  const moves = Boolean(startPoint) || shared === null || attached !== shared;
  // A name built at run time may be the shared branch.
  if (name.unknown) return moves ? { save: sharedSave(repo) } : null;
  if (name.text !== shared) return { deny: 'branch', target: name.text };
  return moves ? { save: sharedSave(repo) } : null;
}

// Adds the whole-tree save of a discarding option to a switch's result.
function withDiscard(result, discards) {
  if (!discards || (result && result.deny)) return result;
  return { save: { ...(result && result.save), tree: 'tracked', paths: null } };
}

function classifyCheckout(read, repo, pathsSave) {
  const discards = has(read, 'force', 'merge');
  const created = lastValue(read, '-b') || lastValue(read, 'orphan');
  if (created) return { deny: 'branch', target: created.text };
  if (has(read, 'detach')) return { deny: 'detach', target: read.operands[0] ? read.operands[0].text : 'HEAD' };
  const forced = lastValue(read, '-B');
  if (forced) return withDiscard(forceCreate(forced, read.operands[0], repo), discards);

  // Path mode: a pathspec after `--` or from a file, `--ours` or `--theirs`, `-p`, or any word after
  // the first.
  const pathMode = read.pathspecs.length > 0 || has(read, 'pathspec-from-file', 'ours', 'theirs', 'patch') ||
    read.operands.length > 1;
  if (pathMode) {
    const paths = read.dashDash ? read.pathspecs : read.operands.slice(has(read, 'ours', 'theirs') ? 0 : 1);
    return { save: pathsSave(paths) };
  }
  if (read.operands.length === 0) return withDiscard(null, discards);

  const word = read.operands[0];
  // A word built at run time may name a path, whose working file git would discard.
  if (word.unknown) return { save: pathsSave([word]) };
  if (word.text === '-' || /^@\{-\d+\}$/.test(word.text)) return withDiscard(switchTarget(word, repo), discards);
  if (HEAD_NAMES.has(word.text)) return withDiscard(null, discards);
  if (repo.isRevision(word.text)) {
    return keepsShared(word.text, repo) ? withDiscard(null, discards) : { deny: 'switch', target: word.text };
  }
  if (repo.remoteBranches(word.text) === 1) return { deny: 'branch', target: word.text };
  if (repo.isPath(word.text)) return { save: pathsSave([word]) };
  return null;
}

function classifySwitch(read, repo) {
  const discards = has(read, 'discard-changes', 'force', 'merge');
  const created = lastValue(read, 'create') || lastValue(read, 'orphan');
  if (created) return { deny: 'branch', target: created.text };
  if (has(read, 'detach')) return { deny: 'detach', target: read.operands[0] ? read.operands[0].text : 'HEAD' };
  const forced = lastValue(read, 'force-create');
  if (forced) return withDiscard(forceCreate(forced, read.operands[0], repo), discards);
  if (read.operands.length === 0) return null;
  return withDiscard(switchTarget(read.operands[0], repo), discards);
}

// The stash entry a command names: `all` when the name is built at run time.
function stashEntry(read) {
  const entry = read.operands[0];
  return !entry ? 'stash@{0}' : entry.unknown ? 'all' : entry.text;
}

// Creating, resetting, renaming or copying a branch passes only for the shared branch. Deleting a
// branch passes.
function classifyBranch(read, repo) {
  const force = has(read, 'force');
  const listing = has(read, 'list', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'show-current');
  if (has(read, 'set-upstream-to', 'unset-upstream', 'edit-description') || listing) return null;
  const names = read.operands;
  if (has(read, '-D') || (has(read, 'delete') && force)) {
    const kind = has(read, 'remotes') ? 'remotes' : 'heads';
    if (names.length === 0) return null;
    // A name built at run time may be any branch.
    return { save: { branches: names.some(name => name.unknown) ? [kind === 'heads' ? 'all' : 'all:remotes'] : names.map(name => `refs/${kind}/${name.text}`) } };
  }
  if (has(read, 'delete')) return null;
  const { shared } = repo.head();
  if (has(read, 'move', '-M', 'copy', '-C')) {
    const target = names[names.length - 1];
    if (!target) return null;
    // A name built at run time may be the shared branch.
    if (target.unknown) return { save: sharedSave(repo) };
    if (target.text !== shared) return { deny: 'branch', target: target.text };
    // `-M` and `-C` replace a branch of that name, where `-m` and `-c` fail.
    return has(read, '-M', '-C') || force ? { save: sharedSave(repo) } : null;
  }
  if (names.length === 0 || has(read, 'all', 'remotes')) return null;
  const name = names[0];
  if (!name.unknown && name.text !== shared) return { deny: 'branch', target: name.text };
  return force ? { save: sharedSave(repo) } : null;
}

// Whether a pull, rebase or merge stashes the uncommitted work before it starts, which takes every
// agent's work out of the tree until the stash comes back: `--autostash`, or `rebase.autoStash` or
// `merge.autoStash` for the way it joins the histories. A pull rebases by `--rebase`, else by
// `branch.<name>.rebase`, else by `pull.rebase`. A `-c` setting the hook cannot read counts as true.
function autostashes(parsed, repo) {
  if (has(parsed, 'continue', 'abort', 'skip', 'quit')) return false;
  if (has(parsed, 'autostash')) return true;
  if (has(parsed, 'no-autostash')) return false;
  const config = (key, type) => {
    const setting = parsed.globals.config.filter(entry => entry.key === null || sameKey(entry.key, key)).pop();
    if (!setting) return repo.config(key, type);
    return setting.value === null ? 'true' : setting.value;
  };
  let joins = parsed.command;
  if (joins === 'pull') {
    const option = lastValue(parsed, 'rebase');
    let rebase = option === undefined ? (has(parsed, 'no-rebase') ? 'false' : null)
      : option === true || option.unknown ? 'true' : option.text;
    const { attached } = repo.head();
    if (rebase === null && attached) rebase = config(`branch.${attached}.rebase`);
    if (rebase === null) rebase = config('pull.rebase');
    joins = rebase !== null && !isFalse(rebase) ? 'rebase' : 'merge';
  }
  const autoStash = config(`${joins}.autoStash`, 'bool');
  return autoStash !== null && !isFalse(autoStash);
}

// Git's spellings of false. A setting with an empty value is false.
const isFalse = value => /^(?:false|no|off|0|)$/i.test(value);

// Whether two config keys name the same setting: the section and the name ignore case, and a
// subsection does not.
function sameKey(a, b) {
  const split = key => {
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    return [key.slice(0, first).toLowerCase(), key.slice(first + 1, last), key.slice(last + 1).toLowerCase()];
  };
  return split(a).join('\0') === split(b).join('\0');
}

module.exports = { parseGit, classify };
