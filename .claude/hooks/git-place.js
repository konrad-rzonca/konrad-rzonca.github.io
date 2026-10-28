// Works out where each git invocation in a shell command writes: the directories it may start in,
// and for each the repository, index and work tree git would use there, and whether each of them is
// shared.
//
// A repository is shared when its git common directory holds `worktrees` as a regular file.
// A repository whose agents share one tree writes that file to disable worktrees, and a clone never
// carries it. Deleting the file to allow worktrees also lifts the git rules there.
//
// The directory starts at the call's working directory, and a directory change the hook can spell
// moves it: `cd`, `pushd`, `chdir`, Set-Location and Push-Location to a literal, to a variable
// assigned earlier in the same command, or to `~` or `$HOME`, when the target exists now. A target a
// `git clone` or `git init` earlier in the command creates is a new repository of its own. Anything
// else makes the place unknown: a missing target, `cd -`, `popd`, a variable the hook cannot read,
// and any target after a command the hook does not read, which may have made a repository there.
// After a command that runs in this shell and can move it (`source`, `.`, `eval`, Invoke-Expression,
// a `.ps1` script, a function or script block defined earlier), every later place is unknown. A
// directory change that runs on only some paths leaves both places.
//
// Beside the places it is sure of, it keeps `hints`: places git may run in when it cannot be sure,
// which only a save reads, never a refusal. A change to a target that exists now is a hint even after
// a command the hook does not read, and a change to a missing target leaves the shell where it was.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { commandName } = require('./shell-command-scan');
const { parseGit } = require('./git-command');
const { readHead } = require('./git-head');

const UNKNOWN = null;

// Commands that neither change directory nor can create a repository.
const INERT = new Set([
  'echo', 'printf', 'cat', 'ls', 'dir', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut',
  'tr', 'sed', 'awk', 'test', '[', '[[', 'true', 'false', ':', 'pwd', 'sleep', 'date', 'which', 'type', 'basename',
  'dirname', 'realpath', 'readlink', 'stat', 'file', 'diff', 'cmp', 'jq', 'tee', 'less', 'more', 'set', 'unset', 'local',
  'declare', 'readonly', 'shift', 'return', 'exit', 'read', 'wait', 'printenv', 'for', 'select', 'case', 'fi', 'done',
  'esac', 'then', 'do', 'else', 'elif', 'in', '{', '}', 'write-output', 'write-host', 'write-error', 'write-warning',
  'write-verbose', 'out-null', 'out-string', 'select-object', 'where-object', 'foreach-object', 'sort-object',
  'measure-object', 'format-table', 'format-list', 'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls',
  'test-path', 'get-item', 'gi', 'get-location', 'gl', 'resolve-path', 'split-path', 'join-path', 'convertto-json',
  'convertfrom-json', 'start-sleep', 'get-date', 'get-process', 'get-command', 'gcm', 'if', 'foreach', 'while', 'switch',
  'try', 'catch', 'finally', 'where', 'select', '%', '?'
]);

const DIRECTORY_CHANGES = { Bash: ['cd', 'pushd', 'chdir'], Cmd: ['cd', 'chdir', 'pushd'],
  PowerShell: ['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd'] };
const DIRECTORY_RETURNS = ['popd', 'pop-location'];

// Commands that run their arguments or a file in the calling shell.
const MOVERS = new Set(['source', '.', 'eval', 'iex', 'invoke-expression']);

// Wrappers that run the command after their options. `extraWords` marks one that adds arguments
// only known at run time.
const WRAPPERS = { timeout: {}, nice: {}, nohup: {}, stdbuf: {}, command: {}, exec: {}, time: {}, env: {}, xargs: { extraWords: true } };

const home = () => os.homedir();
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isDirectory = dir => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const isFile = file => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

// A path as the shell spelled it, made absolute against `base`: Git Bash's `/c/...`, `~` and
// `$HOME`, Windows and relative spellings. Returns null for a spelling it cannot place, such as
// Git Bash's `/tmp`.
function absolutePath(text, base, { tilde = false, dialect = 'Bash' } = {}) {
  let spelled = text;
  if ((tilde || dialect === 'PowerShell') && (spelled === '~' || /^~[\\/]/.test(spelled))) spelled = home() + spelled.slice(1);
  if (process.platform === 'win32' && /^\/[A-Za-z](?:\/|$)/.test(spelled)) spelled = `${spelled[1]}:/${spelled.slice(3)}`;
  if (path.isAbsolute(spelled)) {
    if (process.platform === 'win32' && /^[\\/](?![\\/])/.test(spelled)) return null;
    return path.resolve(spelled);
  }
  return base === UNKNOWN ? null : path.resolve(base, spelled);
}

