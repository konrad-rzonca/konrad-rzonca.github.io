const msg = process.argv[2] || 'hook';

let input = '';
try {
  const fs = require('fs');
  input = fs.readFileSync(0, 'utf8');
} catch (_) {}

let eventName = '';
try { eventName = JSON.parse(input).hook_event_name || ''; } catch (_) {}

// A subagent reads additionalContext and never the systemMessage, which is the surface the parent
// session shows. Both are written on that event so the text reaches the agent and the reader alike.
if (eventName === 'SubagentStart') {
  console.log(JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: msg }
  }));
} else {
  console.log(JSON.stringify({ systemMessage: msg }));
}
