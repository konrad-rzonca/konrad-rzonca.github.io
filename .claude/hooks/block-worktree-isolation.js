// Blocks worktree creation that carries no command string: worktree isolation on an Agent or Task
// call, and the WorktreeCreate event, which every other isolated agent, a Workflow's included, fires.
// A `git worktree add` in a shell command is block-destructive-git.js's to refuse.
//
// On a tool call, a failure lets the call run with a notice. On WorktreeCreate the hook exits 2
// before it loads anything, because failing the creation is what that hook is for.

const REASON = 'Git worktrees are disabled here, so work in the main checkout.';

// settings.json puts this flag on the WorktreeCreate command. Exit 2 blocks the creation and shows
// the stderr text. The event's stdout carries the worktree path, so nothing is written there.
if (process.argv.includes('--worktree-create')) {
  process.stderr.write(REASON + '\n');
  process.exit(2);
}

const path = require('path');
const { runHook } = require('./command-hook');

runHook({
  name: 'block-worktree-isolation',
  tools: ['Agent', 'Task'],
  harness: path.join(__dirname, 'test-worktree-isolation.js'),
  decide(payload) {
    const input = payload.tool_input;
    if (input && typeof input === 'object' && input.isolation === 'worktree') {
      return { deny: REASON + ' Call the agent again without the isolation parameter.' };
    }
    return null;
  }
});
