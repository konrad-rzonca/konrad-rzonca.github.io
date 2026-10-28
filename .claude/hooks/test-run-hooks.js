// Regression cases for run-hooks.js, each on a copy of it beside fixture hooks in a throwaway folder:
// `node .claude/hooks/test-run-hooks.js`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let failures = 0;
function expect(ok, label, detail) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `\n     ${detail}`}`);
  if (!ok) failures++;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'run-hooks-'));

// A hooks folder holding the dispatcher and the given hooks, as { 'pre-write/a.js': source }.
function hooks(name, files) {
  const folder = path.join(scratch, name);
  fs.mkdirSync(folder);
  fs.copyFileSync(path.join(__dirname, 'run-hooks.js'), path.join(folder, 'run-hooks.js'));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), source);
  }
  return folder;
}

function run(folder, event, payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [path.join(folder, 'run-hooks.js'), event], { input, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), json };
}

// A hook that appends its name to a log file beside it, so a case can tell which hooks ran.
const logging = (name, tools, answer) => `
const fs = require('fs');
module.exports = {
  ${tools ? `tools: ${JSON.stringify(tools)},` : ''}
  run(payload) {
    fs.appendFileSync(require('path').join(__dirname, '..', 'ran.log'), '${name}\\n');
    return ${JSON.stringify(answer)};
  }
};`;
const ran = folder => (fs.existsSync(path.join(folder, 'ran.log')) ? fs.readFileSync(path.join(folder, 'ran.log'), 'utf8').trim().split('\n') : []);
const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.txt' } };

try {
  {
    const folder = hooks('first-refusal', {
      'pre-write/a.js': logging('a', ['Write'], null),
      'pre-write/b.js': logging('b', ['Write'], { refuse: 'b refuses' }),
      'pre-write/c.js': logging('c', ['Write'], { refuse: 'c refuses' })
    });
    const result = run(folder, 'pre-write', write);
    expect(result.status === 0 && result.json && result.json.hookSpecificOutput.permissionDecision === 'deny'
      && result.json.hookSpecificOutput.permissionDecisionReason === 'b refuses' && ran(folder).join('|') === 'a|b',
      'before a call, the first refusal denies it and the hooks after it do not run', JSON.stringify({ result, ran: ran(folder) }));
  }
  {
    const folder = hooks('tools', { 'pre-write/a.js': logging('a', ['Edit'], { refuse: 'a refuses' }) });
    const result = run(folder, 'pre-write', write);
    expect(result.status === 0 && result.stdout === '' && ran(folder).length === 0,
      'a hook does not run on a tool outside its tools', JSON.stringify({ result, ran: ran(folder) }));
  }
  {
    const folder = hooks('after', {
      'post-write/a.js': logging('a', ['Write'], { refuse: 'a refuses' }),
      'post-write/b.js': logging('b', ['Write'], { notice: 'b notes' }),
      'post-write/c.js': logging('c', ['Write'], { refuse: 'c refuses' })
    });
    const result = run(folder, 'post-write', { ...write, hook_event_name: 'PostToolUse' });
    expect(result.status === 2 && result.stderr.includes('a refuses') && result.stderr.includes('c refuses')
      && result.stderr.includes('b notes') && ran(folder).length === 3,
      'after a call, every hook runs and every refusal and notice reaches the model through exit code 2', JSON.stringify(result));
  }
  {
    const folder = hooks('notice', { 'post-write/a.js': logging('a', ['Write'], { notice: 'a notes' }) });
    const result = run(folder, 'post-write', { ...write, hook_event_name: 'PostToolUse' });
    expect(result.status === 0 && result.json && result.json.hookSpecificOutput.additionalContext === 'a notes'
      && result.json.hookSpecificOutput.hookEventName === 'PostToolUse' && result.json.systemMessage === 'a notes',
      'a notice reaches the model and the owner', JSON.stringify(result));
  }
  {
    const folder = hooks('throws', {
      'pre-write/a.js': "module.exports = { tools: ['Write'], run() { throw new Error('broken'); } };",
      'pre-write/b.js': 'this is not javascript',
      'pre-write/c.js': logging('c', ['Write'], null)
    });
    const result = run(folder, 'pre-write', write);
    const context = result.json && result.json.hookSpecificOutput.additionalContext;
    expect(result.status === 0 && result.json && !result.json.hookSpecificOutput.permissionDecision
      && context.includes('The a hook failed (broken)') && context.includes('The b hook failed') && ran(folder).join('|') === 'c',
      'a hook that throws or does not load is named in a notice, and the call and the other hooks go on', JSON.stringify(result));
  }
  {
    const folder = hooks('async', { 'pre-write/a.js': "module.exports = { tools: ['Write'], async run() { await new Promise(r => setTimeout(r, 20)); return { refuse: 'later' }; } };" });
    const result = run(folder, 'pre-write', write);
    expect(result.json && result.json.hookSpecificOutput.permissionDecisionReason === 'later', 'an async hook is awaited', JSON.stringify(result));
  }
  {
    const folder = hooks('session', {
      'session-start/a.js': logging('a', null, { notice: 'a starts' }),
      'session-start/b.js': logging('b', null, null)
    });
    const result = run(folder, 'session-start', { hook_event_name: 'SessionStart' });
    expect(result.status === 0 && result.stdout === 'a starts' && ran(folder).length === 2,
      'every session-start hook runs, and its notice is plain text for the context', JSON.stringify(result));
  }
  {
    const folder = hooks('empty', {});
    const result = run(folder, 'post-write', write);
    expect(result.status === 0 && result.stdout === '' && result.stderr === '', 'a missing event folder answers nothing', JSON.stringify(result));
  }
  {
    const folder = hooks('malformed', { 'pre-write/a.js': logging('a', ['Write'], { refuse: 'a refuses' }) });
    const result = run(folder, 'pre-write', 'this is not json');
    expect(result.status === 0 && result.json && !result.json.hookSpecificOutput.permissionDecision
      && result.json.hookSpecificOutput.additionalContext.includes('could not read its input') && ran(folder).length === 0,
      'input that is not JSON lets the call run with a notice', JSON.stringify(result));
  }
  {
    const folder = hooks('null-input', { 'pre-write/a.js': logging('a', ['Write'], { refuse: 'a refuses' }) });
    const result = run(folder, 'pre-write', 'null');
    expect(result.status === 0 && result.json && result.json.hookSpecificOutput.additionalContext.includes('not a JSON object') && ran(folder).length === 0,
      'input that is JSON but not an object lets the call run with a notice', JSON.stringify(result));
  }
  {
    const folder = hooks('bad-event', {});
    const result = run(folder, 'pre-commit', write);
    expect(result.status === 1 && result.stderr.includes('pre-write, post-write, session-start'), 'an unknown event names the events', JSON.stringify(result));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