// The value a word stands for: its text when the shell does not build it, or, when the word is a
// variable alone or followed by a path, the variable's value: one the command assigned earlier, or
// the home folder for Bash's `$HOME`, PowerShell's `$HOME` and `$env:USERPROFILE`. PowerShell's
// `$env:HOME` is empty on Windows, so it stays unknown.
function wordValue(text, unknown, variables, env, dialect) {
  if (!unknown) return text;
  const split = dialect === 'Bash' ? /^\$(?:\{(\w+)\}|(\w+))([\\/][^$`]*)?$/.exec(text)
    : dialect === 'PowerShell' ? /^\$(env:)?(\w+)([\\/][^$`]*)?$/i.exec(text) : null;
  if (!split) return null;
  let value;
  if (dialect === 'Bash') {
    const name = split[1] || split[2];
    value = name === 'HOME' ? home() : variables.has(`bash:${name}`) ? variables.get(`bash:${name}`) : null;
  } else if (split[1]) {
    const name = split[2].toUpperCase();
    value = env.has(name) ? env.get(name) : name === 'USERPROFILE' ? home() : null;
  } else {
    const name = split[2].toLowerCase();
    value = name === 'home' ? home() : variables.has(`ps:${name}`) ? variables.get(`ps:${name}`) : null;
  }
  return value === null ? null : value + (split[3] || '');
}

// The git directory `.git` names in `dir`: the folder itself, or the one a `gitdir:` file points at.
function dotGit(dir) {
  const entry = path.join(dir, '.git');
  try {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) return entry;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(entry, 'utf8'));
    return match ? path.resolve(dir, match[1]) : null;
  } catch {
    return null;
  }
}

// The repository git finds from `dir`, walking up as git does: its work tree top and git directory.
function discover(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    const gitDir = dotGit(current);
    if (gitDir) return { top: current, gitDir };
    if (path.dirname(current) === current) return null;
  }
}

function commonDir(gitDir) {
  try {
    return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    return gitDir;
  }
}

const sharedGitDir = gitDir => isFile(path.join(commonDir(gitDir), 'worktrees'));

// What git uses when it runs in `dir` with `env` and the `--git-dir` and `--work-tree` values in
// `globals`: null when git finds no repository there, `unknown` when the hook cannot tell, else the
// repository and whether each part is shared. `created` holds the repositories an earlier command
// makes, which are never shared.
function resolveRepository(dir, env, globals, created) {
  const inCreated = created.find(root => inside(dir, root));
  if (inCreated) return { dir, created: inCreated, top: inCreated, shared: { gitDir: false, index: false, workTree: false } };
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some(name => env.get(name) === null)) return { unknown: true };
  const gitDirSpelling = globals.gitDir || env.get('GIT_DIR');
  const workTreeSpelling = globals.workTree || env.get('GIT_WORK_TREE');
  let gitDir;
  let top;
  if (gitDirSpelling) {
    gitDir = absolutePath(gitDirSpelling, dir);
    if (!gitDir || !isDirectory(gitDir)) return null;
    top = workTreeSpelling ? absolutePath(workTreeSpelling, dir) : dir;
  } else {
    const found = discover(dir);
    if (!found) return null;
    gitDir = found.gitDir;
    top = workTreeSpelling ? absolutePath(workTreeSpelling, dir) : found.top;
  }
  if (!top) return null;
  const gitDirShared = sharedGitDir(gitDir);
  const ownIndex = path.join(gitDir, 'index');
  const indexSpelling = env.get('GIT_INDEX_FILE');
  const index = indexSpelling ? absolutePath(indexSpelling, dir) : ownIndex;
  const indexShared = index !== null && (same(index, ownIndex) ? gitDirShared
    : isFile(path.join(path.dirname(index), 'HEAD')) && sharedGitDir(path.dirname(index)));
  const workTreeRepository = gitDirSpelling || workTreeSpelling ? discover(top) : { gitDir };
  const workTreeShared = Boolean(workTreeRepository) && sharedGitDir(workTreeRepository.gitDir);
  // A repository named by `--git-dir`, `--work-tree` or their variables is saved from the one its
  // work tree belongs to, whole.
  const named = Boolean(gitDirSpelling || workTreeSpelling);
  return {
    dir, gitDir, top, index, atTop: same(path.resolve(dir), path.resolve(top)), named,
    shared: { gitDir: gitDirShared, index: indexShared, workTree: workTreeShared },
    saveRepository: !named ? { top, gitDir } : workTreeShared ? workTreeRepository : null
  };
}

