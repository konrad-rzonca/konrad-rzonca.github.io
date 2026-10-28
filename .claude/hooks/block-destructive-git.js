// Refuses the git commands AGENTS.md forbids where agents share one repository, and saves what a
// discarding command can remove before it runs.
//
// Agents keep a shared repository on one branch (git-head.js), so a command that creates, resets,
// renames or switches to another branch, or detaches HEAD, is refused there. It allows stash,
// reset, checkout, clean, restore and revert on an agent's own work, and on anyone's with the
// owner's approval, which a hook cannot see. Such a command runs after the hook saves what it can
// remove (git-save.js) and tells the agent where. Everything else runs.
//
// A command is refused only when it is refused in each place it may run (git-place.js). Where the
// hook cannot tell which repository a command writes, or cannot read git's arguments
// (git-command.js), it refuses nothing, and saves only in the places it may run (git-place.js
// hints). A push is the pre-push hook's to judge, because only git knows the refs a push sends.
// Plumbing (`update-ref`, `symbolic-ref`, `read-tree`) is not judged, because the commit recipe in
// commit-safety runs it. The reason texts and the examples the harness checks are in the policy
// file beside it.

const path = require('path');

const HARNESS = path.join(__dirname, 'test-destructive-git.js');

// A failure outside runHook, such as a module that is missing or lacks an export, lets the command
// run with a notice, as every other failure does. A hook that exits 1 would say nothing to the model.
process.on('uncaughtException', error => {
  process.stderr.write('block-destructive-git: ' + error.message + '\n');
  const text = `block-destructive-git did not check this call, so it ran unchecked (it failed to load: ${error.message}). ` +
    `Run node ${HARNESS} to see why.`;
  console.log(JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }));
  process.exit(0);
});

const fs = require('fs');
const { SHELL_TOOLS, runHook, shellCommand } = require('./command-hook');
const { scanCommands } = require('./shell-command-scan');
const { classify } = require('./git-command');
const { gitInvocations, repositoryLookups, resolveRepository, UNRESOLVED_LOOKUPS, UNKNOWN } = require('./git-place');
const { saveBefore, KEEP_DAYS } = require('./git-save');

const POLICY = path.join(__dirname, 'block-destructive-git.policy.json');

// The saves of one command end by this long after the hook starts, well inside the hook's timeout
// in settings.json.
const SAVE_DEADLINE_MS = 20 * 1000;

