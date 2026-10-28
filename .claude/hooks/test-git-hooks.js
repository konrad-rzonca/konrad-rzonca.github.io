// Checks the guard's git hooks, in throwaway repositories: `node .claude/hooks/test-git-hooks.js`.
//
// It takes the hooks from the folder `core.hooksPath` names when the repository sets one, and
// otherwise installs pre-push.sh through install-git-hooks.ps1 (or copies it when PowerShell is
// missing). `shared` carries the worktrees marker and pushes to the bare `remote.git`; `clone` is a
// clone of the remote without the marker.
//
// - A push that rewrites or deletes the shared branch on the shared remote saves the old tip, fetched
//   first when the pushing repository lacks it, on master, main or direction/x alike, and with HEAD
//   detached. A fast-forward, another branch, another remote and an unshared repository save
//   nothing.
// - A save script that crashes or is missing lets the push go ahead with a warning.
// - The installer installs reference-transaction only while reference-transaction/ beside it holds
//   a check, removes its own hook once none is left, and leaves another hook alone. Its -Check
//   changes nothing. It reports each hook an install would add, replace or remove, and each other
//   hook in the way of an install.
//
// - When reference-transaction.sh is beside this file, it runs as the hook of a repository of its
//   own, with stand-in checks in that repository's .claude/hooks/reference-transaction/. Before
//   the shared branch moves, every check runs with that branch's update line on stdin, on master,
//   main, trunk or direction/x alike, at the end of a rebase, and for every branch while HEAD is
//   detached with no rebase. Exit 1 refuses with the check's message shown, any other failure lets
//   the update through with a warning and a line in hook-errors.log, and no folder or an empty one
//   lets it through silently. An update of another branch runs no check, and a second update of
//   the branch waits while a check holds its lock.
// - Where the core.hooksPath folder has a reference-transaction hook, the cases run through it, with
//   reference-transaction.sh in the repository's .claude/hooks/. A call from another folder then
//   runs no hook, and a reference-transaction.sh that does not parse or is missing lets the update
//   through with a warning.
//
// It warns, without failing, when install-git-hooks.ps1 -Check finds gaps in this repository's
// hooks or cannot check them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

let failures = 0;
const ok = label => console.log(`OK   ${label}`);
const fail = label => {
  console.log(`FAIL ${label}`);
  failures++;
};
const expect = (condition, label, detail = '') => condition ? ok(label) : fail(`${label}${detail ? ` (${detail})` : ''}`);

