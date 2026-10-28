// Runs every hook in one event folder beside this file, all in this Node process:
// `node run-hooks.js <pre-write|post-write|session-start>`.
//
// A hook in a folder exports `run(payload)`, which returns nothing, `{ notice: text }` or
// `{ refuse: reason }` and may be async. A hook in pre-write/ or post-write/ also exports `tools`,
// the tool names it runs on. A hook writes nothing to stdout, which carries this script's answer,
// and never exits the process.
//
// Before a call, the first refusal denies it and stops. After a call, every hook runs, and their
// refusals reach the model together. A hook that fails to load or throws is named in a notice, and
// the call or the session goes on.

const fs = require('fs');
const path = require('path');

const EVENTS = {
  'pre-write': 'PreToolUse',
  'post-write': 'PostToolUse',
  'session-start': 'SessionStart'
};

function hooksIn(event) {
  const folder = path.join(__dirname, event);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => name.endsWith('.js')).sort().map(name => path.join(folder, name));
}

async function dispatch(event, payload) {
  const notices = [];
  const refusals = [];
  for (const file of hooksIn(event)) {
    const name = path.basename(file, '.js');
    try {
      const hook = require(file);
      if (event !== 'session-start' && !(hook.tools || []).includes(payload.tool_name)) continue;
      const answer = await hook.run(payload);
      if (answer && answer.refuse) {
        refusals.push(answer.refuse);
        if (event === 'pre-write') break;
      } else if (answer && answer.notice) {
        notices.push(answer.notice);
      }
    } catch (error) {
      process.stderr.write(`${name}: ${error.stack || error.message}\n`);
      notices.push(`The ${name} hook failed (${error.message}), so it did not run here.`);
    }
  }
  return { notices, refusals };
}

function answer(event, { notices, refusals }) {
  const hookEventName = EVENTS[event];
  if (event === 'session-start') {
    // SessionStart adds plain stdout to the session's context.
    const text = notices.concat(refusals).join('\n');
    if (text) console.log(text);
    return 0;
  }
  if (event === 'pre-write' && refusals.length > 0) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: refusals[0] }
    }));
    return 0;
  }
  if (refusals.length > 0) {
    // After a call, exit code 2 hands stderr to the model.
    process.stderr.write(refusals.concat(notices).join('\n\n') + '\n');
    return 2;
  }
  if (notices.length > 0) {
    const text = notices.join('\n');
    console.log(JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName, additionalContext: text } }));
  }
  return 0;
}

const event = process.argv[2];
if (!EVENTS[event]) {
  process.stderr.write(`run-hooks: the event must be one of ${Object.keys(EVENTS).join(', ')}, not '${event}'.\n`);
  process.exit(1);
}

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  const unread = why => answer(event, { notices: [`run-hooks could not read its input (${why}), so no ${event} hook ran.`], refusals: [] });
  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch (error) {
    process.exitCode = unread(error.message);
    return;
  }
  if (!payload || typeof payload !== 'object') {
    process.exitCode = unread('it is not a JSON object');
    return;
  }
  try {
    process.exitCode = answer(event, await dispatch(event, payload));
  } catch (error) {
    process.stderr.write(`run-hooks: ${error.stack || error.message}\n`);
    process.exitCode = answer(event, { notices: [`run-hooks failed (${error.message}), so no ${event} hook ran.`], refusals: [] });
  }
});
