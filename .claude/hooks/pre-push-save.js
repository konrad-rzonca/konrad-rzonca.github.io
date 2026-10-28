// Runs from the pre-push git hook with git's arguments (the remote's name and URL) and its ref lines
// on stdin. Before a push rewrites or deletes the shared branch (git-head.js) on a shared remote, it
// saves the remote's tip under `refs/guard/<time>-<pid>/remote-<branch>` (git-save.js), fetching the
// tip first when this repository lacks it, and lets the push go ahead. With no shared branch, it
// does so for every branch.
//
// It judges only in a shared repository (git-place.js). A remote is shared when it is this
// repository's `origin`, by name or URL, or a local repository that is itself shared.
//
// It never stops a push: when it fails, it says so and exits 0.

const fs = require('fs');
const path = require('path');
const { runGit, saveBefore, KEEP_DAYS } = require('./git-save');
const { readHead } = require('./git-head');

const DEADLINE_MS = 60000;
const HEADS = 'refs/heads/';
const isZero = sha => /^0+$/.test(sha);

const say = text => process.stderr.write(`pre-push: ${text}\n`);
const giveUp = why => {
  say(`could not save the remote's shared branch before this push (${why}), so the push goes ahead unsaved.`);
  process.exit(0);
};
process.on('uncaughtException', error => giveUp(error.message));

const isFile = file => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const env = { ...process.env };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[name];

async function main() {
  const [remote, url] = process.argv.slice(2);
  const lines = fs.readFileSync(0, 'utf8').split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(words => words.length === 4);
  const deadline = Date.now() + DEADLINE_MS;
  const git = (args, cwd) => runGit(['-C', cwd, ...args], { env, deadline });

  const top = (await git(['rev-parse', '--show-toplevel'], process.cwd())).stdout;
  const shared = async dir => {
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
    return common.status === 0 && isFile(path.join(common.stdout, 'worktrees'));
  };
  if (!top || !(await shared(top))) return;

  const origin = (await git(['config', '--get-regexp', '^remote\\.origin\\.(push)?url$'], top)).stdout
    .split('\n').map(line => line.replace(/^\S+\s+/, '')).filter(Boolean);
  const local = (url || '').replace(/^file:\/\//, '').replace(/^\/([A-Za-z])\//, '$1:/');
  const sharedRemote = remote === 'origin' || origin.includes(url) ||
    (fs.existsSync(local) && fs.statSync(local).isDirectory() && await shared(local));
  if (!sharedRemote) return;

  const gitDir = (await git(['rev-parse', '--path-format=absolute', '--git-dir'], top)).stdout;
  const branches = (await git(['for-each-ref', '--format=%(refname)', HEADS], top)).stdout.split('\n');
  const branch = readHead(gitDir, name => branches.includes(HEADS + name)).shared;
  const guarded = ref => branch ? ref === HEADS + branch : ref.startsWith(HEADS);

  const has = async sha => (await git(['cat-file', '-e', `${sha}^{commit}`], top)).status === 0;
  const tips = [];
  for (const [, localSha, remoteRef, remoteSha] of lines) {
    if (!guarded(remoteRef) || isZero(remoteSha)) continue;
    if (!(await has(remoteSha))) await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', remote, remoteRef], top);
    if (!(await has(remoteSha))) giveUp(`${remoteSha.slice(0, 9)} is not in this repository, and fetching it failed`);
    const forward = !isZero(localSha) && (await git(['merge-base', '--is-ancestor', remoteSha, localSha], top)).status === 0;
    if (!forward) tips.push({ name: `remote-${remoteRef.slice(HEADS.length)}`, sha: remoteSha, remoteRef });
  }
  if (tips.length === 0) return;

  const refs = await saveBefore({ top, gitDir: null, dir: top }, { tips }, deadline);
  for (const [index, { ref, sha }] of refs.entries()) {
    const { remoteRef } = tips[index];
    say(`saved ${remote}'s ${remoteRef.slice(HEADS.length)}, ${sha.slice(0, 9)}, under ${ref} before this push rewrites or deletes it. ` +
      `\`git push ${remote} +${ref}:${remoteRef}\` puts it back. Guard refs are deleted after ${KEEP_DAYS} days.`);
  }
}

main().then(() => process.exit(0), error => giveUp(error.message));