// The lookups a few forms need, answered by git in the repository.
function repositoryLookups(place) {
  const git = args => {
    const result = spawnSync('git', ['-C', place.dir, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  let branches;
  let head;
  const isBranch = name => {
    if (branches === undefined) {
      branches = new Set((git(['for-each-ref', '--format=%(refname)', 'refs/heads/']) || '').split('\n')
        .filter(Boolean).map(ref => ref.slice('refs/heads/'.length)));
    }
    return branches.has(name);
  };
  return {
    atTop: place.atTop,
    head: () => {
      if (head === undefined) head = readHead(place.gitDir, isBranch);
      return head;
    },
    isBranch,
    // A config value, as a boolean's `true` or `false` when `type` is `bool`, or null when unset.
    config: (key, type) => git(['config', ...(type ? [`--type=${type}`] : []), '--get', key]),
    previousBranch: spelling => git(['rev-parse', '--symbolic-full-name', spelling]),
    isRevision: word => git(['rev-parse', '-q', '--verify', '--end-of-options', `${word}^{commit}`]) !== null,
    remoteBranches: word => (git(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${word}`]) || '').split('\n').filter(Boolean).length,
    isPath: word => fs.existsSync(path.resolve(place.dir, word)) || Boolean(git(['ls-files', '--', word]))
  };
}

// Answers for a place the hook cannot resolve: every form reads as its broadest case, except that
// config reads as unset, so that only an explicit option makes a command autostash there.
const UNRESOLVED_LOOKUPS = {
  atTop: false, head: () => ({ attached: null, rebasing: null, shared: null }), isBranch: () => false,
  config: () => null, previousBranch: () => null, isRevision: () => true, remoteBranches: () => 0, isPath: () => false
};

// Follows `steps` from `start` and returns every git invocation with the places it may start in (a
// list of directories, or null when unknown) and the environment it runs with.
function gitInvocations(steps, start, baseEnv) {
  const invocations = [];
  let state = {
    places: start && isDirectory(start) ? [path.resolve(start)] : UNKNOWN,
    hints: start && isDirectory(start) ? [path.resolve(start)] : [],
    variables: new Map(), env: new Map(Object.entries(baseEnv).filter(([name]) => /^GIT_/.test(name))),
    targetsUnknown: false
  };
  const created = [];
  // Scopes entered, each with the state to restore when an isolated one ends.
  let chain = [];
  let override = null;

  const copy = s => ({ ...s, places: s.places && [...s.places], hints: [...s.hints], variables: new Map(s.variables), env: new Map(s.env) });
  const enter = scope => {
    const scopes = scope;
    let common = 0;
    while (common < chain.length && common < scopes.length && chain[common].scope === scopes[common]) common++;
    for (let i = chain.length - 1; i >= common; i--) {
      if (chain[i].saved) state = { ...chain[i].saved, targetsUnknown: state.targetsUnknown || chain[i].saved.targetsUnknown };
    }
    chain = chain.slice(0, common);
    for (let i = common; i < scopes.length; i++) chain.push({ scope: scopes[i], saved: scopes[i].isolated ? copy(state) : null });
  };
  const placesFor = step => {
    if (step.elsewhere) return UNKNOWN;
    if (override && override.list === step.list && step.joiner === '&&') return override.places;
    return state.places;
  };
  const hintsFor = step => {
    if (step.elsewhere) return [];
    if (override && override.list === step.list && step.joiner === '&&') return override.hints;
    return state.hints;
  };
  const union = (a, b) => a === UNKNOWN || b === UNKNOWN ? UNKNOWN : [...new Set([...a, ...b])];
  const unionHints = (a, b) => [...new Set([...a, ...b])];

  // Moves the shell to `targets` (null when unknown), certainly or on some paths only, and its hints
  // to `hints`. `stays` are the places a change that fails leaves the shell in, which a command
  // joined by `&&` never runs in.
  const move = (step, targets, hints = targets || [], stays = []) => {
    if ((step.dialect === 'Bash' && step.piped) || (step.dialect === 'Bash' && step.joiner === '|')) return;
    const before = placesFor(step);
    const beforeHints = hintsFor(step);
    if (step.conditional || step.joiner === '||') {
      state.places = union(before, targets);
      state.hints = unionHints(beforeHints, unionHints(hints, stays));
      override = null;
    } else if (step.joiner === '&&') {
      state.places = union(before, targets);
      state.hints = unionHints(beforeHints, unionHints(hints, stays));
      override = { list: step.list, places: targets, hints };
    } else {
      state.places = targets;
      state.hints = unionHints(hints, stays);
      // What follows with `&&` runs only if the change succeeded.
      override = { list: step.list, places: targets, hints };
    }
  };

  // Where a directory change to the word leaves the shell: `targets` when the hook is sure, else
  // null, and the `hints` and `stays` a save may still use (see move).
  const targetsOf = (step, text, unknown, tilde) => {
    const value = wordValue(text, unknown, state.variables, state.env, step.dialect);
    if (value === null) return { targets: UNKNOWN, hints: [], stays: [] };
    const bases = placesFor(step);
    const options = { tilde, dialect: step.dialect };
    const targets = [];
    for (const base of bases === UNKNOWN ? [UNKNOWN] : bases) {
      const target = absolutePath(value, base, options);
      if (state.targetsUnknown || target === null || !(isDirectory(target) || created.some(root => inside(target, root)))) {
        targets.length = 0;
        break;
      }
      targets.push(target);
    }
    if (targets.length > 0) return { targets, hints: targets, stays: [] };
    const hintBases = bases === UNKNOWN ? hintsFor(step) : bases;
    const hints = [];
    const stays = [];
    for (const base of hintBases.length > 0 ? hintBases : [UNKNOWN]) {
      const target = absolutePath(value, base, options);
      if (target !== null && isDirectory(target)) hints.push(target);
      else if (target !== null && base !== UNKNOWN && !fs.existsSync(target)) stays.push(base);
    }
    return { targets: UNKNOWN, hints: [...new Set(hints)], stays: [...new Set(stays)] };
  };

  for (const step of steps) {
    enter(step.scope);
    if (override && (step.list !== override.list)) override = null;

    if (step.kind === 'function') {
      state.places = UNKNOWN;
      state.hints = [];
      continue;
    }
    if (step.kind === 'assign') {
      const name = step.name.replace(/^\$/, '');
      const envName = /^env:(\w+)$/i.exec(name);
      const value = step.unknown ? null : step.value;
      if (envName) {
        if (value === null) state.env.delete(envName[1].toUpperCase());
        else state.env.set(envName[1].toUpperCase(), value);
      } else {
        const key = step.dialect === 'PowerShell' ? `ps:${name.toLowerCase()}` : `bash:${name}`;
        if (value === null) state.variables.delete(key);
        else state.variables.set(key, value);
        if (step.dialect === 'Bash' && /^GIT_/.test(name)) {
          if (value === null) state.env.delete(name);
          else state.env.set(name, value);
        }
      }
      continue;
    }

    let words = step.words;
    let unknown = step.unknown;
    let quoted = step.quoted;
    let name = commandName(words[0]);
    const env = new Map(state.env);
    for (const assignment of step.assignments || []) {
      if (/^GIT_/.test(assignment.name)) {
        if (assignment.unknown) env.set(assignment.name, null);
        else env.set(assignment.name, assignment.value);
      }
    }
    // A wrapper runs git after its own options and assignments; `env -C` runs it somewhere else.
    let elsewhere = false;
    let appends = false;
    let replace = null;
    // `find -exec <command> {} ;` runs the command on what it finds, and `-execdir` in each one's folder.
    if (name === 'find') {
      const exec = words.findIndex((word, i) => i > 0 && /^-(?:exec|execdir|ok|okdir)$/.test(word));
      if (exec > 0) {
        let end = words.findIndex((word, i) => i > exec && /^(?:\\?;|\+)$/.test(word));
        if (end < 0) end = words.length;
        if (/dir$/.test(words[exec])) elsewhere = true;
        unknown = unknown.slice(exec + 1, end).map((isUnknown, i) => isUnknown || words[exec + 1 + i] === '{}');
        quoted = quoted.slice(exec + 1, end);
        words = words.slice(exec + 1, end);
        if (words.length === 0) continue;
        name = commandName(words[0]);
      }
    }
    while (WRAPPERS[name] && words.length > 1) {
      if (WRAPPERS[name].extraWords) appends = true;
      let at = 1;
      while (at < words.length && (words[at].startsWith('-') || (name === 'env' && /^\w+=/.test(words[at])) ||
        (name === 'timeout' && at === 1 && /^\d/.test(words[at])))) {
        if (name === 'env' && /^-[A-Za-z]*C/.test(words[at])) elsewhere = true;
        if (name === 'env' && /^\w+=/.test(words[at])) {
          const [variable, ...rest] = words[at].split('=');
          if (/^GIT_/.test(variable)) env.set(variable, unknown[at] ? null : rest.join('='));
        }
        if (name === 'timeout' && /^-[sk]$/.test(words[at])) at++;
        if (name === 'xargs') {
          const option = words[at];
          const replaceShort = /^-I(.*)$/.exec(option);
          const replaceLong = /^(?:-i|--replace)(?:=?)(.*)$/.exec(option);
          if (replaceShort) replace = replaceShort[1] || words[++at];
          else if (replaceLong) replace = replaceLong[1] || '{}';
          else if (/^-[nLPsdEa]$/.test(option) ||
            /^--(?:max-args|max-lines|max-procs|max-chars|delimiter|eof|arg-file|process-slot-var)$/.test(option)) at++;
        }
        at++;
      }
      if (name === 'timeout' && at < words.length && /^\d/.test(words[at])) at++;
      words = words.slice(at);
      unknown = unknown.slice(at);
      quoted = quoted.slice(at);
      if (words.length === 0) break;
      name = commandName(words[0]);
    }
    if (words.length === 0) continue;
    // What the command wrote, before the run-time words below.
    const spelled = words;
    if (replace) {
      unknown = unknown.map((isUnknown, i) => isUnknown || words[i].includes(replace));
    } else if (appends) {
      words = [...words, '{}'];
      unknown = [...unknown, true];
      quoted = [...quoted, false];
    }

    const prefixMover = (step.prefix || []).some(word => word === '.');
    if (name === 'git') {
      const parsed = parseGit(words, unknown, quoted);
      const dirs = elsewhere ? UNKNOWN : invocationDirectories(step, parsed, placesFor(step));
      if (dirs !== UNKNOWN && dirs.length === 0) continue;
      const bases = placesFor(step) === UNKNOWN ? hintsFor(step) : placesFor(step);
      const hints = dirs === UNKNOWN && !elsewhere && !step.elsewhere ? hintDirectories(step, parsed, bases) : [];
      invocations.push({ step, words, spelled, parsed, dirs, hints, env, created: [...created], ...resolvedGlobals(step, parsed) });
      if (dirs !== UNKNOWN) noteCreated(parsed, dirs, created);
    } else if ((DIRECTORY_CHANGES[step.dialect] || []).includes(name)) {
      const target = directoryArgument(step, words, unknown);
      if (target === 'none') {
        if (step.dialect === 'Bash' && name !== 'pushd') move(step, [home()]);
        else if (step.dialect !== 'Cmd') move(step, UNKNOWN);
      } else {
        const { targets, hints, stays } = target === UNKNOWN ? { targets: UNKNOWN, hints: [], stays: [] } :
          targetsOf(step, target.text, target.unknown, target.tilde);
        move(step, targets, hints, stays);
      }
    } else if (DIRECTORY_RETURNS.includes(name)) {
      move(step, UNKNOWN);
    } else if (MOVERS.has(name) || prefixMover || /\.ps1$/i.test(words[0])) {
      state.places = UNKNOWN;
      state.hints = [];
      override = null;
    } else if (name === 'export' && step.dialect === 'Bash') {
      for (let i = 1; i < words.length; i++) {
        const match = /^(\w+)=([\s\S]*)$/.exec(words[i]);
        const variable = match ? match[1] : words[i];
        if (!/^GIT_/.test(variable)) continue;
        const value = match ? (unknown[i] ? null : match[2]) : state.variables.get(`bash:${variable}`);
        if (value === null || value === undefined) state.env.delete(variable);
        else state.env.set(variable, value);
      }
    } else if (!INERT.has(name)) {
      state.targetsUnknown = true;
    }
  }
  return invocations;

  // The directories git runs in after its `-C` options, dropping one git fails to enter, or null
  // when unknown.
  function invocationDirectories(step, parsed, starts) {
    if (parsed.unreadable || starts === UNKNOWN) return starts;
    let dirs = starts;
    for (const change of parsed.globals.C) {
      if (!change.unknown && change.text === '') continue;
      if (state.targetsUnknown) return UNKNOWN;
      const value = wordValue(change.text, change.unknown, state.variables, state.env, step.dialect);
      if (value === null) return UNKNOWN;
      dirs = dirs.map(dir => absolutePath(value, dir));
      if (dirs.some(dir => dir === null)) return UNKNOWN;
    }
    return dirs.filter(dir => isDirectory(dir) || created.some(root => inside(dir, root)));
  }

  // The directories git may start in when invocationDirectories cannot tell: `bases` moved by the
  // `-C` options the hook can spell, even after a command it does not read.
  function hintDirectories(step, parsed, bases) {
    if (parsed.unreadable) return [];
    let dirs = bases.length > 0 ? bases : [UNKNOWN];
    for (const change of parsed.globals.C) {
      if (!change.unknown && change.text === '') continue;
      const value = wordValue(change.text, change.unknown, state.variables, state.env, step.dialect);
      if (value === null) return [];
      dirs = dirs.map(dir => absolutePath(value, dir)).filter(dir => dir !== null);
    }
    return [...new Set(dirs.filter(dir => dir !== UNKNOWN && isDirectory(dir)))];
  }

  // `--git-dir` and `--work-tree` as the hook reads them, with `unknownGlobals` when it cannot.
  function resolvedGlobals(step, parsed) {
    const resolved = {};
    if (parsed.unreadable) return resolved;
    for (const key of ['gitDir', 'workTree']) {
      const spelled = parsed.globals[key];
      if (!spelled) continue;
      const value = state.targetsUnknown ? null : wordValue(spelled.text, spelled.unknown, state.variables, state.env, step.dialect);
      if (value === null) resolved.unknownGlobals = true;
      else resolved[key] = value;
    }
    return resolved;
  }
}

// The one directory a directory change names: 'none' for none, null when the hook cannot tell.
function directoryArgument(step, words, unknown) {
  const found = [];
  for (let i = 1; i < words.length; i++) {
    const text = words[i];
    const word = { text, unknown: unknown[i], tilde: step.tilde[i] };
    if (step.dialect === 'PowerShell' && !unknown[i] && /^-/.test(text)) {
      if (/^-(?:Path|LiteralPath|PSPath|LP)$/i.test(text) && i + 1 < words.length) {
        found.push({ text: words[i + 1], unknown: unknown[i + 1], tilde: step.tilde[i + 1] });
        i++;
      } else if (/^-(?:StackName|ErrorAction|EA|WarningAction|WA|InformationAction|InfA|ErrorVariable|EV|WarningVariable|WV|InformationVariable|IV|OutVariable|OV|OutBuffer|OB|PipelineVariable|PV)$/i.test(text)) i++;
      continue;
    }
    if (step.dialect === 'Cmd' && /^\/d$/i.test(text)) continue;
    if (step.dialect === 'Bash' && !unknown[i] && /^-[LPe@]*$/.test(text)) continue;
    found.push(word);
  }
  if (found.length === 0) return 'none';
  if (found.length > 1 || (found[0].text === '-' && !found[0].unknown)) return UNKNOWN;
  return found[0];
}

// Records the repository a `git clone` or `git init` makes, when the hook can place it: a clone's
// target when it is missing or an empty directory now, an init's when it has no `.git` of its own.
function noteCreated(parsed, dirs, created) {
  if (parsed.unreadable || parsed.help || (parsed.command !== 'clone' && parsed.command !== 'init')) return;
  const operands = parsed.operands.concat(parsed.pathspecs);
  if (operands.some(operand => operand.unknown)) return;
  for (const dir of dirs) {
    if (parsed.command === 'init') {
      const target = operands[0] ? absolutePath(operands[0].text, dir) : dir;
      if (target && !dotGit(target)) created.push(target);
      continue;
    }
    if (operands.length === 0) return;
    const source = operands[0].text;
    const sourceName = path.basename(absolutePath(source, dir) || source).replace(/(?:[\/]?\.git)?[\/]?$/, '');
    const bare = parsed.options.has('bare') || parsed.options.has('mirror');
    const target = operands[1] ? absolutePath(operands[1].text, dir) : absolutePath(bare ? `${sourceName}.git` : sourceName, dir);
    if (!target) continue;
    if (!fs.existsSync(target) || (isDirectory(target) && fs.readdirSync(target).length === 0)) created.push(target);
  }
}

module.exports = { gitInvocations, resolveRepository, repositoryLookups, UNRESOLVED_LOOKUPS, UNKNOWN };
