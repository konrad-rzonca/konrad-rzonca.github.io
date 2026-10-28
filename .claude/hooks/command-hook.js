// The part the guard hooks share: reading the payload and writing the hook's answer.
//
// Every failure lets the call run and says so, to the model through `additionalContext` and to the
// owner through `systemMessage`. A hook refuses only what the repository forbids, and a call it could
// not check is not known to be forbidden.

const path = require('path');

// The tools whose every call carries a command.
const SHELL_TOOLS = ['Bash', 'PowerShell'];

// A longer command is not read, so a hook answers well inside its timeout.
const MAX_COMMAND_LENGTH = 64 * 1024;

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
  }));
}

// Lets the call run with `text` shown to the model and to the owner.
function notice(text) {
  console.log(JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text }
  }));
}

// A call the hook could not read. Its message is the whole explanation, so the notice does not point
// to the harness.
class Unchecked extends Error {}

// The command of a shell payload. Throws Unchecked when the payload
// has no command or one too long to read.
function shellCommand(payload) {
  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== 'string') throw new Unchecked('the call has no tool_input.command');
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Unchecked(`the command is ${command.length} characters long, and a hook reads at most ${MAX_COMMAND_LENGTH}`);
  }
  return command;
}

// Reads the payload from stdin and writes what `decide` answers: `{ deny: reason }`, `{ notice:
// text }` or nothing. A tool outside `tools` passes. When anything fails, the call runs with a notice
// naming the harness that shows why.
function runHook({ name, harness, tools, decide }) {
  const unchecked = error => {
    process.stderr.write(`${name}: ${error.message}\n`);
    const why = error instanceof Unchecked ? error.message
      : `${error.message}. Run node ${path.relative(process.cwd(), harness).split(path.sep).join('/')} to see why`;
    notice(`${name} did not check this call, so it ran unchecked (${why}).`);
  };
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', async () => {
    try {
      let payload;
      try {
        payload = JSON.parse(input);
      } catch (error) {
        throw new Unchecked(`its input is not JSON: ${error.message}`);
      }
      if (!payload || typeof payload !== 'object') throw new Unchecked('its input is not a JSON object');
      if (!tools.includes(payload.tool_name)) return;

      const answer = await decide(payload);
      if (answer && answer.deny) deny(answer.deny);
      else if (answer && answer.notice) notice(answer.notice);
    } catch (error) {
      unchecked(error);
    }
  });
}

module.exports = { SHELL_TOOLS, runHook, shellCommand };
