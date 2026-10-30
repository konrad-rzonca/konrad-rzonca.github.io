// Checks block-destructive-git.js and the modules it reads commands with:
// `node .claude/hooks/test-destructive-git.js`.
//
// - The option table agrees with the installed git.
// - The scan finds git in every spelling a shell hands it to git, and nowhere a command only
//   mentions it. A case runs on both shells unless it spells one shell's syntax.
// - Every example in the policy gives its decision in its repository context, in a fixture built
//   here (the policy's examplesNote). A refusal says the trap, and while HEAD is detached, the way
//   back.
// - A guard save keeps a working file and a staged blob, and fails cleanly past its deadline and on
//   an index git cannot write.
// - A failure lets the command run with a notice.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanCommands, commandName } = require('./shell-command-scan');
const { parseGit } = require('./git-command');
const { buildTable, listedGlobals, readTable } = require('./git-options');
const { saveBefore, SaveFailed } = require('./git-save');

const hook = path.join(__dirname, 'block-destructive-git.js');
const policyFile = path.join(__dirname, 'block-destructive-git.policy.json');
const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));

let failures = 0;
const ok = label => console.log(`OK   ${label}`);
const fail = label => {
  console.log(`FAIL ${label}`);
  failures++;
};

// Runs a hook on a payload. allow: exit 0 with empty stdout. deny: a PreToolUse deny. notice: a
// message to the model and the owner with no decision, so the call runs. A non-zero exit is a crash
// and stdout that is none of these is what the host ignores, so both report `error`.
function run(payload, hookPath) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [hookPath], { input: body, encoding: 'utf8' });
  const stdout = (result.stdout || '').trim();
  if (result.status !== 0) return { verdict: 'error', reason: (result.stderr || '').trim() };
  if (stdout === '') return { verdict: 'allow', reason: '' };
  let document = null;
  try {
    document = JSON.parse(stdout);
  } catch {}
  const output = document && document.hookSpecificOutput;
  if (output && output.permissionDecision === 'deny') return { verdict: 'deny', reason: output.permissionDecisionReason };
  if (output && !output.permissionDecision && output.additionalContext && document.systemMessage === output.additionalContext) {
    return { verdict: 'notice', reason: output.additionalContext };
  }
  return { verdict: 'error', reason: stdout };
}
const tool = (name, input) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input });
const bash = command => tool('Bash', { command });
const pwsh = command => tool('PowerShell', { command });
const check = (expected, label, payload, hookPath = hook, reason = '') => {
  const actual = run(payload, hookPath);
  if (actual.verdict === expected && actual.reason.includes(reason)) ok(`[${expected}] ${label}`);
  else fail(`expected=${expected} got=${actual.verdict} : ${label} (${actual.reason})`);
};

