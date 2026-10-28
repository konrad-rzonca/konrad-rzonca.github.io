// Where HEAD is in a repository and which branch its agents share, read from the git directory
// without running git. reference-transaction.sh reads the first two the same way.
// - attached: the branch HEAD names, or null while HEAD is detached.
// - rebasing: the branch a running rebase returns to, or null.
// - shared: attached, else rebasing, else the newest branch HEAD's reflog names that `isBranch`
//   still finds, or null when there is none.
//
// The reflog counts the branch a `checkout: moving from` line left and the one a rebase returned
// to. A checkout's target is no evidence, because `git switch --detach <branch>` names a branch
// HEAD never attached to.

const fs = require('fs');
const path = require('path');

const read = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const branchOf = (text, prefix) => {
  const match = new RegExp(`^${prefix}refs/heads/(\\S+)\\s*$`).exec(text);
  return match ? match[1] : null;
};

function readHead(gitDir, isBranch) {
  const attached = branchOf(read(path.join(gitDir, 'HEAD')), 'ref: ');
  const rebasing = branchOf(read(path.join(gitDir, 'rebase-merge', 'head-name')), '') ||
    branchOf(read(path.join(gitDir, 'rebase-apply', 'head-name')), '');
  let shared = attached || rebasing;
  if (!shared) {
    const messages = read(path.join(gitDir, 'logs', 'HEAD')).split('\n').map(line => line.slice(line.indexOf('\t') + 1)).reverse();
    for (const message of messages) {
      const named = /^checkout: moving from (\S+) to /.exec(message) ||
        /^rebase(?: -i)? \((?:finish|abort)\): returning to refs\/heads\/(\S+)$/.exec(message);
      if (named && isBranch(named[1])) {
        shared = named[1];
        break;
      }
    }
  }
  return { attached, rebasing, shared: shared || null };
}

module.exports = { readHead };