const display = words => {
  const text = `git ${words.slice(1).join(' ')}`;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

// What the command does: the first refusal, the saves it needs per repository, the
// commands whose repository the hook could not tell, and those it saved for only where they may run.
function judge(command, dialect, start) {
  const verdict = { deny: null, saves: [], unplaced: [], hinted: [] };
  for (const invocation of gitInvocations(scanCommands(command, dialect), start, process.env)) {
    const { parsed } = invocation;
    if (parsed.unreadable || !parsed.command || parsed.help) continue;
    const shown = display(invocation.spelled || invocation.words);
    if (invocation.dirs === UNKNOWN || invocation.unknownGlobals) {
      const broadest = classify(parsed, UNRESOLVED_LOOKUPS);
      if (!broadest || !broadest.save) continue;
      const hinted = invocation.unknownGlobals ? [] : hintedSaves(invocation, shown);
      verdict.saves.push(...hinted);
      (hinted.length > 0 ? verdict.hinted : verdict.unplaced).push(shown);
      continue;
    }

    const outcomes = [];
    for (const dir of invocation.dirs) {
      const repository = resolveRepository(dir, invocation.env, invocation, invocation.created);
      if (repository === null) continue;
      if (repository.unknown) {
        outcomes.push({ unknown: true });
        continue;
      }
      const { shared } = repository;
      if (!shared.gitDir && !shared.index && !shared.workTree) {
        outcomes.push({ repository, result: null });
        continue;
      }
      const lookups = repositoryLookups(repository);
      outcomes.push({ repository, lookups, result: classify(parsed, lookups) });
    }

    const refused = outcomes.length > 0 &&
      outcomes.every(outcome => outcome.result && outcome.result.deny && outcome.repository.shared.gitDir);
    if (refused) {
      if (!verdict.deny) verdict.deny = { ...outcomes[0].result, command: shown, top: outcomes[0].repository.top, head: outcomes[0].lookups.head() };
      continue;
    }
    for (const outcome of outcomes) {
      if (outcome.unknown) {
        const broadest = classify(parsed, UNRESOLVED_LOOKUPS);
        if (broadest && broadest.save) verdict.unplaced.push(shown);
        continue;
      }
      const { repository, result } = outcome;
      // A refusal that holds in only some places refuses nothing. A switch of an unshared git
      // directory that writes a shared work tree discards what that work tree holds.
      if (!result || (result.deny && repository.shared.gitDir)) continue;
      const save = result.deny ? { tree: 'tracked', paths: null } : { ...result.save };
      const kept = shareable(save, repository);
      if (kept && repository.saveRepository) verdict.saves.push({ repository, save: kept, command: shown });
      else if (kept) verdict.unplaced.push(shown);
    }
  }
  return verdict;
}

// The saves for an invocation whose place the hook cannot be sure of, in each shared repository it
// may run in.
function hintedSaves(invocation, shown) {
  const saves = [];
  for (const dir of invocation.hints) {
    const repository = resolveRepository(dir, invocation.env, invocation, invocation.created);
    if (!repository || repository.unknown || !repository.saveRepository) continue;
    const result = classify(invocation.parsed, repositoryLookups(repository));
    const kept = result && result.save && shareable(result.save, repository);
    if (kept) saves.push({ repository, save: kept, command: shown });
  }
  return saves;
}

// The parts of `save` the repository shares, or null when it shares none of them. A save in a
// repository named by `--git-dir`, `--work-tree` or their variables keeps the whole tree.
function shareable(save, repository) {
  const kept = {};
  const { shared } = repository;
  if (save.tree && shared.workTree) {
    Object.assign(kept, { tree: save.tree, paths: repository.named ? null : save.paths, pathspecFile: repository.named ? null : save.pathspecFile });
  }
  if (save.index && shared.index) kept.index = true;
  if (shared.gitDir && save.branches && save.branches.length > 0) kept.branches = save.branches;
  if (shared.gitDir && save.stash && save.stash.length > 0) kept.stash = save.stash;
  return Object.keys(kept).length > 0 ? kept : null;
}

// One save per repository for the whole command, covering what every invocation in it removes.
function mergeSaves(saves) {
  const byRepository = new Map();
  for (const { repository, save, command } of saves) {
    const target = repository.saveRepository;
    const key = path.resolve(target.top).toLowerCase();
    const entry = byRepository.get(key) || { target, dir: repository.named ? target.top : repository.dir, save: {}, commands: [] };
    const merged = entry.save;
    if (save.tree) {
      const wholeBefore = merged.tree && merged.paths === null && !merged.pathspecFile;
      merged.tree = merged.tree === 'all' || save.tree === 'all' ? 'all' : 'tracked';
      const sameDir = entry.dir === repository.dir;
      if (wholeBefore || save.paths === null || save.pathspecFile || merged.pathspecFile || !sameDir) {
        const first = !merged.paths && !merged.pathspecFile && !wholeBefore;
        merged.paths = first && sameDir ? save.paths : null;
        merged.pathspecFile = first && sameDir ? save.pathspecFile : null;
      } else {
        merged.paths = [...new Set([...(merged.paths || []), ...save.paths])];
      }
    }
    if (save.index) merged.index = true;
    merged.branches = [...new Set([...(merged.branches || []), ...(save.branches || [])])];
    merged.stash = [...new Set([...(merged.stash || []), ...(save.stash || [])])];
    if (!entry.commands.includes(command)) entry.commands.push(command);
    byRepository.set(key, entry);
  }
  return [...byRepository.values()];
}

// The note a save leaves: what it kept, where, and how to take each kind back with a command this
// hook lets run.
function savedNote(entry, refs, seconds) {
  const base = refs[0].ref.split('/').slice(0, 3).join('/');
  const parts = refs.map(({ ref }) => ref.slice(base.length + 1));
  const named = entry.save.paths || entry.save.pathspecFile;
  const kept = parts.map(part =>
    part === 'tree' ? (named ? 'the named paths and the index' : 'the work tree and the index') : part === 'index' ? 'the index'
      : part.startsWith('branch/') ? `branch ${part.slice(7)}` : part.startsWith('remote/') ? `remote-tracking branch ${part.slice(7)}`
        : `stash entry ${part.slice(6)}`);
  const kinds = new Set(parts.map(part => part.split('/')[0]));
  const branches = parts.filter(part => part.startsWith('branch/')).map(part => part.slice(7));
  const shared = branches.length > 0 ? repositoryLookups({ dir: entry.target.top, gitDir: entry.target.gitDir }).head().shared : null;
  const back = [
    kinds.has('tree') && `a working file with \`git restore --source=${base}/tree --worktree -- <path>\` and ` +
      `a staged blob with \`git restore --source=${base}/tree^2 --staged -- <path>\``,
    kinds.has('index') && `a staged blob with \`git restore --source=${base}/index --staged -- <path>\``,
    branches.includes(shared) && `${shared} with \`git reset --keep ${base}/branch/${shared}\` while HEAD is on it`,
    branches.some(branch => branch !== shared) &&
      `another branch by asking the owner to run \`git branch <name> ${base}/branch/<name>\``,
    kinds.has('remote') && `a remote-tracking branch with \`git update-ref refs/remotes/<name> ${base}/remote/<name>\``,
    kinds.has('stash') && `a stash entry with \`git stash store ${base}/stash/<n>\``
  ].filter(Boolean);
  return `block-destructive-git saved ${kept.join(', ')} of ${entry.target.top} under ${base} before ` +
    `\`${entry.commands.join('`, `')}\` ran (${seconds} s). Take back ${back.join('; ')}. Guard refs are ` +
    `deleted after ${KEEP_DAYS} days, and a \`git push --mirror\` would publish them.`;
}

runHook({
  name: 'block-destructive-git',
  tools: SHELL_TOOLS,
  harness: HARNESS,
  async decide(payload) {
    const started = Date.now();
    const verdict = judge(shellCommand(payload), payload.tool_name, payload.cwd || null);

    if (verdict.deny) {
      const { deny: rule, target, command: shown, top, head } = verdict.deny;
      const policy = JSON.parse(fs.readFileSync(POLICY, 'utf8'));
      // While HEAD is detached outside a rebase, the refusal ends with the way back.
      const back = head.attached || head.rebasing ? null : head.shared ? 'detached' : 'unattached';
      const names = [rule, back].filter(Boolean);
      const missing = names.find(name => typeof policy.reasons[name] !== 'string');
      if (missing) throw new Error(`the policy has no reason text for ${missing}`);
      return { deny: names.map(name => policy.reasons[name]).join(' ').replace(/\{command\}/g, shown).replace(/\{repo\}/g, top).replace(/\{target\}/g, target)
        .replace(/\{shared\}/g, head.shared) };
    }

    const notes = [];
    for (const entry of mergeSaves(verdict.saves)) {
      const began = Date.now();
      try {
        const refs = await saveBefore({ ...entry.target, dir: entry.dir }, entry.save, started + SAVE_DEADLINE_MS);
        if (refs.length > 0) notes.push(savedNote(entry, refs, ((Date.now() - began) / 1000).toFixed(1)));
      } catch (error) {
        notes.push(`block-destructive-git could not save what \`${entry.commands.join('`, `')}\` can remove in ` +
          `${entry.target.top} (${error.message}), so it ran unsaved.`);
      }
    }
    const unplaced = [...new Set(verdict.unplaced)];
    if (unplaced.length > 0) {
      notes.push(`block-destructive-git could not tell which repository \`${unplaced.join('`, `')}\` writes, so it ` +
        'saved nothing before it ran.');
    }
    const hinted = [...new Set(verdict.hinted)];
    if (hinted.length > 0) {
      notes.push(`block-destructive-git could not tell for certain which repository \`${hinted.join('`, `')}\` ` +
        'writes, so it saved in the shared repositories it may write before it ran.');
    }
    return notes.length > 0 ? { notice: notes.join('\n') } : null;
  }
});
