// Saves what a git command can remove from a shared repository before it runs, under
// `refs/guard/<time>-<pid>/`, so whoever owned it can take it back:
// - `tree`: a commit laid out as git's stash is. Its tree holds the working content of the paths the
//   command names (the whole tree for a whole-tree form, untracked files too when the command deletes
//   them), and its second parent holds the index as it was, so a staged blob survives beside a
//   different working file.
// - `index`: the index alone, as a commit.
// - `branch/<name>`, `remote/<name>` and `stash/<n>`: the local branches, remote-tracking branches
//   and stash entries a command deletes or moves. `all` in `save.branches`
//   saves every branch but the checked-out one, which no delete can remove, and `all:remotes` every
//   remote-tracking branch. `all` in `save.stash` saves every stash entry.
// - `<name>` for each of `save.tips`: a commit the caller names, such as a remote branch's tip before
//   a push rewrites it (pre-push-save.js).
//
// It never takes the shared index's lock: it copies the index to a temp file and works on the copy.
// Ignored files are not saved. Each save deletes guard refs older than KEEP_DAYS.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const KEEP_DAYS = 30;

// The commits it writes name the hook as their author, so a save needs no git identity.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'block-destructive-git', GIT_AUTHOR_EMAIL: 'block-destructive-git@localhost',
  GIT_COMMITTER_NAME: 'block-destructive-git', GIT_COMMITTER_EMAIL: 'block-destructive-git@localhost'
};

class SaveFailed extends Error {}

// Runs git and resolves with its output. Past `deadline` it ends git and everything git started,
// because the host's kill of a timed-out hook does not reach them, and fails the save.
function runGit(args, { cwd, env, input, deadline }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, Math.max(0, deadline - Date.now()));
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', error => {
      clearTimeout(timer);
      reject(new SaveFailed(`git could not start: ${error.message}`));
    });
    child.on('close', status => {
      clearTimeout(timer);
      if (late) reject(new SaveFailed('it ran past its deadline'));
      else resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// A guard ref name's time part: UTC, to the second.
const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// Saves `save` (see block-destructive-git.js) in the repository at `top` whose git directory is
// `gitDir`, running relative pathspecs from `dir`. Resolves with the refs it wrote.
async function saveBefore({ top, gitDir, dir }, save, deadline, now = new Date()) {
  const env = { ...process.env, ...IDENTITY };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[name];
  const git = async (args, options = {}) => {
    const result = await runGit(['-C', options.cwd || top, ...args], { env: options.env || env, input: options.input, deadline });
    if (result.status !== 0 && !options.mayFail) throw new SaveFailed(`git ${args[0]} failed: ${result.stderr.split('\n')[0]}`);
    return result;
  };
  const base = `refs/guard/${stamp(now)}-${process.pid}`;
  const refs = [];
  const head = (await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { mayFail: true })).stdout || null;
  const parents = head ? ['-p', head] : [];

  if (save.tree || save.index) {
    const copy = path.join(os.tmpdir(), `guard-index-${process.pid}-${now.getTime()}`);
    try {
      const shared = path.join(gitDir, 'index');
      if (fs.existsSync(shared)) fs.writeFileSync(copy, fs.readFileSync(shared));
      const copyEnv = { ...env, GIT_INDEX_FILE: copy };
      const indexTree = (await git(['write-tree'], { env: copyEnv })).stdout;
      const indexCommit = (await git(['commit-tree', indexTree, ...parents, '-m', 'block-destructive-git: the index'], { env: copyEnv })).stdout;
      if (save.tree) {
        const add = ['add', save.tree === 'all' ? '-A' : '-u'];
        const named = save.pathspecFile ? [`--pathspec-from-file=${save.pathspecFile}`] : save.paths ? ['--', ...save.paths] : [];
        const added = await git([...add, ...named], { env: copyEnv, cwd: dir || top, mayFail: true });
        if (added.status !== 0) await git(add, { env: copyEnv });
        const tree = (await git(['write-tree'], { env: copyEnv })).stdout;
        const commit = (await git(['commit-tree', tree, ...parents, '-p', indexCommit, '-m', 'block-destructive-git: the work tree'], { env: copyEnv })).stdout;
        refs.push({ ref: `${base}/tree`, sha: commit });
      } else {
        refs.push({ ref: `${base}/index`, sha: indexCommit });
      }
    } finally {
      fs.rmSync(copy, { force: true });
    }
  }

  const listed = async prefix => (await git(['for-each-ref', '--format=%(refname)', prefix], { mayFail: true })).stdout.split('\n').filter(Boolean);
  const checkedOut = (await git(['symbolic-ref', '-q', 'HEAD'], { mayFail: true })).stdout;
  const branches = [];
  for (const branch of save.branches || []) {
    if (branch === 'all') branches.push(...(await listed('refs/heads/')).filter(ref => ref !== checkedOut));
    else if (branch === 'all:remotes') branches.push(...await listed('refs/remotes/'));
    else branches.push(branch);
  }
  for (const branch of branches) {
    const tip = (await git(['rev-parse', '-q', '--verify', `${branch}^{commit}`], { mayFail: true })).stdout;
    const remote = /^refs\/remotes\//.test(branch);
    if (tip) refs.push({ ref: `${base}/${remote ? 'remote' : 'branch'}/${branch.replace(/^refs\/(?:heads|remotes)\//, '')}`, sha: tip });
  }

  for (const entry of save.stash || []) {
    if (entry === 'all') {
      const list = (await git(['log', '-g', '--format=%H', 'refs/stash'], { mayFail: true })).stdout;
      list.split('\n').filter(Boolean).forEach((sha, index) => refs.push({ ref: `${base}/stash/${index}`, sha }));
      continue;
    }
    const spelled = /^\d+$/.test(entry) ? `stash@{${entry}}` : entry;
    const sha = (await git(['rev-parse', '-q', '--verify', spelled], { mayFail: true })).stdout;
    const number = (/\{(\d+)\}$/.exec(spelled) || [null, '0'])[1];
    if (sha) refs.push({ ref: `${base}/stash/${number}`, sha });
  }

  for (const { name, sha } of save.tips || []) refs.push({ ref: `${base}/${name}`, sha });

  if (refs.length > 0) {
    await git(['update-ref', '--stdin'], { input: refs.map(({ ref, sha }) => `create ${ref} ${sha}\n`).join('') });
  }
  await prune(git, now);
  return refs;
}

// Deletes the guard refs written more than KEEP_DAYS before `now`.
async function prune(git, now) {
  const cutoff = stamp(new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000));
  const listed = (await git(['for-each-ref', '--format=%(refname)', 'refs/guard/'], { mayFail: true })).stdout;
  const old = listed.split('\n').filter(ref => {
    const match = /^refs\/guard\/(\d{8}T\d{6}Z)-/.exec(ref);
    return match && match[1] < cutoff;
  });
  if (old.length > 0) await git(['update-ref', '--stdin'], { input: old.map(ref => `delete ${ref}\n`).join(''), mayFail: true });
}

module.exports = { saveBefore, runGit, SaveFailed, KEEP_DAYS };