// Runs `cases` against a copy of the hook beside every file it requires, with `files` written over
// the copies: a string replaces a file's content and null deletes it. With `projectPackage`, the copy
// sits in `.claude/hooks` under a project root holding that package.json text.
function withCopy(label, files, cases, projectPackage) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-'));
  const directory = projectPackage === undefined ? top : path.join(top, '.claude', 'hooks');
  if (projectPackage !== undefined) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(top, 'package.json'), projectPackage);
  }
  for (const name of fs.readdirSync(__dirname)) {
    if (!name.startsWith('test-') && fs.statSync(path.join(__dirname, name)).isFile()) {
      fs.copyFileSync(path.join(__dirname, name), path.join(directory, name));
    }
  }
  for (const [name, content] of Object.entries(files)) {
    if (content === null) fs.rmSync(path.join(directory, name), { force: true });
    else fs.writeFileSync(path.join(directory, name), content);
  }
  try {
    for (const [expected, caseLabel, payload, reason] of cases) {
      check(expected, `${label}: ${caseLabel}`, payload, path.join(directory, path.basename(hook)), reason);
    }
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the option table

const table = readTable();
const built = buildTable();
if (JSON.stringify(built) === JSON.stringify(table)) ok('git-options.json matches the installed git');
else fail('git-options.json differs from the installed git: run node .claude/hooks/git-options.js');
for (const [name, kind] of Object.entries(listedGlobals())) {
  const tabled = table.global[name];
  const agrees = tabled === kind || (kind === 'none' && tabled === 'exit');
  if (agrees) ok(`git -h lists ${name} as the table reads it`);
  else fail(`git -h lists ${name} as ${kind}, and the table says ${tabled}`);
}

// ---------------------------------------------------------------- the scan

const GUARDED = new Set(['reset', 'clean', 'stash', 'checkout', 'checkout-index', 'restore', 'revert', 'branch', 'switch', 'push', 'worktree', 'rm']);

// The guarded git commands the scan finds in `command`.
function guardedCommands(command, dialect) {
  const found = [];
  for (const step of scanCommands(command, dialect)) {
    // git after a wrapper such as `env` or `timeout 60`.
    const at = step.kind === 'command' ? step.words.findIndex(word => commandName(word) === 'git') : -1;
    if (at < 0) continue;
    const words = step.words.slice(at);
    const parsed = parseGit(words, step.unknown.slice(at), step.quoted.slice(at));
    const verb = parsed.unreadable ? words.slice(1).find(word => GUARDED.has(word)) : parsed.command && parsed.command.split(' ')[0];
    if (verb && GUARDED.has(verb)) found.push(verb);
  }
  return found;
}
const reads = (dialect, command) => {
  if (guardedCommands(command, dialect).length > 0) ok(`${dialect} reads git in: ${JSON.stringify(command)}`);
  else fail(`${dialect} finds no guarded git command in: ${JSON.stringify(command)}`);
};
const readsNothing = (dialect, command) => {
  const found = guardedCommands(command, dialect);
  if (found.length === 0) ok(`${dialect} reads no guarded git command in: ${JSON.stringify(command)}`);
  else fail(`${dialect} reads git ${found.join(', ')} in: ${JSON.stringify(command)}`);
};
const readsOnBoth = command => ['Bash', 'PowerShell'].forEach(dialect => reads(dialect, command));
const readsNothingOnBoth = command => ['Bash', 'PowerShell'].forEach(dialect => readsNothing(dialect, command));

// Commands the workflow runs daily, which pass on Bash and PowerShell in a shared repository.
const daily = [
  'git status',
  'git stash list',
  'git stash show',
  'git clean -n',
  'git clean -nd',
  'git clean --dry-run',
  'git clean -fdn',
  'git push',
  'git push origin master',
  'git push origin master 2>&1 | tail -10',
  'git switch master',
  'git branch',
  'git branch -a',
  'git worktree list',
  'git worktree prune',
  'git worktree remove ../tmp',
  'git -C ../other-repo worktree list',
  'git worktree list | grep add',
  'git worktree list && git status',
  // Read-only git behind a global flag, some searching for a banned verb. A widened commandPrefix
  // denies these first.
  'git --no-pager log --grep restore',
  'git --no-pager grep -rn checkout .claude',
  'git --no-pager log -S checkout -- Packages',
  'git -P log --format=%H -1 stash',
  'git --literal-pathspecs log --grep revert',
  'git -c core.pager=cat log --oneline -5',
  'git -C ../other-repo log --oneline -5',
  // Restoring a file from HEAD without `git restore`, which must stay allowed.
  'git cat-file blob HEAD:Packages/Foo.cs > Packages/Foo.cs',
  // A path argument that contains a banned verb. commandPrefix allows only global flags between
  // `git` and the verb.
  'git add scripts/restore-slot.ps1',
  'git add scripts/checkout-helper.ps1',
  'git.exe status',
  'git.exe push origin master',
  'git.exe branch -a',
  'git.exe clean -n'
];

// Every guarded command, in the plain spelling.
const destructive = [
  'git stash',
  'git stash push -u',
  'git stash pop',
  'git stash apply',
  'git stash drop',
  'git stash clear',
  'git stash list && git stash pop',
  'git stash\nlist',
  'git checkout master',
  'git checkout HEAD -- Packages/Foo.cs',
  'git reset --hard',
  'git reset --hard HEAD',
  'git clean -fd',
  'git clean -f',
  'git clean -xfd',
  'git clean -n; git clean -fd',
  'git clean -fd\n-n',
  'git clean -fd > -n',
  'git clean -fd # try -n first',
  'git restore Packages/Foo.cs',
  'git restore --staged Packages/Foo.cs',
  'git revert HEAD',
  'git branch new-branch',
  'git branch -D tmp',
  'git switch -c new-branch',
  'git switch other-branch',
  'git switch -',
  'git worktree add ../foo bar',
  'git worktree add --detach ../tmp HEAD~1',
  'git push origin other/branch',
  'git push --force',
  'git push origin master --force',
  'git push --force-with-lease'
];

// Other spellings git accepts: `git.exe`, global flags before the verb, and other casings.
const otherSpellings = [
  'git.exe reset --hard',
  'git.exe checkout master',
  'git.exe stash pop',
  'git.exe clean -fd',
  'git.exe restore Packages/Foo.cs',
  'git.exe revert HEAD',
  'git.exe branch feature/foo',
  'git.exe switch -c feature/foo',
  'git.exe worktree add ../tmp HEAD',
  'git.exe push origin feature/foo',
  'git.exe push --force',
  'git -C ../other-repo reset --hard',
  'git -c core.pager=cat checkout master',
  'git -P clean -fd',
  'git --no-pager restore Packages/Foo.cs',
  'git -C ../other-repo stash pop',
  'git -c foo=bar branch -D tmp',
  'git -C ../other-repo push upstream master',
  'git -C C:/src/repo worktree add ../tmp HEAD',
  'git -C "C:/src/repo" worktree add ../tmp HEAD',
  'git -c "foo=bar" branch -D tmp',
  'git --git-dir=".git" --work-tree="." reset --hard',
  'git -c core.bare=false worktree add ../tmp HEAD',
  'git --git-dir=.git --work-tree=. worktree add ../tmp HEAD',
  'git --no-pager worktree add ../tmp HEAD',
  'git -p worktree add ../tmp HEAD',
  'git -P worktree add ../tmp HEAD',
  'git --no-replace-objects worktree add ../tmp HEAD',
  'git --no-lazy-fetch worktree add ../tmp HEAD',
  'git --attr-source=HEAD worktree add ../tmp HEAD',
  'git --no-advice worktree add ../tmp HEAD',
  // Windows resolves every casing to the same executable.
  'Git reset --hard',
  'GIT.EXE clean -fd'
];


// Spellings that hand git a command, each on the shell whose syntax it spells.
const bashSpellings = [
  // Bash deletes an escaped line break, inside a word and inside double quotes too.
  'git c\\\nlean -fd',
  'gi\\\nt reset --hard',
  'git reset \\\n--hard',
  'git c\\\r\nlean -fd',
  'git reset \\\r\n--hard',
  'git "re\\\nset" --hard',
  'git c\\lean -fd',
  "git $'reset' --hard",
  "git $'\\x72eset' --hard",
  'git $"reset" --hard',
  'git reset ""--hard',
  'env "/c/Program Files/Git/bin/git.exe" reset --hard',
  'timeout 60 "/c/Program Files/Git/bin/git.exe" clean -fd',
  '"/c/Program Files/Git/bin/git.exe" reset --hard',
  // Git Bash turns `//c` into `/c`.
  'cmd //c "git reset --hard"',
  "echo 'git reset --hard' | bash",
  "echo 'git reset --hard' | timeout 60 bash",
  "bash <<< 'git clean -fd'",
  "bash -c g'it reset --hard'",
  'bash -c git\\ reset\\ --hard',
  "bash -c -- 'git reset --hard'",
  "bash -c -x 'git reset --hard'",
  "bash -o pipefail -c 'git reset --hard'",
  // Bash reads a brace as an operator only as a whole word, and expands a brace list.
  'echo ${x}#; git reset --hard',
  'git {reset,} --hard',
  'git {clean,-fd}',
  // Bash removes the quotes of the whole heredoc delimiter.
  'cat <<E"O"F\nx\nEOF\ngit reset --hard',
  'cat <<"E"OF\nx\nEOF\ngit reset --hard',
  'cat <<E\\OF\nx\nEOF\ngit reset --hard',
  "echo 'git reset --hard' | (bash)",
  "echo 'git reset --hard' | { bash; }",
  "trap 'git reset --hard' EXIT",
  "trap -- 'git reset --hard' EXIT",
  // An evaluator is in the command word's place after a keyword, `!`, `time`, `command` or an
  // assignment.
  "if eval 'git reset --hard'; then :; fi",
  "! eval 'git reset --hard'",
  "time eval 'git reset --hard'",
  "command eval 'git reset --hard'",
  "x=1 eval 'git reset --hard'",
  "for f in a; do eval 'git reset --hard'; done",
  "if powershell 'git reset --hard'; then :; fi",
  '{bash,-c} "git reset --hard"',
  "env -S 'git reset --hard'",
  // A heredoc ends only at a line that is exactly its delimiter, after leading tabs with `<<-`.
  "cat <<EOF\n  EOF\ndon't\nEOF\ngit reset --hard",
  "cat > notes.txt <<EOF\nEOF \nit's\nEOF\ngit clean -fd",
  "cat <<-EOF\n\tx\n\tEOF\ngit reset --hard",
  // `((` is arithmetic, whose `<<` is a shift.
  '(( y = 1<<2 ))\ngit reset --hard',
  'echo ${x:-"}"}; git reset --hard',
  'git reset $(git rev-parse HEAD~1) --hard',
  "cat <<$'EOF'\nnote\nEOF\ngit reset --hard",
  'cat <<$"EOF"\nnote\nEOF\ngit reset --hard',
  // A word that may expand to nothing does not hide the subcommand.
  'git "$@" reset --hard',
  'git $(true) reset --hard',
  'git 2>&1 reset --hard',
  // A pipeline continues after a trailing `|`, `&&` or `||`, and a heredoc's reader may follow it.
  "echo 'git reset --hard' |\n  bash",
  "cat <<'EOF' |\ngit reset --hard\nEOF\nbash",
  // Bash splits words only at a space, a tab or a line break.
  'echo a #b; git reset --hard',
  "bash -c -O extglob 'git stash'",
  'x=${y:-$(git "stash")}',
  // A heredoc's reader is in the pipeline it was written in, whatever ends that pipeline.
  "bash <<'EOF' 2>&1\ngit reset --hard\nEOF",
  "bash -s <<'EOF' || echo failed\ngit reset --hard\nEOF",
  "bash <<'EOF' && echo done\ngit reset --hard\nEOF",
  "bash <<'EOF'; echo done\ngit reset --hard\nEOF",
  "bash <<'EOF' >/dev/null 2>&1\ngit reset --hard\nEOF",
  "bash <<'EOF' &>/dev/null\ngit reset --hard\nEOF",
  "echo 'git reset --hard' 2>&1 | bash",
  // Each `o` or `O` in a shell's option cluster takes a value.
  "bash -co pipefail 'git reset --hard'",
  "bash -oc pipefail 'git reset --hard'",
  "bash -c -xo pipefail 'git reset --hard'",
  "bash -cO extglob 'git reset --hard'",
  'git > /dev/null reset --hard',
  'git &>/dev/null reset --hard',
  // Bash runs a substitution in an unquoted heredoc before the interpreter reads it.
  'python - <<EOF\nprint("$(git reset --hard)")\nEOF',
  // A lone CR inside a Bash word is part of the word.
  'git branch \r -D tmp',
  // A lone `-` or `+` ends a shell's options.
  "bash -c - 'git reset --hard'",
  "bash -c + 'git reset --hard'",
  'git >| out reset --hard',
  'git <<<x reset --hard',
  'git <>f reset --hard',
  'git 0<&- reset --hard',
  'git {fd}>x reset --hard',
  'git >x>y reset --hard',
  // An escaped `>` is text, so the `|` or `&` after it is an operator.
  "echo 'git reset --hard #' \\>|bash",
  "true \\>|eval 'git reset --hard'",
  "true \\>& eval 'git reset --hard'",
  // A group or subshell reads the heredoc or here-string written after it.
  "{ bash; } <<'EOF'\ngit reset --hard\nEOF",
  "{ bash; } 2>&1 <<'EOF'\ngit reset --hard\nEOF",
  "( bash ) <<< 'git reset --hard'",
  "{ bash; }<<'EOF'\ngit reset --hard\nEOF",
  "{ bash; }<<<'git reset --hard'",
  "{ bash; }>/dev/null <<'EOF'\ngit reset --hard\nEOF",
  "{ bash; }\\\n<<'EOF'\ngit reset --hard\nEOF",
  "{ sh -s env; } <<'EOF'\ngit reset --hard\nEOF",
  // A `}` argument or a `case` pattern's `)` closes no group.
  "{ echo }; bash; } <<'EOF'\ngit reset --hard\nEOF",
  "{ case x in x) bash;; esac; } <<'EOF'\ngit reset --hard\nEOF",
  // A `}` right after a compound command's last word closes its group too.
  "function f { bash; } <<'EOF'\ngit reset --hard\nEOF\nf",
  "coproc { bash; } <<'EOF'\ngit reset --hard\nEOF",
  "{ if true; then bash; fi } <<'EOF'\ngit reset --hard\nEOF",
  "{ for i in 1; do bash; done } <<'EOF'\ngit reset --hard\nEOF",
  "{ bash; [[ -n x ]] } <<'EOF'\ngit reset --hard\nEOF",
  "{ case x in x) bash;; esac } <<'EOF'\ngit reset --hard\nEOF",
  "for ((i=0;i<1;i++)) { bash; } <<'EOF'\ngit reset --hard\nEOF",
  "{\\\n bash; } <<'EOF'\ngit reset --hard\nEOF",
  // Bash reads no reserved word after an assignment, so this `}` is a command.
  "{ x=1 }; bash; } <<'EOF'\ngit reset --hard\nEOF",
  "( case x in x) bash;; esac ) <<'EOF'\ngit reset --hard\nEOF",
  // A subshell's heredoc reaches a shell named inside it, whatever braces or `case` words precede.
  "( x=1 case; bash ) <<'EOF'\ngit reset --hard\nEOF",
  "( echo { ; bash ) <<'EOF'\ngit reset --hard\nEOF",
  "( echo { ; bash ) <<< 'git reset --hard'",
  "( { if true; then :; fi }; bash ) <<'EOF'\ngit reset --hard\nEOF",
  "( case y in x) x=1 esac;; y) bash;; esac ) <<'EOF'\ngit reset --hard\nEOF",
  "( case b in a) :;;\ncase|b) bash;; esac ) <<'EOF'\ngit reset --hard\nEOF",
  // A brace that is an argument keeps its pipeline.
  "printf 'git reset --hard\\n' { | bash",
  "printf 'git reset --hard\\n' } | bash",
  "printf 'git reset --hard\\n' | xargs -I { bash -c {",
  // Bash allows only redirects after a group: an fd number, a target, an earlier here-string.
  "{ bash; } 0<<'EOF'\ngit reset --hard\nEOF",
  "( bash ) 0<<< 'git reset --hard'",
  "(bash)0<<'EOF'\ngit reset --hard\nEOF",
  "( bash ) 2>/dev/null 0<<'EOF'\ngit reset --hard\nEOF",
  "( bash ) <<< x <<'EOF'\ngit reset --hard\nEOF",
  "{ bash; } <<<x <<<'git reset --hard'",
  // `fi` or `]]` as an argument ends nothing, so the brace after it is an argument too.
  "printf 'git reset --hard\\n' fi } | bash",
  "printf 'git reset --hard\\n' ]] } | bash",
  "printf 'git reset --hard\\n' | tee fi } | bash",
  "( bash ) >| out.txt <<'EOF'\ngit reset --hard\nEOF",
  "{ bash; case x in esac } <<'EOF'\ngit reset --hard\nEOF",
  "{ bash; time -p [[ 1 ]] } <<'EOF'\ngit reset --hard\nEOF"
];;

const powershellSpellings = [
  'git `u{72}eset --hard',
  'git "`u{72}eset" --hard',
  '& "C:/Program Files/Git/bin/git.exe" reset --hard',
  '. "C:/Program Files/Git/bin/git.exe" reset --hard',
  'cmd /c "git reset --hard"',
  'CMD /C "git reset --hard"',
  'cmd /c"git reset --hard"',
  "cmd.exe /c 'git reset --hard'",
  'cmd /c git re"set" --hard',
  "Start-Process git -ArgumentList 'reset --hard'",
  "Start-Process -FilePath git -ArgumentList 'checkout','master'",
  "Start-Process git 'reset --hard'",
  "saps git -Args 'reset --hard'",
  "Start-Process git -Arg 'reset --hard'",
  "Start-Process -File git -A 'reset --hard'",
  "saps git 'checkout master'",
  "Start-Process git -ArgumentList '-c a=b&c reset --hard'",
  "Start-Process git -ArgumentList 'reset', '--hard'",
  "Start-Process git -ArgumentList 'reset',\n  '--hard'",
  'Start-Process git -ArgumentList reset,--hard',
  "Start-Process pwsh -ArgumentList '-Command \"git reset --hard\"'",
  "Start-Process cmd '/c \"git reset --hard\"'",
  '"git reset --hard" | iex',
  // PowerShell ends a word at the closing quote of a quoted part that starts it, so git receives
  // `mas` and `ter`, and `-` and `n`.
  'git push origin "mas"ter',
  'git clean -fd "-"n .',
  'iex ("git reset --hard")',
  'Invoke-Expression("git reset --hard")',
  "'git reset --hard' | ForEach-Object { iex $_ }",
  "Start-Process git -ArgumentList @('reset','--hard')",
  "Start-Process git -ArgumentList @(\n  'reset'\n  '--hard'\n)",
  // An assignment's value is a pipeline of its own.
  "$p = Start-Process git -ArgumentList 'reset --hard' -PassThru",
  "$null = Start-Process git 'checkout master' -Wait",
  "$p=Start-Process git 'reset --hard'",
  "[int]$n += Start-Process git 'reset --hard'",
  "$out = 'git reset --hard' | iex",
  "$out = powershell 'git reset --hard'",
  "$p = Start-Process git -ArgumentList ('checkout','master') -PassThru",
  // PowerShell 7 takes `/` before a parameter, and -CommandWithArgs runs the word after it.
  "pwsh /c 'git reset --hard'",
  "pwsh -NoProfile /Command 'git reset --hard'",
  "pwsh -cwa 'git reset --hard'",
  "pwsh -CommandWithArgs 'git reset --hard' extra",
  "Write-Output --% it's done\ngit reset --hard",
  // Windows PowerShell's script flags come before its positional script.
  'powershell -EncodedCommand ZwBpAHQAIAByAGUAcwBlAHQAIAAtAC0AaABhAHIAZAA=',
  'powershell -NoProfile -e ZwBpAHQAIAByAGUAcwBlAHQAIAAtAC0AaABhAHIAZAA=',
  // A group's commands run, as a substitution's do.
  'Write-Output ("$(git reset --hard)")',
  '$a = @("x", "$(git reset --hard)")',
  'git reset (git rev-parse HEAD | Select-Object -First 1) --hard',
  'git clean -fd (Get-Item x -n)',
  // An evaluator after the dot-source or call operator, in a hashtable value, or in a block's assignment.
  ". iex 'git reset --hard'",
  "'git reset --hard' | & iex",
  "'git reset --hard' | & { iex $_ }",
  "'git reset --hard' | % { $null = iex $_ }",
  "$h = @{ a = iex 'git reset --hard' }",
  "return Start-Process git 'reset --hard'",
  'git $null reset --hard',
  'git @() reset --hard',
  'git 2>$null reset --hard',
  "'git reset --hard' |\n  iex",
  "'git reset --hard'\n| iex",
  "Invoke-Expression -ErrorAction Stop 'git reset --hard'",
  "iex -Verbose 'git reset --hard'",
  "Start-Process git -ArgumentList:@('reset','--hard')",
  // A lone CR ends a comment, NEL splits words, and `<#` inside a word opens no comment.
  '# note\rgit reset --hard',
  'git\u0085reset\u0085--hard',
  'Write-Output a<#b\ngit reset --hard\nWrite-Output c#>',
  // A PowerShell pipeline continues across comments.
  "'git reset --hard'\n# c\n| iex",
  "'git reset --hard' | <#c#>\niex",
  "echo 'git reset --hard' 2>&1 | iex",
  // Common parameters bind by any unambiguous prefix.
  "iex -ErrorA Stop 'git reset --hard'",
  "iex -OutVar zz 'git reset --hard'",
  'git > $null reset --hard',
  'git *>$null reset --hard',
  // PowerShell also splits native arguments at a no-break space.
  'git branch -D tmp',
  "Start-Process git -ArgumentList:'reset','--hard'",
  'Start-Process git -ArgumentList:reset,--hard',
  "git $('reset') --hard",
  "cmd --% /c git reset --hard",
  'git reset $(git rev-parse HEAD~1) --hard',
  "Start-Process pwsh -ArgumentList @('-Command','git reset --hard')",
  "Microsoft.PowerShell.Management\\Start-Process git 'reset --hard'",
  "Invoke-Expression -Command:'git reset --hard'",
  // A parameter with a colon and nothing after it takes the next word, and `--` ends the parameters.
  "Invoke-Expression -ErrorAction: Stop 'git reset --hard'",
  "iex -Verbose: $true 'git reset --hard'",
  "iex -- 'git reset --hard'",
  "Start-Process -Wait: $true git 'reset --hard'",
  "Start-Process -- git 'reset --hard'",
  // -Command, spelled with a colon or by prefix, makes the next word the script.
  "iex -Command: 'git reset --hard'",
  "iex -Verbose -Command: 'git reset --hard'",
  "iex -C: 'git reset --hard'",
  "iex -Command -- 'git reset --hard'",
  "Invoke-Expression -C -- 'git reset --hard'",
  // A quoted word is never a parameter.
  "iex -Command '-abc:1; git reset --hard'",
  "iex -C '-x:1;git reset --hard'",
  "iex '-abc:1; git reset --hard'",
  // PowerShell binds a parameter only from an unquoted, unescaped name.
  "iex -Command -'abc:1; git reset --hard'",
  "iex -'abc:1; git reset --hard'",
  "iex `-abc:1';git reset --hard'",
  // Windows PowerShell reads its first argument that is not an option as a script.
  'powershell "git reset --hard"',
  'powershell -NoProfile -ExecutionPolicy Bypass "git reset --hard"',
  // `git reset --hard` as base64 UTF-16.
  'pwsh -EncodedCommand ZwBpAHQAIAByAGUAcwBlAHQAIAAtAC0AaABhAHIAZAA=',
  'cmd /cgit reset --hard',
  'git ("reset") --hard'
];;

destructive.forEach(readsOnBoth);
otherSpellings.forEach(readsOnBoth);
bashSpellings.forEach(command => reads('Bash', command));
powershellSpellings.forEach(command => reads('PowerShell', command));

// A mention of a git command runs nothing: a quoted sentence, a search pattern, a commit message, a
// heredoc no shell reads, the words after a script file, and the body of an inline Python, Node,
// Perl or Ruby script.
[
  "echo 'git reset --hard'",
  "grep -r 'git stash' .",
  'git commit -m "mention git push origin master in msg"',
  'git log --oneline --grep="worktree add"',
  'git --no-pager log -S checkout -- Packages',
  'git --no-pager grep -rn checkout .claude',
  'git -P log --format=%H -1 stash',
  'git -C checkout-tool status',
  'git add scripts/restore-slot.ps1',
  'rg -n "git reset --hard" docs | uv run python scripts/summarize.py',
  'node -e "require(\'child_process\').execSync(\'git reset --hard\')"',
  "python -c \"import os; os.system('git clean -fd')\"",
  'perl -e "system(q(git reset --hard))"'
].forEach(readsNothingOnBoth);
readsNothing('Bash', 'git commit -m "$(cat <<\'EOF\'\nContent mentions git push origin master and git reset --hard.\nEOF\n)"');
readsNothing('PowerShell', "git commit -m @'\ntools: never run git reset --hard here\n'@");
readsNothing('Bash', "cat > /c/tmp/notes.md <<'EOF'\nnever run bash -c 'git reset --hard'\nEOF");
readsNothing('Bash', "grep -c reset <<< 'git reset --hard'");
readsNothing('Bash', 'grep -c "git reset --hard" Plans/notes.md');
readsNothing('Bash', "cat > x.sh <<'EOF' && bash x.sh\ngit reset --hard\nEOF");
readsNothing('Bash', "{ cat; } <<'EOF'\ngit reset --hard\nEOF");
readsNothing('Bash', "grep -n eval 'git reset --hard'");
readsNothing('Bash', "probe hook PowerShell 'git push 2>&1 | Select-Object -Last 5'");
readsNothing('PowerShell', "powershell -File x.ps1 \"git reset --hard\"");
readsNothing('PowerShell', "pwsh -cwa 'Write-Output $args' 'git reset --hard'");
readsNothing('PowerShell', "$verbs = @('checkout', 'reset --hard'); $verbs.Count");
readsNothing('Bash', 'git reset\n  --hard'.replace('git reset', 'echo reset'));

// ---------------------------------------------------------------- the fixture

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fixture-'));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'init.defaultBranch=master',
    '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const MARKER = 'Git worktrees are disabled in this repository.\n';

function buildFixture() {
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q');
  write(path.join(seed, 'Packages/Foo.cs'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'one');
  write(path.join(seed, 'Packages/Foo.cs'), 'two\n');
  git(seed, 'commit', '-q', '-a', '-m', 'two');
  git(seed, 'branch', 'feature');
  git(seed, 'branch', 'remote-only');
  git(root, 'clone', '-q', '--bare', 'seed', 'origin.git');
  for (const name of ['shared', 'sibling']) {
    git(root, 'clone', '-q', 'origin.git', name);
    const dir = path.join(root, name);
    git(dir, 'branch', 'feature', 'origin/feature');
    write(path.join(dir, '.git/worktrees'), MARKER);
    write(path.join(dir, 'Packages/Foo.cs'), 'a peer\'s edit\n');
    write(path.join(dir, 'paths.txt'), 'Packages/Foo.cs\n');
  }
  const shared = path.join(root, 'shared');
  fs.mkdirSync(path.join(shared, 'Temp/c'), { recursive: true });
  git(shared, 'clone', '-q', '--local', '.', 'Temp/held');
  write(path.join(shared, 'enter-clone.sh'), 'cd ../clone\n');
  git(root, 'clone', '-q', '--local', 'shared', 'clone');

  // Shared repositories on other branches, and detached ones, each with local branches `feature` and
  // `other` beside the one it works on.
  const onBranch = (name, branch) => {
    const dir = path.join(root, name);
    git(root, 'clone', '-q', 'origin.git', name);
    git(dir, 'branch', '-m', 'master', branch);
    git(dir, 'branch', 'feature', 'origin/feature');
    git(dir, 'branch', 'other', 'HEAD~1');
    write(path.join(dir, '.git/worktrees'), MARKER);
    return dir;
  };
  onBranch('main', 'main');
  const trunk = onBranch('trunk', 'trunk');
  git(trunk, 'config', 'pull.rebase', 'true');
  git(trunk, 'config', 'rebase.autoStash', 'true');
  onBranch('direction', 'direction/x');
  git(onBranch('detached', 'main'), 'checkout', '-q', 'HEAD~1');
  const rebasing = onBranch('rebasing', 'trunk');
  git(rebasing, 'switch', '-q', 'feature');
  git(rebasing, 'switch', '-q', '--detach', 'trunk');
  write(path.join(rebasing, '.git/rebase-merge/head-name'), 'refs/heads/trunk\n');
  const unattached = onBranch('unattached', 'gone');
  git(unattached, 'checkout', '-q', 'HEAD~1');
  git(unattached, 'branch', '-q', '-D', 'gone');
}
buildFixture();

const contexts = {
  shared: path.join(root, 'shared'),
  clone: path.join(root, 'clone'),
  missing: path.join(root, 'missing'),
  unknown: undefined
};
for (const name of ['main', 'trunk', 'direction', 'detached', 'rebasing', 'unattached']) contexts[name] = path.join(root, name);
const payload = (shell, command, context) => {
  const body = shell === 'Bash' ? bash(command) : pwsh(command);
  if (contexts[context] !== undefined) body.cwd = contexts[context];
  return body;
};
// The decision a hook run shows: deny, save, unsaved, unplaced, notice or pass.
function decision(result) {
  if (result.verdict === 'deny') return 'deny';
  if (result.verdict === 'allow') return 'pass';
  if (result.verdict !== 'notice') return result.verdict;
  if (/saved .* under refs\/guard\//.test(result.reason)) return 'save';
  if (/could not save/.test(result.reason)) return 'unsaved';
  if (/could not tell which repository/.test(result.reason)) return 'unplaced';
  return 'notice';
}
const expectDecision = (expected, label, body) => {
  const result = run(body, hook);
  const actual = decision(result);
  if (actual === expected) ok(`[${expected}] ${label}`);
  else fail(`expected=${expected} got=${actual} : ${label} (${result.reason})`);
  return result;
};

try {
  for (const example of policy.examples) {
    const shells = example.shell === 'both' ? ['Bash', 'PowerShell'] : [example.shell];
    for (const shell of shells) {
      expectDecision(example.decision, `${shell} in ${example.context}: ${JSON.stringify(example.command)}`,
        payload(shell, example.command, example.context));
    }
  }

  // Commands the workflow runs daily pass in a shared repository.
  for (const command of daily) {
    for (const shell of ['Bash', 'PowerShell']) expectDecision('pass', `${shell} daily: ${command}`, payload(shell, command, 'shared'));
  }

  // A deny names the command, the repository and the route.
  const denied = run(payload('Bash', 'git switch -c probe', 'shared'), hook);
  if (denied.verdict === 'deny' && denied.reason.includes('git switch -c probe') && denied.reason.includes(contexts.shared) &&
    denied.reason.includes('own terminal')) ok('a deny names the command, the repository and the owner route');
  else fail(`a deny's text: ${denied.reason}`);
  // Tooling outside this repository matches this phrase in every refusal, so keep it.
  for (const rule of ['detach', 'branch', 'switch', 'worktree']) {
    if (policy.reasons[rule].includes('Agents share that repository')) ok(`the ${rule} refusal says "Agents share that repository"`);
    else fail(`the ${rule} refusal lacks "Agents share that repository"`);
  }
  // While HEAD is detached outside a rebase, a refusal ends with the way back.
  for (const [context, command, wanted, unwanted] of [
    ['detached', 'git switch feature', '`git switch main` puts it back', 'names no branch'],
    ['unattached', 'git checkout origin/master', 'names no branch that still exists', 'puts it back'],
    ['rebasing', 'git switch feature', '`git switch feature`', 'HEAD is detached now'],
    ['main', 'git switch feature', '`git switch feature`', 'HEAD is detached now']
  ]) {
    const result = run(payload('Bash', command, context), hook);
    if (result.verdict === 'deny' && result.reason.includes(wanted) && !result.reason.includes(unwanted)) ok(`a refusal in ${context} says "${wanted}"`);
    else fail(`a refusal in ${context}: ${result.reason}`);
  }

  expectDecision('deny', 'a Bash payload is read as Bash: a switch spelled with a backslash', payload('Bash', 'git sw\\itch -c probe', 'shared'));

  // A command longer than a hook reads runs with a notice, and long commands read in linear time.
  const paths = Array.from({ length: 2000 }, (_, i) => `"Packages/Foo/File${i}.cs"`).join(' ');
  const nestedGroupHeredocs = (head, depth) => {
    const levels = Array.from({ length: depth }, (_, i) => `T${i}`);
    return `${head}\n${levels.map(tag => `x { bash;pwsh;node;cmd;}<<${tag}\n`).join('')}echo a\n${levels.reverse().join('\n')}\n`;
  };
  for (const [label, command, expected, reason = ''] of [
    ['git add of 2,000 quoted paths', `git add ${paths}`, 'pass'],
    ['a command longer than a hook reads', `git add ${'a '.repeat(35000)}`, 'notice', 'characters long'],
    ['a switch before group heredocs nested 1,700 deep', nestedGroupHeredocs('git switch -c probe', 1700), 'deny'],
    ['git behind 40 --git-dir= flags', `git ${'--git-dir=x '.repeat(40)}status`, 'pass'],
    ['4,000 substitutions', `echo ${'"$(echo a)" '.repeat(4000)}`, 'pass'],
    ['a pipeline of 3,000 bash -c stages', `echo ${"| bash -c 'echo a' ".repeat(3000)}`, 'pass']
  ]) {
    for (const shell of ['Bash', 'PowerShell']) {
      const started = Date.now();
      const result = run(payload(shell, command, 'shared'), hook);
      const seconds = (Date.now() - started) / 1000;
      if (decision(result) === expected && seconds < 5 && result.reason.includes(reason)) ok(`${shell}: ${label} in ${seconds} s`);
      else fail(`${shell}: ${label} gave ${decision(result)} in ${seconds} s (${result.reason})`);
    }
  }

  // ---------------------------------------------------------------- saves

  const saveRepo = path.join(root, 'saves');
  git(root, 'init', '-q', 'saves');
  write(path.join(saveRepo, 'a.txt'), 'committed\n');
  git(saveRepo, 'add', 'a.txt');
  git(saveRepo, 'commit', '-q', '-m', 'one');
  write(path.join(saveRepo, 'a.txt'), 'staged\n');
  git(saveRepo, 'add', 'a.txt');
  write(path.join(saveRepo, 'a.txt'), 'working\n');
  git(saveRepo, 'update-ref', 'refs/guard/20200101T000000Z-1/tree', 'HEAD');
  const target = { top: saveRepo, gitDir: path.join(saveRepo, '.git'), dir: saveRepo };
  (async () => {
    try {
      const refs = await saveBefore(target, { tree: 'tracked', paths: null }, Date.now() + 20000);
      const tree = refs.find(entry => entry.ref.endsWith('/tree')).ref;
      const indexBefore = fs.readFileSync(path.join(saveRepo, '.git/index'));
      if (git(saveRepo, 'show', `${tree}:a.txt`) === 'working' && git(saveRepo, 'show', `${tree}^2:a.txt`) === 'staged') {
        ok('a guard save keeps the working file in its tree and the staged blob in its second parent');
      } else fail('a guard save lost the working file or the staged blob');
      if (git(saveRepo, 'diff', '--cached', '--name-only') === 'a.txt' && git(saveRepo, 'status', '--porcelain') === 'MM a.txt' &&
        indexBefore.equals(fs.readFileSync(path.join(saveRepo, '.git/index')))) ok('a guard save leaves the shared index as it was');
      else fail('a guard save changed the shared index');
      if (git(saveRepo, 'for-each-ref', 'refs/guard/20200101T000000Z-1/') === '') ok('a guard save deletes guard refs older than its limit');
      else fail('an old guard ref survived a save');

      try {
        await saveBefore(target, { tree: 'tracked', paths: null }, Date.now() - 1);
        fail('a save past its deadline did not fail');
      } catch (error) {
        if (error instanceof SaveFailed && /deadline/.test(error.message)) ok('a save past its deadline fails');
        else fail(`a save past its deadline failed with: ${error.message}`);
      }

      const blob = git(saveRepo, 'hash-object', '-w', 'a.txt');
      spawnSync('git', ['update-index', '--index-info'], { cwd: saveRepo, input: `0 ${'0'.repeat(40)}\ta.txt\n100644 ${blob} 1\ta.txt\n100644 ${blob} 2\ta.txt\n` });
      try {
        await saveBefore(target, { tree: 'tracked', paths: null }, Date.now() + 20000);
        fail('a save of an unmerged index did not fail');
      } catch (error) {
        if (error instanceof SaveFailed) ok(`a save of an unmerged index fails (${error.message})`);
        else fail(`a save of an unmerged index threw: ${error.message}`);
      }
      finishChecks();
    } catch (error) {
      fail(`the save checks crashed: ${error.stack}`);
      finishChecks();
    }
  })();
} catch (error) {
  fail(`the fixture checks crashed: ${error.stack}`);
  finishChecks();
}

function finishChecks() {
  // ---------------------------------------------------------------- failures

  check('allow', 'an Agent prompt, which carries no command', tool('Agent', { prompt: 'run git switch -c probe for me' }));
  check('notice', 'a Bash payload with no command runs with a notice', tool('Bash', {}));
  check('notice', 'a malformed payload runs with a notice', 'this is not json');
  check('notice', 'a non-object payload runs with a notice', '"just a string"');

  const denyCommand = payload('Bash', 'git switch -c probe', 'shared');
  const policyName = path.basename(policyFile);
  const reasonless = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  delete reasonless.reasons.branch;
  withCopy('an unreadable policy', { [policyName]: '{ not json' }, [['notice', 'a refused command', denyCommand, 'ran unchecked']]);
  withCopy('a policy with no reason text for a rule', { [policyName]: JSON.stringify(reasonless) },
    [['notice', 'a refused command', denyCommand, 'no reason text']]);
  for (const [label, files] of [
    ['a missing shared module', { 'command-hook.js': null }],
    ['a missing scanner', { 'shell-command-scan.js': null }],
    ['a missing option table', { 'git-options.json': null }],
    ['a shared module without exports', { 'command-hook.js': 'module.exports = {};' }],
    ['a scanner without exports', { 'shell-command-scan.js': 'module.exports = {};' }]
  ]) {
    withCopy(label, files, [['notice', 'a refused command', denyCommand, 'ran unchecked']]);
  }
  // Node loads a .js file as an ES module under a "type": "module" package, where the hooks crash.
  withCopy('a project whose package.json sets "type": "module"', {}, [['deny', 'a refused command', denyCommand]], '{ "type": "module" }\n');

  fs.rmSync(root, { recursive: true, force: true });
  if (failures !== 0) {
    console.log(`${failures} destructive git hook checks failed.`);
    process.exit(1);
  }
  console.log('PASS: destructive git hook checks succeeded.');
}