const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@localhost', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[name];

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}
function mustGit(cwd, ...args) {
  const result = git(cwd, ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}
const commit = (repo, name) => {
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  mustGit(repo, 'add', `${name}.txt`);
  mustGit(repo, 'commit', '-q', '-m', name);
  return mustGit(repo, 'rev-parse', 'HEAD');
};
const guardRefs = repo => mustGit(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/guard/')
  .split('\n').filter(Boolean).map(line => line.split(' '));
const clearGuard = repo => {
  const refs = guardRefs(repo);
  if (refs.length > 0) spawnSync('git', ['-C', repo, 'update-ref', '--stdin'], { env, input: refs.map(([ref]) => `delete ${ref}\n`).join('') });
};
const markShared = dir => fs.writeFileSync(path.join(mustGit(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'worktrees'), 'shared\n');

// The reference-transaction cases, in a repository of their own. With `hooksPath`, the repository
// takes this repository's hooks folder, whose reference-transaction hook runs reference-transaction.sh
// from the repository's .claude/hooks/. Otherwise reference-transaction.sh is the hook itself. Each
// case writes its stand-in checks, untracked, where the hook runs them.
function transactionCases(root, hooksPath) {
  const repo = path.join(root, 'transactions');
  mustGit(root, 'init', '-q', '-b', 'master', repo);
  const hookText = fs.readFileSync(path.join(__dirname, 'reference-transaction.sh'), 'utf8').replace(/\r\n/g, '\n');
  const sharedHook = path.join(repo, '.claude', 'hooks', 'reference-transaction.sh');
  if (hooksPath) {
    fs.cpSync(path.join(repoRoot, hooksPath), path.join(repo, hooksPath), { recursive: true });
    mustGit(repo, 'config', 'core.hooksPath', hooksPath);
    fs.mkdirSync(path.dirname(sharedHook), { recursive: true });
    fs.writeFileSync(sharedHook, hookText);
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `/${hooksPath}/\n`);
  } else {
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'reference-transaction'), hookText, { mode: 0o755 });
  }
  mustGit(repo, 'config', 'core.filesRefLockTimeout', '30000');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.claude/\n');

  const v = text => `${text}\n`;
  const put = (dir, files) => {
    for (const [file, text] of Object.entries(files)) {
      const full = path.join(dir, file);
      if (text === null) fs.rmSync(full, { force: true });
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
      }
    }
  };
  const checkDir = path.join(repo, '.claude', 'hooks', 'reference-transaction');
  // Replaces the checks with `checks`, a map of file name to text; null leaves no folder.
  const setChecks = checks => {
    fs.rmSync(checkDir, { recursive: true, force: true });
    if (checks === null) return;
    fs.mkdirSync(checkDir, { recursive: true });
    for (const [name, text] of Object.entries(checks)) fs.writeFileSync(path.join(checkDir, name), text);
  };
  const gitDir = path.join(repo, '.git');
  const errorLog = path.join(gitDir, 'hook-errors.log');
  const tip = (dir = repo) => git(dir, 'rev-parse', '-q', '--verify', 'HEAD').stdout;
  let count = 0;

  // Commits through `git commit`, run from `cwd` inside the repository, and on a refusal puts the
  // working tree back to HEAD.
  const commitFiles = (files, cwd = repo) => {
    put(repo, files);
    mustGit(repo, 'add', '-A', '--', ...Object.keys(files));
    const before = tip();
    const attempt = git(cwd, 'commit', '-q', '-m', `change ${++count}`);
    const landed = attempt.status === 0 && tip() !== before;
    if (!landed) mustGit(repo, 'reset', '-q', '--hard', 'HEAD');
    return { landed, said: attempt.stderr };
  };
  // Builds a commit in a private index, as the commit-safety recipe does, without moving master.
  const build = (parent, files) => {
    const index = path.join(root, 'private.index');
    const run = (args, input) => {
      const attempt = spawnSync('git', ['-C', repo, ...args], { env: { ...env, GIT_INDEX_FILE: index }, input, encoding: 'utf8' });
      if (attempt.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${attempt.stderr}`);
      return attempt.stdout.trim();
    };
    fs.rmSync(index, { force: true });
    run(['read-tree', parent]);
    for (const [file, text] of Object.entries(files)) {
      if (text === null) run(['update-index', '--force-remove', '--', file]);
      else run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${file}`]);
    }
    return run(['commit-tree', run(['write-tree']), '-p', parent, '-m', `built ${++count}`]);
  };
  const refuse = name => `cat >/dev/null\necho "${name} refused" >&2\nexit 1\n`;
  const noteRun = name => `cat >/dev/null\ntouch .git/${name}-ran\nexit 0\n`;
  const ran = name => {
    const file = path.join(gitDir, `${name}-ran`);
    const was = fs.existsSync(file);
    fs.rmSync(file, { force: true });
    return was;
  };

  setChecks(null);
  let result = commitFiles({ 'notes.txt': v('n1') });
  expect(result.landed && result.said === '', 'without a checks folder, master moves silently', result.said);
  setChecks({});
  result = commitFiles({ 'notes.txt': v('n2') });
  expect(result.landed && result.said === '', 'with an empty checks folder, master moves silently', result.said);

  setChecks({ 'probe.sh': 'printf "%s\\n" "$@" > .git/check-args\ncat > .git/check-input\nexit 0\n' });
  const parent = tip();
  result = commitFiles({ 'notes.txt': v('n3') });
  const input = fs.readFileSync(path.join(gitDir, 'check-input'), 'utf8');
  expect(result.landed && fs.readFileSync(path.join(gitDir, 'check-args'), 'utf8') === 'prepared\n' &&
    input === `${parent} ${tip()} refs/heads/master\n`,
  'a check gets "prepared" as its argument and the shared branch\'s update line alone on stdin', `${result.said} ${input}`);

  setChecks({ 'probe.sh': refuse('probe') });
  const before = tip();
  result = commitFiles({ 'notes.txt': v('n4') });
  expect(!result.landed && tip() === before && /probe refused/.test(result.said), 'a check that exits 1 refuses a commit, and its message reaches the caller', result.said);
  const refusedUpdate = git(repo, 'update-ref', 'refs/heads/master', build(before, { 'notes.txt': v('n5') }), before);
  expect(refusedUpdate.status !== 0 && tip() === before && /probe refused/.test(refusedUpdate.stderr), 'a check that exits 1 refuses an update-ref', refusedUpdate.stderr);
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  result = commitFiles({ 'sub/inner.txt': v('i1') }, path.join(repo, 'sub'));
  expect(!result.landed && /probe refused/.test(result.said), 'a commit made from a subfolder runs the checks too', result.said);
  const side = git(repo, 'update-ref', 'refs/heads/side', before);
  expect(side.status === 0 && git(repo, 'rev-parse', 'side').stdout === before && side.stderr === '', 'an update of another branch runs no check', side.stderr);
  const still = git(repo, 'update-ref', 'refs/heads/master', before, before);
  expect(still.status === 0 && still.stderr === '', 'an update that leaves master where it is runs no check', still.stderr);

  setChecks({ 'a.sh': refuse('check a'), 'b.sh': refuse('check b') });
  result = commitFiles({ 'notes.txt': v('n6') });
  expect(!result.landed && /check a refused/.test(result.said) && /check b refused/.test(result.said), 'every check runs, so two refusals show together', result.said);
  setChecks({ 'a.sh': noteRun('a'), 'b.sh': refuse('check b') });
  result = commitFiles({ 'notes.txt': v('n8') });
  expect(!result.landed && ran('a') && /check b refused/.test(result.said), 'a refusal by the last check refuses', result.said);

  for (const [label, text, code] of [['a check that does not parse', 'cat >/dev/null\nif then (\n', '\\d+'], ['a check that exits 3', 'cat >/dev/null\nexit 3\n', '3']]) {
    fs.rmSync(errorLog, { force: true });
    setChecks({ 'broken.sh': text });
    result = commitFiles({ 'notes.txt': v(`broken ${label}`) });
    const logged = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : '';
    expect(result.landed && new RegExp(`reference-transaction: warning: \\S*reference-transaction/broken\\.sh failed with exit ${code}\\b`).test(result.said) &&
      new RegExp(`exit ${code} from \\S*reference-transaction/broken\\.sh`).test(logged),
    `${label} lets the update through with a warning and a line in hook-errors.log`, `${result.said} ${logged}`);
  }
  fs.rmSync(errorLog, { force: true });
  setChecks({ 'a.sh': 'cat >/dev/null\nexit 3\n', 'b.sh': refuse('check b') });
  result = commitFiles({ 'notes.txt': v('n9') });
  expect(!result.landed && /check b refused/.test(result.said) && /a\.sh failed with exit 3, so it did not check/.test(result.said),
    'a check that fails beside one that refuses warns, and the refusal still refuses', result.said);
  fs.rmSync(errorLog, { force: true });

  // A call from outside the working tree that names the repository: git starts the hook where the
  // call runs, here a folder with checks of its own, so the hook must find the repository's.
  setChecks({ 'probe.sh': refuse('probe') });
  const caller = path.join(root, 'caller');
  fs.mkdirSync(path.join(caller, '.claude', 'hooks', 'reference-transaction'), { recursive: true });
  fs.writeFileSync(path.join(caller, '.claude', 'hooks', 'reference-transaction', 'probe.sh'), 'cat >/dev/null\nexit 0\n');
  // Git looks for a relative core.hooksPath from where the call runs, so there a call from another
  // folder runs no hook.
  const fromOutside = (result, label) => hooksPath
    ? expect(result.status === 0 && !/refused/.test(result.stderr), `${label} runs no hook where core.hooksPath is relative`, result.stderr)
    : expect(result.status !== 0 && /probe refused/.test(result.stderr), `${label} runs the repository's checks, and they find it`, result.stderr);
  const outside = git(caller, `--git-dir=${gitDir}`, `--work-tree=${repo}`, 'update-ref', 'refs/heads/master', build(tip(), { 'notes.txt': v('n10') }), tip());
  fromOutside(outside, 'an update-ref from another folder with --git-dir and --work-tree');
  // The same call by relative paths, from a folder at another depth, and a check that asks git
  // where the repository is, as a real check does.
  setChecks({ 'probe.sh': 'cat >/dev/null\ngit rev-parse --show-toplevel >/dev/null || exit 3\necho "probe refused" >&2\nexit 1\n' });
  const deep = path.join(caller, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const relative = path.relative(deep, repo).split(path.sep).join('/');
  const relativeCall = git(deep, `--git-dir=${relative}/.git`, `--work-tree=${relative}`, 'update-ref', 'refs/heads/master', build(tip(), { 'notes.txt': v('n11') }), tip());
  fromOutside(relativeCall, 'an update-ref that names the repository by relative paths from another folder');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const insideRelative = git(path.join(repo, 'sub'), '--work-tree=..', 'update-ref', 'refs/heads/master', build(tip(), { 'notes.txt': v('n13') }), tip());
  expect(insideRelative.status !== 0 && /probe refused/.test(insideRelative.stderr), 'an update-ref from a subfolder with a relative --work-tree runs the checks', insideRelative.stderr);
  const gitDirOnly = git(deep, `--git-dir=${relative}/.git`, 'update-ref', 'refs/heads/master', build(tip(), { 'notes.txt': v('n12') }), tip());
  fromOutside(gitDirOnly, 'an update-ref that names only the git dir, from another folder,');

  // The hooks folder's own hook runs a live script, which a peer can break or remove.
  if (hooksPath) {
    setChecks({ 'probe.sh': refuse('probe') });
    fs.writeFileSync(sharedHook, 'if then (\n');
    result = commitFiles({ 'notes.txt': v('n14') });
    const logged = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : '';
    expect(result.landed && /reference-transaction: warning: \S*reference-transaction\.sh failed with exit \d+/.test(result.said) && /reference-transaction\.sh/.test(logged),
      'a reference-transaction.sh that does not parse lets the update through with a warning and a line in hook-errors.log', `${result.said} ${logged}`);
    fs.rmSync(errorLog, { force: true });
    fs.rmSync(sharedHook);
    result = commitFiles({ 'notes.txt': v('n15') });
    expect(result.landed && /reference-transaction: warning: \S*reference-transaction\.sh is missing/.test(result.said),
      'a .claude/hooks/ folder without reference-transaction.sh lets the update through with a warning', result.said);
    const away = path.join(repo, '.claude-away');
    fs.renameSync(path.join(repo, '.claude'), away);
    result = commitFiles({ 'notes.txt': v('n16') });
    expect(result.landed && result.said === '', 'without .claude/hooks/, the update goes through silently', result.said);
    fs.renameSync(away, path.join(repo, '.claude'));
    fs.writeFileSync(sharedHook, hookText);
  }

  // A slow check: it marks that the hook holds master's lock, then sleeps, while a second update of
  // master starts.
  setChecks({ 'slow.sh': 'cat >/dev/null\ntouch .git/hook-started\nsleep 3\nexit 0\n' });
  const runner = path.join(root, 'update-ref.js');
  fs.writeFileSync(runner, "const r = require('child_process').spawnSync('git', ['-C', process.argv[3], 'update-ref', 'refs/heads/master', ...process.argv.slice(4)], " +
    "{ encoding: 'utf8' });\nrequire('fs').writeFileSync(process.argv[2], JSON.stringify({ status: r.status, stderr: r.stderr }));\n");
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const waitFor = (file, ms) => {
    for (const end = Date.now() + ms; !fs.existsSync(file) && Date.now() < end;) sleep(50);
    return fs.existsSync(file);
  };
  const concurrent = (firstArgs, secondArgs) => {
    const started = path.join(gitDir, 'hook-started');
    const out = path.join(root, 'first.json');
    fs.rmSync(started, { force: true });
    fs.rmSync(out, { force: true });
    spawn(process.execPath, [runner, out, repo, ...firstArgs], { env, stdio: 'ignore' });
    if (!waitFor(started, 20000)) throw new Error('the first update never reached the hook');
    const second = git(repo, 'update-ref', 'refs/heads/master', ...secondArgs);
    if (!waitFor(out, 30000)) throw new Error('the first update never finished');
    return { first: JSON.parse(fs.readFileSync(out, 'utf8')), second };
  };
  // Git for Windows can fail to read a ref file that another process is moving into place, with
  // "Permission denied". That is no lock failure, so the race runs again from the same tip.
  const raceFrom = (start, firstArgs, secondArgs) => {
    let outcome;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tip() !== start) mustGit(repo, 'update-ref', 'refs/heads/master', start);
      outcome = concurrent(firstArgs, secondArgs);
      if (!/Permission denied/.test(outcome.second.stderr)) break;
    }
    return outcome;
  };
  const base = tip();
  const large = build(base, { 'notes.txt': v('x') });
  let race = raceFrom(base, [large, base], [build(base, { 'notes.txt': v('y') }), base]);
  expect(race.first.status === 0 && race.second.status !== 0 && !/File exists/.test(race.second.stderr) && /expected/.test(race.second.stderr) && tip() === large,
    'a compare-and-swap update-ref that meets a check holding the lock waits, then fails on the moved master', `${race.first.stderr} ${race.second.stderr}`);
  const later = build(large, { 'notes.txt': v('w') });
  race = raceFrom(large, [build(large, { 'notes.txt': v('z') }), large], [later]);
  expect(race.first.status === 0 && race.second.status === 0 && tip() === later,
    'an update-ref without an old value that meets a check holding the lock waits, then lands', `${race.first.stderr} ${race.second.stderr}`);

  // The shared branch under other names: the check gets that branch's line, and a move of another
  // branch runs none.
  const probe = { 'probe.sh': 'cat >> .git/check-input\nexit 0\n' };
  const handed = () => {
    const file = path.join(gitDir, 'check-input');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.rmSync(file, { force: true });
    return text;
  };
  handed();
  const head = () => git(repo, 'symbolic-ref', '-q', '--short', 'HEAD').stdout;
  for (const name of ['main', 'trunk', 'direction/x']) {
    setChecks(null);
    mustGit(repo, 'branch', '-m', name);
    mustGit(repo, 'branch', '-f', 'master', 'HEAD~1');
    setChecks(probe);
    const from = mustGit(repo, 'rev-parse', name);
    result = commitFiles({ 'notes.txt': v(`on ${name}`) });
    expect(result.landed && handed() === `${from} ${mustGit(repo, 'rev-parse', name)} refs/heads/${name}\n`, `on ${name}, a commit hands the check ${name}'s line alone`, result.said);
    const other = git(repo, 'update-ref', 'refs/heads/master', from);
    expect(other.status === 0 && handed() === '', `on ${name}, a move of master runs no check`, other.stderr);
    setChecks(null);
    mustGit(repo, 'branch', '-D', 'master');
  }
  setChecks(null);
  mustGit(repo, 'branch', '-m', 'main');

  // Detached with no rebase, every local branch counts.
  mustGit(repo, 'branch', 'loose', 'main');
  mustGit(repo, 'checkout', '-q', '--detach', 'main');
  setChecks({ 'probe.sh': refuse('probe') });
  const looseTip = mustGit(repo, 'rev-parse', 'loose');
  const detachedMove = git(repo, 'update-ref', 'refs/heads/loose', build(looseTip, { 'notes.txt': v('loose') }), looseTip);
  expect(detachedMove.status !== 0 && /probe refused/.test(detachedMove.stderr), 'with HEAD detached and no rebase, a move of any branch runs the checks', detachedMove.stderr);
  const headMove = git(repo, 'update-ref', '--no-deref', 'HEAD', build(looseTip, { 'notes.txt': v('head') }));
  expect(headMove.status === 0, 'with HEAD detached, a move of HEAD alone runs no check', headMove.stderr);
  setChecks(null);
  mustGit(repo, 'switch', '-q', 'main');
  mustGit(repo, 'branch', '-D', 'loose');

  // A rebase of main onto main~1 with `files` added: its end moves main while HEAD is detached. A
  // rebase that does not end is aborted. The abort moves main back with no old value, so a check
  // that refuses every update must step aside for it.
  const rebaseOnto = (files, ...options) => {
    mustGit(repo, 'update-ref', 'refs/heads/upstream', build(mustGit(repo, 'rev-parse', 'main~1'), files));
    const attempt = git(repo, 'rebase', '-q', ...options, 'upstream');
    const ended = attempt.status === 0 && head() === 'main';
    if (!ended && git(repo, 'rebase', '--abort').status !== 0) {
      setChecks(null);
      mustGit(repo, 'rebase', '--abort');
    }
    return { ended, said: attempt.stderr };
  };
  mustGit(repo, 'reset', '-q', '--hard', 'main~1');
  commitFiles({ 'local.txt': v('local') });
  const local = mustGit(repo, 'rev-parse', 'main');
  setChecks(probe);
  result = rebaseOnto({ 'upstream.txt': v('upstream') });
  const lines = handed().split('\n').filter(Boolean);
  expect(result.ended && lines.length === 1 && lines[0] === `${local} ${mustGit(repo, 'rev-parse', 'main')} refs/heads/main`,
    'a rebase that ends hands the check main\'s line alone', `${result.said} ${lines.join(' | ')}`);
  setChecks({ 'probe.sh': refuse('probe') });
  const rebased = mustGit(repo, 'rev-parse', 'main');
  result = rebaseOnto({ 'more.txt': v('more') }, '--exec', 'git branch -f aside HEAD');
  expect(!result.ended && /probe refused/.test(result.said) && mustGit(repo, 'rev-parse', 'main') === rebased,
    'a check that refuses the end of a rebase leaves main where it was', result.said);
  expect(git(repo, 'rev-parse', '-q', '--verify', 'aside').status === 0,
    'while a rebase of main runs, a move of another branch runs no check', result.said);
  setChecks(null);
}

