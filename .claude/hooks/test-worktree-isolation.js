// Regression cases for block-worktree-isolation.js. Node-based so bash and pwsh run the
// identical case list: `node .claude/hooks/test-worktree-isolation.js`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, 'block-worktree-isolation.js');
let failures = 0;

// allow  -> exit 0, no output       deny -> exit 0 with a PreToolUse deny payload
// notice -> exit 0 with a message to the model and the owner and no decision, so the call runs
// block  -> exit 2 AND empty stdout. On WorktreeCreate stdout carries the worktree path, so
// any text written there is a defect that a check of the exit code alone would miss.
function check(expected, label, payload, args = [], hookPath = hook) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const run = spawnSync(process.execPath, [hookPath, ...args], { input: body, encoding: 'utf8' });
  const stdout = (run.stdout || '').trim();

  let actual;
  if (run.status === 2) {
    actual = stdout === '' ? 'block' : 'block-with-stray-stdout';
  } else if (run.status !== 0) {
    actual = `exit ${run.status}`;
  } else if (stdout === '') {
    actual = 'allow';
  } else {
    let output = {};
    try { output = JSON.parse(stdout); } catch {}
    const specific = output.hookSpecificOutput || {};
    actual = specific.permissionDecision === 'deny' ? 'deny'
      : !specific.permissionDecision && output.systemMessage && specific.additionalContext ? 'notice' : 'unreadable output';
  }

  if (actual === expected) {
    console.log(`OK   [${expected}] ${label}`);
  } else {
    console.log(`FAIL expected=${expected} got=${actual} : ${label}`);
    console.log(`     stdout: ${stdout}  stderr: ${(run.stderr || '').trim()}`);
    failures++;
  }
}

const agent = (input) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input });
const workflow = (input) => ({ hook_event_name: 'PreToolUse', tool_name: 'Workflow', tool_input: input });
const shell = (name, command) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: { command } });

check('allow', 'Agent without isolation', agent({ prompt: 'do the thing' }));
check('allow', 'Agent isolation=remote', agent({ prompt: 'x', isolation: 'remote' }));
check('allow', 'Agent whose prompt merely mentions isolation', agent({ prompt: "docs say isolation: 'worktree' is banned" }));
check('allow', 'Workflow with a clean script', workflow({ script: 'agent("x", {label: "y"})' }));
// A `git worktree add` in a shell command is block-destructive-git.js's to deny, so this hook
// allows it. test-destructive-git.js holds the shell cases.
check('allow', 'a shell worktree add, which the destructive git hook owns', shell('PowerShell', 'git worktree add ../tmp HEAD'));
check('allow', 'a shell command on Bash', shell('Bash', 'ls -la'));

check('deny', 'Agent isolation=worktree', agent({ prompt: 'x', isolation: 'worktree' }));
check('deny', 'Task isolation=worktree', { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { isolation: 'worktree' } });
// A Workflow agent's isolation fires WorktreeCreate, so a workflow that merely names it passes.
check('allow', 'Workflow whose script names isolation', workflow({ script: "agent(x, {isolation: 'worktree'})" }));
check('allow', 'Workflow whose scriptPath cannot be read', workflow({ scriptPath: 'C:/no/such/script.js' }));

// settings.json names the event on the command line, so the creation fails whatever the input holds.
check('block', 'WorktreeCreate command with a malformed payload', 'this is not json', ['--worktree-create']);
check('block', 'WorktreeCreate command with an empty payload', '', ['--worktree-create']);
// The flag is read before the shared module loads, so a broken module cannot let a creation through.
for (const [label, shared] of [
  ['a missing shared module', null],
  ['a shared module that throws as it loads', "throw new Error('broken');"]
]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-hook-'));
  fs.copyFileSync(hook, path.join(dir, path.basename(hook)));
  if (shared !== null) fs.writeFileSync(path.join(dir, 'command-hook.js'), shared);
  check('block', `WorktreeCreate command beside ${label}`, '{}', ['--worktree-create'], path.join(dir, path.basename(hook)));
  fs.rmSync(dir, { recursive: true, force: true });
}
check('notice', 'a malformed tool payload runs with a notice', 'this is not json');
check('notice', 'a non-object tool payload runs with a notice', '"just a string"');

if (failures !== 0) {
  console.log(`${failures} worktree isolation hook checks failed.`);
  process.exit(1);
}

console.log('PASS: worktree isolation hook checks succeeded.');