const hooksPath = git(repoRoot, 'config', '--get', 'core.hooksPath').stdout;
const hasPwsh = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { env }).error;
const hasTransactionHook = fs.existsSync(path.join(__dirname, 'reference-transaction.sh'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hooks-'));
try {
  const remote = path.join(root, 'remote.git');
  const shared = path.join(root, 'shared');
  const clone = path.join(root, 'clone');
  mustGit(root, 'init', '-q', '--bare', '-b', 'master', remote);
  mustGit(remote, 'config', 'receive.denyDeleteCurrent', 'ignore');
  mustGit(root, 'init', '-q', '-b', 'master', shared);
  const first = commit(shared, 'first');
  mustGit(shared, 'remote', 'add', 'origin', remote);
  mustGit(shared, 'push', '-q', 'origin', 'master');
  mustGit(root, 'clone', '-q', remote, clone);
  markShared(shared);

  // The save script and what it loads, at the path the hooks run it from.
  const saveDir = path.join(shared, '.claude', 'hooks');
  fs.mkdirSync(saveDir, { recursive: true });
  const copyHookFiles = names => names.forEach(name => fs.copyFileSync(path.join(__dirname, name), path.join(saveDir, name)));
  copyHookFiles(['pre-push-save.js', 'git-save.js', 'git-head.js']);

  if (hooksPath) {
    const target = path.join(shared, hooksPath);
    fs.cpSync(path.join(repoRoot, hooksPath), target, { recursive: true });
    // The folder's reference-transaction hook warns on every ref update where .claude/hooks/ lacks the script it runs.
    if (hasTransactionHook) copyHookFiles(['reference-transaction.sh']);
    mustGit(shared, 'config', 'core.hooksPath', hooksPath);
    ok(`the hooks come from ${hooksPath}`);
  } else {
    copyHookFiles(['pre-push.sh', 'install-git-hooks.ps1', ...(hasTransactionHook ? ['reference-transaction.sh'] : [])]);
    const installer = path.join(saveDir, 'install-git-hooks.ps1');
    const hookFile = path.join(shared, '.git', 'hooks', 'pre-push');
    const transactionFile = path.join(shared, '.git', 'hooks', 'reference-transaction');
    const runInstaller = (...args) => {
      const run = spawnSync('pwsh', ['-NoProfile', '-File', installer, ...args], { env, encoding: 'utf8' });
      return { status: run.status, said: (run.stdout || '').trim() };
    };
    if (!hasPwsh) {
      fs.copyFileSync(path.join(saveDir, 'pre-push.sh'), hookFile);
      fs.chmodSync(hookFile, 0o755);
      ok('PowerShell is missing, so pre-push.sh is copied in place');
    } else {
      let run = runInstaller();
      expect(run.status === 0 && fs.existsSync(hookFile), 'the installer installs pre-push.sh', run.said);
      expect(!fs.existsSync(transactionFile), 'the installer installs no reference-transaction hook while it has no check to run', run.said);
      expect(git(shared, 'config', '--get', 'core.filesRefLockTimeout').stdout === '30000', 'the installer makes git wait 30 s for a locked ref');
      run = runInstaller('-Check');
      expect(run.status === 0 && /^EXIT: 0 /m.test(run.said), 'the installer\'s -Check exits 0 on current hooks', run.said);
      run = runInstaller();
      expect(run.status === 0, 'the installer replaces its own hook', run.said);
      run = runInstaller('-Remove');
      expect(run.status === 0 && !fs.existsSync(hookFile), 'the installer removes its own hook', run.said);
      fs.writeFileSync(hookFile, '#!/bin/sh\n# guard pre-push: installed by .claude/hooks/install-pre-push.ps1\nexit 0\n');
      run = runInstaller();
      expect(run.status === 0 && fs.readFileSync(hookFile, 'utf8').includes('pre-push-save.js'), 'the installer replaces the pre-push hook its earlier name wrote', run.said);
      fs.writeFileSync(hookFile, '#!/bin/sh\nexit 0\n');
      run = runInstaller();
      expect(run.status === 1 && fs.readFileSync(hookFile, 'utf8') === '#!/bin/sh\nexit 0\n', 'the installer leaves another pre-push hook alone', run.said);
      fs.rmSync(hookFile);
      const notRepo = path.join(root, 'not-a-repo');
      fs.mkdirSync(notRepo);
      run = runInstaller('-Check', '-RepoRoot', notRepo);
      expect(run.status === 3 && /^EXIT: 3 /m.test(run.said), 'the installer\'s -Check exits 3 where it cannot read a repository', run.said);

      if (hasTransactionHook) {
        const checks = path.join(saveDir, 'reference-transaction');
        fs.mkdirSync(checks);
        fs.writeFileSync(path.join(checks, 'probe.sh'), 'cat >/dev/null\nexit 0\n');
        runInstaller();
        const wanted = fs.readFileSync(path.join(saveDir, 'reference-transaction.sh'), 'utf8').replace(/\r\n/g, '\n');
        fs.rmSync(transactionFile);
        run = runInstaller('-Check');
        expect(run.status === 2 && /^MISSING: reference-transaction: /m.test(run.said) && !/^(MISSING|STALE|UNWANTED): pre-push/m.test(run.said) && !fs.existsSync(transactionFile),
          'the installer\'s -Check reports a missing hook, exits 2 and installs nothing', run.said);
        run = runInstaller();
        expect(run.status === 0 && fs.existsSync(transactionFile) && fs.readFileSync(transactionFile, 'utf8') === wanted && fs.existsSync(hookFile),
          'the installer installs both hooks while reference-transaction/ holds a check', run.said);
        expect(runInstaller('-Check').status === 0, 'the installer\'s -Check exits 0 once both hooks are current');
        fs.appendFileSync(hookFile, '# edited\n');
        run = runInstaller('-Check');
        expect(run.status === 2 && /^STALE: pre-push: /m.test(run.said) && fs.readFileSync(hookFile, 'utf8').endsWith('# edited\n'),
          'the installer\'s -Check reports a hook of its own that differs from its script, and leaves it', run.said);
        runInstaller();
        fs.rmSync(path.join(checks, 'probe.sh'));
        run = runInstaller('-Check');
        expect(run.status === 2 && /^UNWANTED: reference-transaction: /m.test(run.said) && fs.existsSync(transactionFile),
          'the installer\'s -Check reports a hook that has no check left to run, and leaves it', run.said);
        run = runInstaller();
        expect(run.status === 0 && !fs.existsSync(transactionFile) && fs.existsSync(hookFile), 'the installer removes its reference-transaction hook once the last check is gone', run.said);
        const other = '#!/bin/sh\nexit 0\n';
        fs.writeFileSync(transactionFile, other);
        run = runInstaller();
        expect(run.status === 0 && fs.readFileSync(transactionFile, 'utf8') === other && /another hook/.test(run.said),
          'the installer leaves another reference-transaction hook alone while it has no check to run', run.said);
        expect(runInstaller('-Check').status === 0, 'the installer\'s -Check ignores another reference-transaction hook while it has no check to run');
        fs.writeFileSync(path.join(checks, 'probe.sh'), 'cat >/dev/null\nexit 0\n');
        run = runInstaller();
        expect(run.status === 1 && fs.readFileSync(transactionFile, 'utf8') === other, 'the installer refuses to replace another reference-transaction hook', run.said);
        run = runInstaller('-Check');
        expect(run.status === 2 && /^FOREIGN: reference-transaction: /m.test(run.said), 'the installer\'s -Check reports another hook where it would install its own', run.said);
        fs.rmSync(transactionFile);

        // A hooks path of the repository's own: -Check reports only what is missing there.
        const ownHooks = path.join(shared, 'own-hooks');
        fs.mkdirSync(ownHooks);
        fs.writeFileSync(path.join(ownHooks, 'pre-push'), '#!/bin/sh\n# guard pre-push: an older copy\nexit 0\n');
        mustGit(shared, 'config', 'core.hooksPath', 'own-hooks');
        run = runInstaller('-Check');
        expect(run.status === 2 && /^MISSING: reference-transaction: /m.test(run.said) && !/pre-push/.test(run.said.split('\n').filter(line => !line.startsWith('EXIT:')).join('\n')),
          'the installer\'s -Check reports only missing hooks where core.hooksPath is set', run.said);
        run = runInstaller();
        expect(run.status === 1, 'the installer changes nothing where core.hooksPath is set', run.said);
        mustGit(shared, 'config', '--unset', 'core.hooksPath');
        fs.rmSync(ownHooks, { recursive: true });
        fs.rmSync(checks, { recursive: true });
      }
      run = runInstaller();
      expect(run.status === 0 && fs.existsSync(hookFile) && !fs.existsSync(transactionFile), 'the installer installs pre-push alone again', run.said);
    }
  }

  // Pushes and reports whether it went through, the guard refs it left, and what the hooks said.
  const push = (repo, ...args) => {
    clearGuard(repo);
    const result = git(repo, 'push', ...args);
    return { pushed: result.status === 0, refs: guardRefs(repo), said: result.stderr };
  };
  const savedOnly = (result, sha) => result.pushed && result.refs.length === 1 && /\/remote-master$/.test(result.refs[0][0]) &&
    result.refs[0][1] === sha && result.said.includes('saved');
  const nothingSaved = result => result.pushed && result.refs.length === 0;

  const second = commit(shared, 'second');
  expect(nothingSaved(push(shared, '-q', 'origin', 'master')), 'a fast-forward of the shared master saves nothing');

  mustGit(shared, 'reset', '-q', '--hard', first);
  const rewritten = commit(shared, 'rewritten');
  let result = push(shared, '-q', '-f', 'origin', 'master');
  expect(savedOnly(result, second), 'a force push saves the remote master it rewrites', result.said);

  mustGit(clone, 'fetch', '-q', 'origin');
  mustGit(clone, 'reset', '-q', '--hard', 'origin/master');
  const fromClone = commit(clone, 'from-clone');
  mustGit(clone, 'push', '-q', 'origin', 'master');
  expect(git(shared, 'cat-file', '-e', fromClone).status !== 0, 'the shared repository lacks the tip the clone pushed');
  commit(shared, 'behind');
  result = push(shared, '-q', '-f', 'origin', 'master');
  expect(savedOnly(result, fromClone), 'a force push over a tip the repository lacks fetches it and saves it', result.said);

  const beforeDelete = mustGit(shared, 'rev-parse', 'master');
  result = push(shared, '-q', 'origin', ':master');
  expect(savedOnly(result, beforeDelete), 'deleting the remote master saves its tip', result.said);
  mustGit(shared, 'push', '-q', 'origin', 'master');

  mustGit(shared, 'push', '-q', 'origin', 'master:feature');
  mustGit(shared, 'reset', '-q', '--hard', first);
  commit(shared, 'feature-rewrite');
  result = push(shared, '-q', '-f', 'origin', 'master:feature');
  expect(nothingSaved(result), 'a force push of another branch saves nothing', result.said);
  mustGit(shared, 'reset', '-q', '--hard', beforeDelete);

  const other = path.join(root, 'other.git');
  mustGit(root, 'init', '-q', '--bare', '-b', 'master', other);
  mustGit(shared, 'push', '-q', other, 'master');
  mustGit(shared, 'reset', '-q', '--hard', first);
  commit(shared, 'other-rewrite');
  expect(nothingSaved(push(shared, '-q', '-f', other, 'master')), 'a force push to a remote nobody shares saves nothing');

  const sharedBare = path.join(root, 'shared-bare.git');
  mustGit(root, 'init', '-q', '--bare', '-b', 'master', sharedBare);
  mustGit(shared, 'push', '-q', sharedBare, 'master');
  const sharedBareTip = mustGit(shared, 'rev-parse', 'master');
  markShared(sharedBare);
  mustGit(shared, 'reset', '-q', '--hard', first);
  commit(shared, 'bare-rewrite');
  result = push(shared, '-q', '-f', sharedBare, 'master');
  expect(savedOnly(result, sharedBareTip), 'a force push to a local shared repository saves its master', result.said);
  mustGit(shared, 'reset', '-q', '--hard', beforeDelete);

  // The branch the save keeps is the one the repository works on, whatever its name. The remote's
  // master is then another branch.
  const savedAs = (result, name, sha) => result.pushed && result.refs.length === 1 &&
    result.refs[0][0].endsWith(`/remote-${name}`) && result.refs[0][1] === sha && result.said.includes(`+${result.refs[0][0]}:refs/heads/${name}`);
  for (const name of ['main', 'direction/x']) {
    mustGit(shared, 'branch', '-m', name);
    mustGit(shared, 'push', '-q', 'origin', `${name}:${name}`);
    const before = mustGit(shared, 'rev-parse', name);
    mustGit(shared, 'reset', '-q', '--hard', first);
    commit(shared, `rewrite-${name.replace('/', '-')}`);
    result = push(shared, '-q', '-f', 'origin', name);
    expect(savedAs(result, name, before), `on ${name}, a force push saves the remote ${name}`, result.said);
    result = push(shared, '-q', '-f', 'origin', `${name}:master`);
    expect(nothingSaved(result), `on ${name}, a force push of the remote master saves nothing`, result.said);
    mustGit(shared, 'reset', '-q', '--hard', beforeDelete);
    mustGit(shared, 'push', '-q', '-f', 'origin', `${name}:master`);
    mustGit(shared, 'branch', '-m', 'master');
  }
  // Detached, it keeps the branch HEAD left, and with no branch to name, every branch.
  mustGit(shared, 'checkout', '-q', '--detach');
  const masterTip = mustGit(shared, 'rev-parse', 'master');
  result = push(shared, '-q', '-f', 'origin', `${first}:master`);
  expect(savedAs(result, 'master', masterTip), 'with HEAD detached, a force push saves the remote branch HEAD left', result.said);
  mustGit(shared, 'push', '-q', '-f', 'origin', `${masterTip}:master`);
  const logs = path.join(mustGit(shared, 'rev-parse', '--path-format=absolute', '--git-dir'), 'logs', 'HEAD');
  const log = fs.readFileSync(logs);
  fs.writeFileSync(logs, '');
  result = push(shared, '-q', '-f', 'origin', `${first}:feature`);
  expect(result.pushed && result.refs.length === 1 && result.refs[0][0].endsWith('/remote-feature'),
    'with HEAD detached and no branch in its reflog, a force push of any branch saves it', result.said);
  fs.writeFileSync(logs, log);
  mustGit(shared, 'switch', '-q', 'master');

  if (!hooksPath) fs.copyFileSync(path.join(shared, '.git', 'hooks', 'pre-push'), path.join(clone, '.git', 'hooks', 'pre-push'));
  else mustGit(clone, 'config', 'core.hooksPath', path.join(shared, hooksPath));
  fs.cpSync(path.join(shared, '.claude'), path.join(clone, '.claude'), { recursive: true });
  const cloneTip = mustGit(clone, 'rev-parse', 'HEAD');
  mustGit(clone, 'reset', '-q', '--hard', first);
  commit(clone, 'clone-rewrite');
  expect(nothingSaved(push(clone, '-q', '-f', 'origin', 'master')), 'a repository without the marker saves nothing');
  mustGit(clone, 'reset', '-q', '--hard', cloneTip);

  const saveScript = path.join(saveDir, 'pre-push-save.js');
  const script = fs.readFileSync(saveScript);
  for (const [index, [label, broken]] of Object.entries([['a save script that does not parse', 'this is not JavaScript('], ['a save script whose module is missing', null]])) {
    if (broken === null) fs.renameSync(path.join(saveDir, 'git-save.js'), path.join(saveDir, 'git-save.js.away'));
    else fs.writeFileSync(saveScript, broken);
    mustGit(shared, 'reset', '-q', '--hard', first);
    commit(shared, `broken-${index}`);
    result = push(shared, '-q', '-f', 'origin', 'master');
    expect(result.pushed && result.refs.length === 0 && /unsaved/.test(result.said), `${label} lets the push go ahead with a warning`, result.said);
    if (broken === null) fs.renameSync(path.join(saveDir, 'git-save.js.away'), path.join(saveDir, 'git-save.js'));
    else fs.writeFileSync(saveScript, script);
  }

  if (!hasTransactionHook) console.log('SKIP the reference-transaction cases: reference-transaction.sh is not beside this file.');
  else transactionCases(root, hooksPath && fs.existsSync(path.join(repoRoot, hooksPath, 'reference-transaction')) ? hooksPath : '');
} catch (error) {
  fail(`the fixture failed: ${error.message}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const installerHere = path.join(__dirname, 'install-git-hooks.ps1');
if (!fs.existsSync(installerHere)) console.log('SKIP the check of this repository\'s hooks: install-git-hooks.ps1 is not beside this file.');
else if (!hasPwsh) console.log('SKIP the check of this repository\'s hooks: PowerShell 7 (pwsh) does not start.');
else if (git(repoRoot, 'rev-parse', '--git-dir').status !== 0) console.log(`SKIP the check of this repository's hooks: ${repoRoot} is not a git repository.`);
else {
  const check = spawnSync('pwsh', ['-NoProfile', '-File', installerHere, '-Check', '-RepoRoot', repoRoot], { env, encoding: 'utf8' });
  if (check.status !== 0) {
    console.log(check.status === 2
      ? 'WARN install-git-hooks.ps1 -Check finds this repository\'s git hooks out of date:'
      : `WARN install-git-hooks.ps1 -Check could not check this repository's git hooks (exit ${check.status}):`);
    for (const line of `${check.stdout || ''}${check.stderr || ''}`.trim().split(/\r?\n/)) console.log(`  ${line}`);
  }
}

if (failures > 0) {
  console.log(`FAIL: ${failures} git hook checks failed.`);
  process.exit(1);
}
console.log('PASS: git hook checks succeeded.');
