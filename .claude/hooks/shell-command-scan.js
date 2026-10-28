// Reads a shell command the way its shell hands it to the programs it runs, and returns the simple
// commands it runs in run order, so a hook judges each program by the words it receives.
//
// `scanCommands(command, dialect)` returns steps. A `command` step has the words from its command
// word on, each as its program receives it: escapes resolved, quotes removed, line continuations
// joined, redirects dropped. A word the shell builds at run time (a variable, a substitution, a
// PowerShell group of anything but quoted words) is marked unknown. The step also has the words
// before its command word (Bash keywords, PowerShell's dot-source operator), the assignments written
// before it, its dialect, and where it runs:
// - `scope`: the scopes around it, outermost first. A scope is `isolated` when a directory change
//   inside it does not reach the commands after it: a Bash subshell, a substitution, a group that is
//   a pipeline stage, and every script handed to another shell, which runs as a process of its own.
// - `conditional`: it runs on only some paths: inside `if`, `case`, a loop, a function body or any
//   PowerShell block.
// - `joiner`: `&&` or `||` when it joins the command before it in one and-or list, `|` for a later
//   pipeline stage, else null. `list` numbers the and-or lists.
//
// A command's scripts come before it: a command substitution, a script handed to a shell (`bash -c`,
// `pwsh -c`, `cmd /c`, Start-Process, `env -S`, a heredoc, here-string or piped string that a shell
// reads) or to an evaluator (`eval`, `trap`, `iex`). An evaluator's script runs in the scope that
// evaluates it; its steps are marked `evaluated`. A function definition leaves a `function` step,
// and a PowerShell assignment of one plain or quoted word leaves an `assign` step.
//
// It reads Bash, PowerShell, a `cmd /c` script and a Start-Process command line. A string of an
// inline Python, Node, Perl or Ruby script is data, and what such a script runs is not a shell
// command, so their bodies are not read. Comments and the bodies of heredocs no shell reads are
// dropped.
//
// This is not a full shell parser. It does not see what a command runs from a file or from Node or
// Python code, a program, verb or alias the shell or git builds at run time (`v=reset; git $v --hard`,
// `& (Get-Command git)`, `git -c alias.x=...`), splatting (`git @a`), a script built by
// `[scriptblock]::Create` or started by `[System.Diagnostics.Process]::Start`, a process substitution
// fed to a shell (`bash <(echo ...)`), PowerShell's curly quotes, Windows PowerShell 5.1's legacy
// quoting of native arguments, a group whose output a later stage runs (`{ echo '...'; } | bash`), a
// compound command such as `if` or `for` that reads a heredoc, a function that reads the input of its
// call, or a heredoc read inside a substitution whose output a shell runs. A hook that judges by these
// steps treats what it cannot see as unknown and does not refuse on it. Keep every reading linear in
// the command's length: a hook the host times out lets the command run unchecked.

// Bash splits words only at a space, a tab and a line break.
const BASH = {
  name: 'Bash', space: /[ \t\n]/, escape: '\\', quotes: `'"`, operators: ';&|(){}', comment: true, substitution: true,
  backtickSubstitution: true, heredoc: true, pipedStrings: ['echo', 'printf'], variable: /[A-Za-z_{(0-9@*#?!$-]/
};
// A quoted part that starts a PowerShell word ends the word, and a comma is a token of its own.
// PowerShell also splits at NEL, and ends a line at a lone CR.
const POWERSHELL = {
  name: 'PowerShell', space: /[\s\u0085]/, escape: '`', quotes: `'"`, operators: ';&|(){}', comment: true, substitution: true,
  doubledQuotes: true, hereString: true, quoteEndsWord: true, commaToken: true,
  pipedStrings: ['echo', 'write', 'write-output'], variable: /[A-Za-z_{(?^$:]/
};
// The script of `cmd /c`: `^` escapes, only `"` quotes, and adjacent parts join into one word, as
// the program cmd starts splits its arguments. A `^` inside quotes is itself.
const CMD = { name: 'Cmd', space: /\s/, escape: '^', quotes: '"', operators: '&|', literalQuotes: true, percentVariables: true };
// A command line that Start-Process hands to a program, split by the C runtime's rules: only `"`
// quotes, a backslash counts only before a quote, and nothing is an operator.
const ARGV = { name: 'Argv', space: /\s/, quotes: '"', operators: '', commandLine: true };

// The options a Bash-family shell or `trap` takes before its script. `read` says how many values
// follow an option word, whether it ends the options, or the script it carries. Each `o` or `O` in
// an option word takes the next word as its value, and a lone `-`, `+` or `--` ends the options.
const BASH_OPTIONS = {
  option: /^(?:--?|\+|[-+][A-Za-z]+)$/,
  read: word => /^(?:--?|\+)$/.test(word) ? { values: 0, ends: true } : { values: (word.match(/[oO]/g) || []).length }
};

// PowerShell parameters, with their aliases and whether they take a value. A parameter binds by any
// unambiguous prefix.
const parameterTable = entries =>
  entries.map(([name, aliases, takesValue]) => ({ name, spellings: [name, ...aliases].map(s => s.toLowerCase()), takesValue }));
const COMMON_PARAMETERS = [
  ['Verbose', ['vb'], false], ['Debug', ['db'], false], ['ErrorAction', ['ea'], true], ['WarningAction', ['wa'], true],
  ['InformationAction', ['infa'], true], ['ProgressAction', ['proga'], true], ['ErrorVariable', ['ev'], true],
  ['WarningVariable', ['wv'], true], ['InformationVariable', ['iv'], true], ['OutVariable', ['ov'], true],
  ['OutBuffer', ['ob'], true], ['PipelineVariable', ['pv'], true], ['WhatIf', ['wi'], false], ['Confirm', ['cf'], false]
];

// Invoke-Expression takes -Command and the common parameters other than -WhatIf and -Confirm. A
// parameter written with a colon and nothing after it (`-ea:`) takes the next word as its value, a
// switch too. `-Command:...` carries the script, and after a bare -Command a `--` may still come
// before it.
const INVOKE_EXPRESSION_PARAMETERS = parameterTable([['Command', [], true],
  ...COMMON_PARAMETERS.filter(([name]) => name !== 'WhatIf' && name !== 'Confirm')]);
const INVOKE_EXPRESSION_OPTIONS = {
  option: /^(?:--|-[A-Za-z]+(?::[\s\S]*)?)$/,
  unquotedNamesOnly: true,
  read: word => {
    if (word === '--') return { values: 0, ends: true };
    const [, name, value] = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(word);
    const parameter = boundParameter(INVOKE_EXPRESSION_PARAMETERS, name);
    if (parameter && parameter.name === 'Command') return value ? { script: value } : { values: 0 };
    if (value !== undefined) return { values: value === '' ? 1 : 0 };
    return { values: parameter && parameter.takesValue ? 1 : 0 };
  }
};

// A flag that makes the next word a script, after an interpreter named by any earlier word of the
// same command, so wrappers such as `timeout 600` or `xargs` do not hide it. A Bash-family shell
// lets options such as `-x` or `--` sit between `-c` and its script. After a flag of an interpreter
// that `joins`, every remaining word of the command is part of the script, joined by spaces, as the
// program joins them, and the script may be attached as `-Command:...` or `/c...`. An interpreter
// that is not `argumentsOnly` also runs what a pipe or a heredoc feeds it. `evaluates` marks one
// that runs its script in the shell that calls it.
const INTERPRETERS = [
  { names: ['bash', 'sh', 'zsh', 'dash', 'ksh'], flag: /^-[A-Za-z]*c[A-Za-z]*$/, dialect: BASH, skipsOptions: BASH_OPTIONS },
  // PowerShell 7 takes `/` as well as `-` before a parameter, and any unambiguous prefix of
  // -Command, -CommandWithArgs, which runs only the next word, and -EncodedCommand, whose script is
  // base64 UTF-16. Windows PowerShell run as the command also reads its first argument that is not
  // an option as a script.
  {
    names: ['pwsh', 'powershell'], flag: /^(?:-{1,2}|\/)c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i,
    wordFlag: /^(?:-{1,2}|\/)(?:cwa|commandw(?:i(?:t(?:h(?:a(?:r(?:g(?:s)?)?)?)?)?)?)?)$/i,
    encodedFlag: /^(?:-{1,2}|\/)(?:ec?|en(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)$/i,
    dialect: POWERSHELL, joins: true
  },
  // Invoke-Expression reads its piped input as a script, in the shell that calls it.
  { names: ['invoke-expression', 'iex'], flag: /^$/, dialect: POWERSHELL, joins: true, evaluates: true },
  // Git Bash turns `//c` into `/c`.
  { names: ['cmd'], flag: /^\/\/?[ckr]$/i, attached: /^(\/\/?[ckr])([\s\S]+)$/i, dialect: CMD, joins: true },
  // `env -S` splits its argument into a command.
  { names: ['env'], flag: /^(?:-[A-Za-z]*S|--split-string)$/, dialect: BASH, argumentsOnly: true }
];

// The options of Windows PowerShell that take a value, which come before its positional script.
const POWERSHELL_VALUE_OPTIONS = /^-(?:psc|v|inp|ou|w|ex|conf)/i;

// An evaluator in its command's command-word place runs the word right after it, or with `joins`,
// every word after it joined by spaces, in the shell that calls it. The table has no prototype, so a
// word such as `constructor` names no evaluator.
const EVALUATORS = Object.assign(Object.create(null), {
  eval: { dialect: BASH, joins: true },
  trap: { dialect: BASH, skipsOptions: BASH_OPTIONS, later: true },
  iex: { dialect: POWERSHELL, skipsOptions: INVOKE_EXPRESSION_OPTIONS },
  'invoke-expression': { dialect: POWERSHELL, skipsOptions: INVOKE_EXPRESSION_OPTIONS }
});

// A Bash word after which the next word is still in the command-word place: a keyword, `!`, a builtin
// that runs the command after it, its option, or an assignment.
const BASH_PREFIX_WORD = /^(?:!|if|then|else|elif|do|while|until|time|command|builtin|exec|-[A-Za-z]+|[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=[\s\S]*)$/;
// The words after which Bash still reads a reserved word such as `}`. An assignment is not one.
const BASH_RESERVED_PREFIX = /^(?:!|if|then|else|elif|do|while|until|time)$/;
// A Bash assignment word, as a prefix of a command or on its own.
const BASH_ASSIGNMENT = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/;

// Whether Bash reads `brace` after `words` as a reserved word: where a command may start, `{` also
// after `function NAME` or `coproc`, and `}` also after a compound command's closing word (`fi }`,
// `case x in esac }`, `[[ ... ]] }`).
function bashReservedPlace(brace, words) {
  let first = 0;
  while (first < words.length &&
    (BASH_RESERVED_PREFIX.test(words[first]) || (words[first] === '-p' && words[first - 1] === 'time'))) first++;
  if (first === words.length) return true;
  if (brace === '{') return (words[0] === 'function' && words.length === 2) || words[0] === 'coproc';
  const last = words[words.length - 1];
  return (first === words.length - 1 && /^(?:fi|done|esac)$/.test(last)) ||
    (words[first] === 'case' && last === 'esac') || (words[first] === '[[' && last === ']]');
}

// A PowerShell word after which the next word is still in the command-word place: the dot-source
// operator and `return`. The call operator `&` is read where it is written.
const POWERSHELL_PREFIX_WORD = /^(?:\.|return)$/i;

// PowerShell keywords whose `(` opens a condition or a list, not an argument.
const POWERSHELL_KEYWORDS = new Set(['if', 'elseif', 'while', 'for', 'foreach', 'switch', 'until', 'catch', 'param', 'function', 'filter']);
// PowerShell keywords whose `{` opens a statement block rather than a script block argument.
const POWERSHELL_BLOCK_KEYWORDS = new Set(['do', 'else', 'try', 'finally', 'begin', 'process', 'end', 'function', 'filter', 'class', 'enum']);

// What a PowerShell `=` assigns to: a variable, maybe cast, member or index (`[int]$p`, `$a.b`), or a
// hashtable key (`@{ a = ... }`).
const POWERSHELL_ASSIGNABLE = /^(?:(?:\[[^\]]*\])*\$|[A-Za-z_]\w*$)/;

// A redirect word: an optional descriptor, the operator, and an attached target. With no attached
// target the next word is the target.
const REDIRECT = /^(?:\d+|\{\w+\}|\*)?(?:>\||>>?&?|<>|<&?|&>>?)([\s\S]*)$/;

// Start-Process joins its program and argument list into one command line.
const START_PROCESS_NAMES = ['start-process', 'start', 'saps'];
const START_PROCESS_PARAMETERS = parameterTable([
  ['FilePath', ['PSPath', 'Path'], true], ['ArgumentList', ['Args'], true], ['Credential', ['RunAs'], true],
  ['WorkingDirectory', [], true], ['LoadUserProfile', ['Lup'], false], ['NoNewWindow', ['nnw'], false],
  ['PassThru', [], false], ['RedirectStandardError', ['RSE'], true], ['RedirectStandardInput', ['RSI'], true],
  ['RedirectStandardOutput', ['RSO'], true], ['Verb', [], true], ['WindowStyle', [], true], ['Wait', [], false],
  ['UseNewEnvironment', [], false], ['Environment', [], true], ...COMMON_PARAMETERS
]);

function commandName(word) {
  return word.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

// The interpreter `word` names, or null.
function interpreterNamed(word) {
  const name = commandName(word);
  return INTERPRETERS.find(entry => entry.names.includes(name)) || null;
}

// For each index of `words`, the last interpreter named from there on that runs its input, or null.
function inputReaders(words) {
  const readers = new Array(words.length + 1).fill(null);
  for (let i = words.length - 1; i >= 0; i--) {
    const named = interpreterNamed(words[i]);
    readers[i] = readers[i + 1] || (named && !named.argumentsOnly ? named : null);
  }
  return readers;
}

// The script the words after `last` make, or null when they are text. `isCommandWord` says `last`
// is in its command's command-word place, and `interpreter` is the last one named before `last` in
// the same command.
// - `word`: the next word is the script, after any options a Bash-family shell or `trap` takes first.
// - `joined`: every remaining word is, joined by spaces.
// - `positional`: Windows PowerShell's first word that is not an option starts a joined script.
function pendingAfter(last, isCommandWord, interpreter) {
  const evaluator = EVALUATORS[commandName(last)];
  if (evaluator && isCommandWord) {
    const kind = { evaluated: true, later: Boolean(evaluator.later) };
    return evaluator.joins ? { kind: 'joined', dialect: evaluator.dialect, words: [], ...kind }
      : { kind: 'word', dialect: evaluator.dialect, skipsOptions: evaluator.skipsOptions, ...kind };
  }
  if (interpreter && interpreter.flag.test(last)) {
    return interpreter.joins ? { kind: 'joined', dialect: interpreter.dialect, words: [] }
      : { kind: 'word', dialect: interpreter.dialect, skipsOptions: interpreter.skipsOptions,
        skipValues: interpreter.skipsOptions ? interpreter.skipsOptions.read(last).values : 0 };
  }
  if (interpreter && interpreter.wordFlag && interpreter.wordFlag.test(last)) {
    return { kind: 'word', dialect: interpreter.dialect };
  }
  if (interpreter && interpreter.encodedFlag && interpreter.encodedFlag.test(last)) {
    return { kind: 'word', dialect: interpreter.dialect, encoded: true };
  }
  if (isCommandWord && commandName(last) === 'powershell') return { kind: 'positional' };
  return null;
}

// The alternatives Bash's brace expansion makes of an unquoted word, as in `git {reset,} --hard`.
function braceExpansion(word, limit = 64) {
  if (limit <= 1) return [word];
  const braces = /\{([^{}]*)\}/g;
  let match;
  while ((match = braces.exec(word)) !== null && !(match[1].includes(',') && word[match.index - 1] !== '$'));
  if (!match) return [word];
  const head = word.slice(0, match.index);
  const tail = word.slice(match.index + match[0].length);
  const alternatives = match[1].split(',');
  return alternatives.flatMap(alternative => braceExpansion(head + alternative + tail, limit / alternatives.length));
}

// The parameter of `table` a `-name` word binds, or null when none or several do.
function boundParameter(table, name) {
  const spelling = name.toLowerCase();
  const exact = table.find(parameter => parameter.spellings.includes(spelling));
  if (exact) return exact;
  const matches = table.filter(parameter => parameter.spellings.some(s => s.startsWith(spelling)));
  return matches.length === 1 ? matches[0] : null;
}

// The command line a Start-Process call hands to its program and whether it names a working
// directory, or null. `words` follow the command name, `quoted` says which started with a quote,
// and a `,` word joins its neighbors into one list.
function startProcessLine(words, quoted) {
  const bound = {};
  const positional = [];
  // One argument: a word, and every word a comma joins to it.
  const readArgument = at => {
    const elements = [words[at]];
    while (words[at + 1] === ',' && at + 2 < words.length) {
      elements.push(words[at + 2]);
      at += 2;
    }
    return { value: elements.join(' '), end: at + 1 };
  };

  let index = 0;
  // After `--` every word is positional.
  let parametersEnded = false;
  while (index < words.length) {
    const word = words[index];
    if (word === '--' && !quoted[index] && !parametersEnded) {
      parametersEnded = true;
      index++;
      continue;
    }
    const named = !parametersEnded && !quoted[index] && /^-[A-Za-z]/.test(word) ? word.slice(1).split(':') : null;
    const parameter = named && boundParameter(START_PROCESS_PARAMETERS, named[0]);
    if (parameter) {
      // A colon with nothing after it takes the next word as the value, a switch's too.
      const colonValue = named.length > 1 && named.slice(1).join(':') === '';
      if (!parameter.takesValue && !colonValue) {
        index++;
      } else if (named.length > 1 && named.slice(1).join(':') !== '') {
        // An attached value, and every element a comma joins to it.
        const argument = readArgument(index);
        bound[parameter.name] = argument.value.slice(word.indexOf(':') + 1);
        index = argument.end;
      } else if (index + 1 < words.length) {
        const argument = readArgument(index + 1);
        bound[parameter.name] = argument.value;
        index = argument.end;
      } else {
        index++;
      }
      continue;
    }

    const argument = readArgument(index);
    positional.push(argument.value);
    index = argument.end;
  }

  const program = bound.FilePath !== undefined ? bound.FilePath : positional.shift();
  if (program === undefined) return null;
  const argumentList = bound.ArgumentList !== undefined ? bound.ArgumentList : positional.shift();
  return { line: `"${program}" ${argumentList || ''}`, elsewhere: bound.WorkingDirectory !== undefined };
}

// A heredoc operator, whether it strips leading tabs, and its delimiter word, which is quoted when
// any part of it is.
const HEREDOC = /<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\[^\n]|[^\s;&|<>()'"\\])+)/y;

// PowerShell blank space and comments.
const BLANK_RUN = /(?:[\s\u0085]|#[^\r\n]*|<#[\s\S]*?#>)*/y;

// The end of a PowerShell comment's line.
const COMMENT_END = /[\r\n]/g;

// The characters PowerShell reads as a parameter's dash.
const POWERSHELL_DASHES = '\u2013\u2014\u2015';

// The rest of the line a PowerShell here-string opens.
const HERE_STRING_OPEN = /[ \t]*\r?\n/y;

// The PowerShell escapes that stand for a control character.
const POWERSHELL_CONTROLS = { 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

// The character a PowerShell backtick escape at `index` stands for, and its length.
function powershellEscape(source, index) {
  const next = source[index + 1];
  if (next === 'u' && source[index + 2] === '{') {
    const close = source.indexOf('}', index + 3);
    const digits = close === -1 ? '' : source.slice(index + 3, close);
    const code = /^[0-9A-Fa-f]{1,6}$/.test(digits) ? parseInt(digits, 16) : NaN;
    if (code <= 0x10FFFF) {
      return { char: String.fromCodePoint(code), length: close + 1 - index };
    }
  }
  if (Object.prototype.hasOwnProperty.call(POWERSHELL_CONTROLS, next)) {
    return { char: POWERSHELL_CONTROLS[next], length: 2 };
  }
  return { char: next, length: 2 };
}

// The character an escape inside Bash's `$'...'` at `index` stands for, and its length.
const ANSI_C_LETTERS = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
function ansiCEscape(source, index) {
  const rest = source.slice(index + 1);
  const numeric = rest.match(/^x([0-9A-Fa-f]{1,2})/) || rest.match(/^u([0-9A-Fa-f]{1,4})/) ||
    rest.match(/^U([0-9A-Fa-f]{1,8})/);
  if (numeric) {
    const code = parseInt(numeric[1], 16);
    return { char: code <= 0x10FFFF ? String.fromCodePoint(code) : '_', length: numeric[0].length + 1 };
  }
  const octal = rest.match(/^[0-7]{1,3}/);
  if (octal) return { char: String.fromCharCode(parseInt(octal[0], 8) & 0xFF), length: octal[0].length + 1 };
  const control = rest.match(/^c(.)/);
  if (control) return { char: String.fromCharCode(control[1].charCodeAt(0) & 0x1F), length: 3 };
  const letter = rest[0];
  return { char: Object.prototype.hasOwnProperty.call(ANSI_C_LETTERS, letter) ? ANSI_C_LETTERS[letter] : letter, length: 2 };
}

// The Windows C runtime reads a run of backslashes before a quote as half as many backslashes, and
// an odd run escapes the quote. Elsewhere a backslash is itself. Returns the run's length, the
// backslashes it stands for, and whether it ends in an escaped quote.
function backslashRun(source, index) {
  let end = index;
  while (source[end] === '\\') end++;
  const count = end - index;
  if (source[end] !== '"') return { length: count, literal: '\\'.repeat(count), quote: false };
  const escapesQuote = count % 2 === 1;
  return { length: count + (escapesQuote ? 1 : 0), literal: '\\'.repeat(count >> 1) + (escapesQuote ? '"' : ''), quote: escapesQuote };
}

const DIALECTS = { Bash: BASH, PowerShell: POWERSHELL };

function scanCommands(command, shell) {
  const dialect = DIALECTS[shell];
  if (!dialect) throw new Error(`no dialect named ${shell}`);
  return walk(command, 0, dialect, false, { scope: [], conditional: false, evaluated: false }).steps;
}

// Walks `source` from `start` and returns its steps and the index it stopped at. Inside a
// substitution or a group it stops after the `)` that closes it, and also returns the group's words
// and whether every one of them was quoted, which makes them its value. `context` is where its
// commands run: the scopes around the source, whether it runs on only some paths, and whether an
// evaluator runs it.
function walk(source, start, dialect, inSubstitution, context) {
  // The steps of the finished commands, and the steps of the current command's scripts, which go
  // before the command when it ends.
  const steps = [];
  let commandSteps = [];
  let commandOpen = false;
  const groupWords = [];
  let allQuoted = true;
  // The words of the current command, which of them started with a quote, which the shell builds at
  // run time, which start with an unquoted `~`, which are redirect targets, and the words of its
  // whole pipeline. A reset starts a new array, so a heredoc keeps the pipeline it was written in.
  let words = [];
  let quotedWords = [];
  let unknownWords = [];
  let tildeWords = [];
  let redirectWords = [];
  // The index in `words` of the command word, after Bash's keywords, `time` and assignments.
  let commandIndex = 0;
  // The last interpreter the command's words name, kept as words arrive so a long command costs
  // linear time.
  let interpreter = null;
  let pipeline = [];
  // Where the current command's words start in `pipeline`.
  let stageStart = 0;
  let word = null;
  let wordQuoted = false;
  let wordUnknown = false;
  let wordHasQuotedPart = false;
  // How many characters of the word come before its first quoted or escaped part.
  let wordPlainLength = Infinity;
  // The script the words so far start (`pendingAfter`). A script word is the whole word, because
  // adjacent quoted parts such as `'a''b'` make one argument.
  let pending = null;
  // Whether the last token was a pipe, so a group or block that follows it reads the pipe.
  let afterPipe = false;
  // Texts some later stage may read from stdin, each with the index in `pipeline` of the first
  // stage that reads it.
  let piped = [];
  let hereStringNext = false;
  // Whether the last token continues the statement on the next line: a pipe, `&&`, `||`, or a
  // PowerShell comma, which joins the next line's element to its list.
  let lineOpen = false;
  // Where the blank space and comments after the last PowerShell line break end.
  let blankRunEnd = -1;
  let depth = 0;
  // Whether the last token closed a Bash group or subshell, until the next operator, line break, or
  // a word Bash does not allow after a group. A heredoc or here-string written there is the group's
  // input, as in `{ bash; } <<'EOF'`. It is read by the last interpreter an earlier command named
  // that reads its input, which may be one outside the group.
  let afterGroup = false;
  let redirectTargetNext = false;
  let lastReader = null;
  let hereStringGroupReader = null;
  const groupInputReader = () => afterGroup ? lastReader : null;
  let heredocs = [];
  // The index just past the last unquoted, unescaped character, and that character: the `&` of `>&`
  // or `<&` and the `|` of `>|` belong to a redirect only right after one.
  let plainEnd = -1;
  let plainChar = '';
  let index = start;

  // Where the commands run. `openScopes` are the scopes this walk opened (Bash groups and
  // subshells), each with whether it is a function body and whether a paren opened it; `conditions`
  // counts the compound commands and PowerShell blocks open around the current command.
  const openScopes = [];
  let conditions = 0;
  let functionBodies = 0;
  // The joiner for the next command, the and-or list number, and the steps of the current pipeline.
  let joiner = null;
  let listNumber = 0;
  // Where the current and-or list began in `steps`, per scope depth.
  const listStarts = new Map();
  let pipelineSteps = [];
  let lastEmitted = null;
  let lastClosedScope = null;
  // A function header was read, so the next group or subshell is its body.
  let functionNext = false;
  // The PowerShell variable an `=` assigns, whose value is the next command.
  let assignee = null;

  const currentScope = () => [...context.scope, ...openScopes.map(entry => entry.scope)];
  const isConditional = () => context.conditional || conditions > 0 || functionBodies > 0 ||
    openScopes.some(entry => entry.conditional);

  // A script's steps go right before the command that runs it, or at the end with no command open.
  const runBeforeCommand = scriptSteps => {
    if (commandOpen) commandSteps.push(...scriptSteps);
    else steps.push(...scriptSteps);
  };
  // `evaluated` scripts run in this shell's scope; every other script is a process of its own.
  const addScript = (body, bodyDialect, how = {}) => {
    const scope = how.evaluated ? currentScope() : [...currentScope(), { isolated: true }];
    const conditional = isConditional() || Boolean(how.later);
    const nested = walk(body, 0, bodyDialect, false, { scope, conditional, evaluated: Boolean(how.evaluated) || context.evaluated });
    for (const step of nested.steps) {
      if (how.elsewhere) step.elsewhere = true;
      if (how.evaluated) step.evaluated = true;
    }
    runBeforeCommand(nested.steps);
  };
  const startWord = quoted => {
    if (!commandOpen) {
      commandOpen = true;
    }
    word = '';
    wordQuoted = quoted;
    wordUnknown = false;
    wordHasQuotedPart = quoted;
    wordPlainLength = quoted ? 0 : Infinity;
  };
  const pushWord = (value, quoted, flags = {}) => {
    interpreter = interpreterNamed(value) || interpreter;
    words.push(value);
    quotedWords.push(quoted);
    unknownWords.push(Boolean(flags.unknown));
    tildeWords.push(Boolean(flags.tilde));
    redirectWords.push(Boolean(flags.redirect));
    pipeline.push(value);
    afterPipe = false;
    if (value !== ',') {
      groupWords.push(value);
      if (!quoted) allQuoted = false;
    }
  };
  // Hands `value` to the script the words before it start, if any.
  const readScriptWord = (value, plainLength) => {
    // An attached script, as in `-Command:...` or `cmd /c...`.
    if ((!pending || pending.kind !== 'joined') && interpreter && interpreter.joins && !interpreter.evaluates) {
      const attached = /^([-/][^:]+):([\s\S]+)$/.exec(value) || (interpreter.attached && interpreter.attached.exec(value));
      if (attached && interpreter.flag.test(attached[1])) {
        pending = { kind: 'joined', dialect: interpreter.dialect, words: [attached[2]] };
        return;
      }
    }

    if (!pending) return;
    if (pending.kind === 'joined') {
      pending.words.push(value);
    } else if (pending.skipValues > 0) {
      pending.skipValues--;
    } else if (pending.kind === 'word') {
      const nameEnd = value.includes(':') ? value.indexOf(':') + 1 : value.length;
      const options = pending.optionsEnded || (pending.skipsOptions && pending.skipsOptions.unquotedNamesOnly && plainLength < nameEnd)
        ? null : pending.skipsOptions;
      const option = options && options.option.test(value) ? options.read(value) : null;
      if (option && option.script !== undefined) {
        addScript(option.script, pending.dialect, pending);
        pending = null;
      } else if (option) {
        pending.skipValues = option.values;
        pending.optionsEnded = Boolean(option.ends);
      } else {
        addScript(pending.encoded ? Buffer.from(value, 'base64').toString('utf16le') : value, pending.dialect, pending);
        pending = null;
      }
    } else {
      // Windows PowerShell's options, -Command and -EncodedCommand among them, come before its
      // positional script.
      const flagged = pendingAfter(value, false, interpreter);
      if (flagged) {
        pending = flagged;
      } else if (/^-f/i.test(value)) {
        // After -File every word is the script file's argument.
        pending = null;
      } else if (value.startsWith('-')) {
        pending.skipValues = POWERSHELL_VALUE_OPTIONS.test(value) ? 1 : 0;
      } else {
        pending = { kind: 'joined', dialect: POWERSHELL, words: [value] };
      }
    }
  };
  const endWord = () => {
    if (word !== null) {
      let values = [word];
      if (dialect === BASH && !wordQuoted && !wordHasQuotedPart && !wordUnknown) {
        const alternatives = braceExpansion(word);
        if (alternatives.length > 1) values = alternatives;
      }
      const hereStringWord = hereStringNext;
      if (hereStringNext) {
        piped.push({ text: values.join(' '), reader: stageStart });
        if (hereStringGroupReader) addScript(values.join(' '), hereStringGroupReader.dialect);
      }
      hereStringNext = false;
      const tilde = dialect === BASH && !wordQuoted && wordPlainLength > 0 && word.startsWith('~');
      for (const value of values) {
        // Bash allows only redirects after a group: a redirect word and its target, the fd number
        // before a heredoc or here-string, and a here-string's word.
        if (afterGroup && !hereStringWord) {
          if (redirectTargetNext) redirectTargetNext = false;
          else if (/^(?:\d+|\{\w+\})?(?:[<>]|&>)/.test(value)) redirectTargetNext = /^(?:\d+|\{\w+\})?(?:[<>]+|>\||&>>?)&?$/.test(value);
          else if (!/^(?:\d+|\{\w+\})$/.test(value)) afterGroup = false;
        }
        readScriptWord(value, wordPlainLength);
        if (!pending) pending = pendingAfter(value, words.length === commandIndex, interpreter);
        pushWord(value, wordQuoted, { unknown: wordUnknown, tilde, redirect: hereStringWord });
        const prefix = dialect === BASH ? BASH_PREFIX_WORD : dialect === POWERSHELL ? POWERSHELL_PREFIX_WORD : null;
        if (prefix && !wordQuoted && words.length - 1 === commandIndex && prefix.test(value)) {
          commandIndex++;
        }
      }
    }
    word = null;
  };

  // The command's words, from its command word on, without redirects and their targets.
  const commandWords = () => {
    const kept = { words: [], unknown: [], quoted: [], tilde: [] };
    for (let i = commandIndex; i < words.length; i++) {
      if (redirectWords[i]) continue;
      const redirect = !quotedWords[i] && dialect !== ARGV ? REDIRECT.exec(words[i]) : null;
      if (redirect) {
        if (redirect[1] === '') i++;
        continue;
      }
      kept.words.push(words[i]);
      kept.unknown.push(unknownWords[i]);
      kept.quoted.push(quotedWords[i]);
      kept.tilde.push(tildeWords[i]);
    }
    return kept;
  };
  const emit = step => {
    steps.push(...commandSteps, step);
    commandSteps = [];
    pipelineSteps.push(step);
    lastEmitted = step;
  };
  // Emits the current command. Bash's compound-command keywords open and close conditions around it.
  const emitCommand = () => {
    const head = words[commandIndex];
    const headName = head === undefined ? '' : head.toLowerCase();
    if (dialect === BASH) {
      for (let i = 0; i < commandIndex; i++) {
        if (!quotedWords[i] && /^(?:if|while|until)$/.test(words[i])) conditions++;
      }
      if (head !== undefined && !quotedWords[commandIndex] && /^(?:for|select|case)$/.test(head)) conditions++;
    }
    const assignments = [];
    for (let i = 0; i < commandIndex; i++) {
      const match = dialect === BASH && !quotedWords[i] ? BASH_ASSIGNMENT.exec(words[i]) : null;
      if (match) assignments.push({ name: match[1], value: match[2], unknown: unknownWords[i] });
    }
    const where = {
      dialect: dialect.name, scope: currentScope(), conditional: isConditional(), joiner, list: listNumber,
      evaluated: context.evaluated
    };
    const powershellFunction = dialect === POWERSHELL && (headName === 'function' || headName === 'filter');
    if ((dialect === BASH && headName === 'function' && !quotedWords[commandIndex]) || powershellFunction) {
      emit({ kind: 'function', ...where });
      functionNext = true;
    } else if (head === undefined) {
      if (assignments.length > 0) {
        for (const assignment of assignments) emit({ kind: 'assign', ...assignment, ...where });
      } else if (commandSteps.length > 0) {
        steps.push(...commandSteps);
        commandSteps = [];
      }
    } else if (assignee !== null && words.length - commandIndex === 1 && commandSteps.length === 0) {
      emit({ kind: 'assign', name: assignee, value: head, unknown: unknownWords[commandIndex], ...where });
    } else {
      const kept = commandWords();
      if (kept.words.length > 0) emit({ kind: 'command', prefix: words.slice(0, commandIndex), assignments, ...kept, ...where });
      else {
        steps.push(...commandSteps);
        commandSteps = [];
      }
      if (assignee !== null) emit({ kind: 'assign', name: assignee, value: '', unknown: true, ...where });
    }
    assignee = null;
    if (dialect === BASH && head !== undefined && !quotedWords[commandIndex] && /^(?:fi|done|esac)$/.test(head)) {
      conditions = Math.max(0, conditions - 1);
    }
  };
  const endCommand = () => {
    endWord();
    if (pending && pending.kind === 'joined' && pending.words.length > 0) addScript(pending.words.join(' '), pending.dialect, pending);
    if (dialect.heredoc) lastReader = inputReaders(words)[0] || lastReader;

    if (dialect === POWERSHELL && words.length > commandIndex && START_PROCESS_NAMES.includes(commandName(words[commandIndex]))) {
      const started = startProcessLine(words.slice(commandIndex + 1), quotedWords.slice(commandIndex + 1));
      if (started) addScript(started.line, ARGV, { elsewhere: started.elsewhere });
    }

    // What a stage writes to its output: the arguments of a `pipedStrings` command, or a bare string that
    // starts a PowerShell pipeline. It is a script when a later stage names an interpreter.
    if (dialect.pipedStrings && words.length > commandIndex) {
      const name = commandName(words[commandIndex]);
      if (dialect.pipedStrings.includes(name)) {
        const output = words.slice(commandIndex + 1).join(' ');
        piped.push({ text: name === 'printf' ? output.replace(/\\n/g, '\n') : output, reader: pipeline.length });
      } else if (dialect === POWERSHELL && quotedWords[0] && stageStart === 0) {
        piped.push({ text: words.join(' '), reader: pipeline.length });
      }
    }

    if (commandOpen || words.length > 0) emitCommand();
    else if (commandSteps.length > 0) {
      steps.push(...commandSteps);
      commandSteps = [];
    }

    words = [];
    quotedWords = [];
    unknownWords = [];
    tildeWords = [];
    redirectWords = [];
    commandIndex = 0;
    interpreter = null;
    pending = null;
    stageStart = pipeline.length;
    commandOpen = false;
  };
  // Hands a text a stage writes or a heredoc feeds to the interpreter that reads it, per
  // `inputReaders` of its pipeline. The substitutions of an unquoted heredoc run in any case. The
  // script's steps go before `reader`, the step of the stage that runs it, when it is known.
  const readPiped = (entry, readers, readerStep = null) => {
    const reader = readers[entry.reader];
    const at = readerStep ? steps.lastIndexOf(readerStep) : -1;
    const tail = at >= 0 ? steps.splice(at) : [];
    if (reader) addScript(entry.text, reader.dialect, { evaluated: Boolean(reader.evaluates) });
    if (entry.substitutions) runBeforeCommand(entry.substitutions);
    steps.push(...tail);
  };
  // Ends the pipeline. A Bash `&` after it runs its and-or list in a background subshell, so every
  // step of the list at this depth or below, groups included, gets an isolated scope of its own.
  const endPipeline = (background = false) => {
    endCommand();
    if (background) {
      const outer = currentScope();
      const subshell = { isolated: true };
      for (let i = listStarts.get(outer.length) || 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.dialect !== BASH.name || !step.scope || step.scope.length < outer.length) continue;
        if (outer.every((scope, at) => step.scope[at] === scope)) step.scope = [...outer, subshell, ...step.scope.slice(outer.length)];
      }
    }
    if (piped.length > 0) {
      const readers = inputReaders(pipeline);
      for (const entry of piped) readPiped(entry, readers, pipelineSteps[pipelineSteps.length - 1]);
    }
    piped = [];
    pipeline = [];
    pipelineSteps = [];
    stageStart = 0;
    afterPipe = false;
    afterGroup = false;
  };
  // A substitution in the current word: an unknown part of the word, and its steps before the command.
  const substitute = substitutionSteps => {
    if (word === null) startWord(false);
    runBeforeCommand(substitutionSteps);
    word += '$()';
    wordUnknown = true;
  };
  // The steps of a substitution's source, which runs in a subshell of its own in Bash and in the
  // calling scope in PowerShell.
  const substitutionContext = () => ({
    scope: dialect === BASH ? [...currentScope(), { isolated: true }] : currentScope(),
    conditional: isConditional(), evaluated: context.evaluated
  });
  // Joins a new command to the list: the joiner an operator set, a new list after anything else.
  const noteJoiner = value => {
    joiner = value;
    if (value === null) {
      listNumber++;
      listStarts.set(currentScope().length, steps.length);
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (!dialect.space.test(char) && char !== '#' && !(char === '<' && next === '#')) lineOpen = false;
    const lineBreak = char === '\n' || (dialect === POWERSHELL && char === '\r' && next !== '\n');
    if (lineBreak && !dialect.commandLine) {
      // PowerShell 7 also continues a pipeline on a line that starts with `|`, past comment lines. The
      // scanner also skips blank lines, which PowerShell rejects there. Line breaks inside one blank
      // run share its end, so a long run is read once.
      if (dialect === POWERSHELL && index + 1 > blankRunEnd) {
        BLANK_RUN.lastIndex = index + 1;
        BLANK_RUN.exec(source);
        blankRunEnd = BLANK_RUN.lastIndex;
      }
      const continues = lineOpen || (dialect === POWERSHELL && source[blankRunEnd] === '|' && source[blankRunEnd + 1] !== '|');
      endWord();
      index++;
      // A heredoc is a script when a word of the stages that read it, its own and the later ones,
      // names an interpreter (`bash -s <<'EOF'`, `cat <<EOF | bash`). When the pipeline it was
      // written in is still open, its later stages may follow on the next lines.
      for (const heredoc of heredocs) {
        const body = readHeredocBody(source, index, heredoc.tag, heredoc.stripsTabs);
        const entry = {
          text: body.text, reader: heredoc.reader,
          substitutions: heredoc.quoted ? [] : bodySubstitutions(body.text, dialect, substitutionContext())
        };
        if (heredoc.groupReader) addScript(body.text, heredoc.groupReader.dialect);
        if (heredoc.pipeline === pipeline) piped.push(entry);
        else readPiped(entry, inputReaders(heredoc.pipeline));
        index = body.end;
      }
      heredocs = [];
      if (!continues) {
        endPipeline();
        noteJoiner(null);
      }
      continue;
    }

    if (dialect.space.test(char)) {
      endWord();
      index++;
      continue;
    }

    // A comment runs to the end of its line and never runs. It starts a word that follows a space
    // or an operator. Bash's braces are operators only as whole words, and never start a comment.
    const previous = source[index - 1];
    const commentAfter = dialect === BASH ? /[ \t\n;&|()<>]/ : /[\s\u0085;&|(){}]/;
    if (dialect.comment && char === '#' && word === null && (index === start || commentAfter.test(previous))) {
      // A PowerShell comment also ends at a lone CR.
      COMMENT_END.lastIndex = index;
      const end = dialect === POWERSHELL ? (COMMENT_END.exec(source) || { index: -1 }).index : source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (dialect === POWERSHELL && char === '<' && next === '#' && word === null) {
      const end = source.indexOf('#>', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    // After PowerShell's `--%`, the rest of the line up to a pipe is the program's arguments as written.
    if (dialect === POWERSHELL && word === null && source.startsWith('--%', index) && !/\S/.test(source[index + 3] || ' ')) {
      let stop = index + 3;
      while (stop < source.length && source[stop] !== '|' && source[stop] !== '\n') stop++;
      for (const argument of source.slice(index + 3, stop).split(/\s+/).filter(Boolean)) {
        startWord(false);
        word = argument;
        wordUnknown = /%\w+%/.test(argument);
        endWord();
      }
      index = stop;
      continue;
    }

    if (dialect.commandLine && char === '\\') {
      const run = backslashRun(source, index);
      if (word === null) startWord(false);
      word += run.literal;
      index += run.length;
      continue;
    }

    if (char === dialect.escape && index + 1 < source.length) {
      const lineBreak = next === '\n' ? 2 : next === '\r' && source[index + 2] === '\n' ? 3 : 0;
      if (lineBreak && dialect !== POWERSHELL) {
        // Bash and cmd delete an escaped line break, inside a word too.
        index += lineBreak;
        continue;
      }
      if (lineBreak && word === null) {
        // A PowerShell line continuation.
        index += lineBreak;
        continue;
      }
      // Inside a PowerShell word, backtick plus CR puts a CR into the word, and the LF after it
      // ends the statement.
      const escaped = dialect === POWERSHELL ? powershellEscape(source, index) : { char: next, length: 2 };
      if (word === null) startWord(false);
      wordPlainLength = Math.min(wordPlainLength, word.length);
      wordHasQuotedPart = true;
      word += escaped.char;
      index += escaped.length;
      continue;
    }

    // A here-string's word is the command's input, and the next line is a new command.
    if (dialect.heredoc && char === '<' && next === '<' && source[index + 2] === '<') {
      endWord();
      hereStringNext = true;
      hereStringGroupReader = groupInputReader();
      index += 3;
      continue;
    }

    if (dialect.heredoc && char === '<' && next === '<') {
      HEREDOC.lastIndex = index;
      const match = HEREDOC.exec(source);
      if (match) {
        endWord();
        // Bash removes the quotes of the whole delimiter word, and the `$` of a `$'...'` or `$"..."` part.
        const tag = match[2].replace(/\$?'([^']*)'|\$?"([^"]*)"|\\(.)/g, (all, single, double, escaped) =>
          single !== undefined ? single : double !== undefined ? double : escaped);
        heredocs.push({ tag, stripsTabs: match[1] === '-', quoted: /['"\\]/.test(match[2]), pipeline, reader: stageStart,
          groupReader: groupInputReader() });
        index += match[0].length;
        continue;
      }
    }

    if (dialect.commaToken && char === ',') {
      endWord();
      pushWord(',', false);
      lineOpen = true;
      index++;
      continue;
    }

    // A PowerShell assignment's value is a pipeline of its own, as in `$p = Start-Process ...`,
    // `$p=...` or `$p += ...`.
    const assigned = dialect !== POWERSHELL || char !== '=' || next === '=' ? null
      : words.length === 0 ? word
      : words.length === 1 && (word === null || /^[-+*/%?]+$/.test(word)) ? words[0] : null;
    if (assigned !== null && POWERSHELL_ASSIGNABLE.test(assigned)) {
      // The assignee is no stage of the pipeline, so a string after `=` starts it.
      word = null;
      pipeline.length = stageStart;
      words = [];
      quotedWords = [];
      unknownWords = [];
      tildeWords = [];
      redirectWords = [];
      commandOpen = false;
      endCommand();
      assignee = assigned.startsWith('$') ? assigned : null;
      index++;
      continue;
    }

    // PowerShell's `&` before a command's first word calls the command; anywhere else it is an operator.
    if (dialect === POWERSHELL && char === '&' && word === null && words.length === 0 && next !== '&' && source[index - 1] !== '&') {
      index++;
      continue;
    }

    // Bash's `$'...'` is a quote that resolves escapes, and `$"..."` a double quote.
    const ansiC = dialect === BASH && char === '$' && (next === "'" || next === '"');
    const quoted = readQuoted(source, ansiC ? index + 1 : index, dialect, substitutionContext());
    if (quoted) {
      const startsWord = word === null;
      if (startsWord) startWord(true);
      runBeforeCommand(quoted.substitutions);
      wordPlainLength = Math.min(wordPlainLength, word.length);
      wordHasQuotedPart = true;
      if (quoted.expanded) wordUnknown = true;
      word += quoted.literal;
      index = quoted.end;

      if (startsWord && dialect.quoteEndsWord) endWord();
      continue;
    }

    // Bash's `${...}` is part of its word, and the substitutions inside it run.
    if (dialect === BASH && char === '$' && next === '{') {
      const end = braceEnd(source, index + 1);
      if (word === null) startWord(false);
      runBeforeCommand(bodySubstitutions(source.slice(index + 2, end - 1), dialect, substitutionContext()));
      word += source.slice(index, end);
      wordUnknown = true;
      index = end;
      continue;
    }

    // A PowerShell `(...)` or `@(...)` in an argument's place is one argument, whose value is its
    // words joined by spaces. Its commands run, so it reads as a substitution does, and as its words
    // when every one of them is quoted, as in `git ("reset") --hard`.
    const attachedValue = dialect === POWERSHELL && '(@'.includes(char) && word !== null && /^-[^:]+:$/.test(word);
    const arrayGroup = dialect === POWERSHELL && char === '@' && next === '(' && (word === null || attachedValue);
    const argumentGroup = dialect === POWERSHELL && char === '(' && (word === null
      ? words.length > 0 && !POWERSHELL_KEYWORDS.has(words[0].toLowerCase())
      : EVALUATORS[commandName(word)] !== undefined || attachedValue);
    if (arrayGroup || argumentGroup) {
      endWord();
      const nested = walk(source, index + (arrayGroup ? 2 : 1), dialect, true, substitutionContext());
      startWord(true);
      const quotedList = nested.allQuoted && nested.words.length > 0;
      runBeforeCommand(nested.steps);
      word = nested.words.join(' ');
      wordUnknown = !quotedList;
      endWord();
      index = nested.end;
      continue;
    }

    // Arithmetic runs no command, and its `<<` is a shift. Bash reads `((` as arithmetic when the
    // inner parenthesis closes right before the outer one, and as two subshells otherwise.
    if (dialect === BASH && char === '$' && next === '(' && source[index + 2] === '(') {
      const end = arithmeticEnd(source, index + 1);
      if (word === null) startWord(false);
      word += '$(())';
      wordUnknown = true;
      index = end;
      continue;
    }
    if (dialect === BASH && char === '(' && next === '(' && word === null) {
      const end = arithmeticEnd(source, index);
      if (arithmeticEnd(source, index + 1) === end - 1) {
        index = end;
        continue;
      }
    }

    if (dialect.substitution && char === '$' && next === '(') {
      const nested = walk(source, index + 2, dialect, true, substitutionContext());
      if (dialect === POWERSHELL && nested.allQuoted && nested.words.length > 0) {
        // A PowerShell subexpression of quoted words is their value, as a group's is.
        if (word === null) startWord(false);
        runBeforeCommand(nested.steps);
        word += nested.words.join(' ');
      } else {
        substitute(nested.steps);
      }
      index = nested.end;
      continue;
    }

    if (dialect.backtickSubstitution && char === '`') {
      const end = source.indexOf('`', index + 1);
      substitute(walk(source.slice(index + 1, end === -1 ? source.length : end), 0, dialect, false, substitutionContext()).steps);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    if (char === ')' && depth === 0 && inSubstitution) {
      endPipeline();
      return { steps, end: index + 1, words: groupWords, allQuoted };
    }

    // A Bash function header, `name()` or `function name()`: the name is no command, and the group
    // or subshell after it is the body, which runs only when something calls it.
    if (dialect === BASH && char === '(' && /^[ \t]*\)/.test(source.slice(index + 1, index + 64))) {
      const pendingWords = words.length - commandIndex + (word !== null ? 1 : 0);
      const named = words[commandIndex] === 'function' ? pendingWords === 2 : pendingWords === 1;
      if (named) {
        word = null;
        words = [];
        quotedWords = [];
        unknownWords = [];
        tildeWords = [];
        redirectWords = [];
        commandIndex = 0;
        commandOpen = false;
        emit({ kind: 'function', dialect: dialect.name, scope: currentScope(), conditional: isConditional(), joiner, list: listNumber, evaluated: context.evaluated });
        functionNext = true;
        index = source.indexOf(')', index) + 1;
        continue;
      }
    }

    // Bash reads a brace as a reserved word only as a whole word where a command may start, `{` also
    // after `function NAME` or `coproc`, and `}` also after a compound command's last reserved word
    // (`fi }`) or a `[[ ... ]]`. `}` may end right before a redirect, and a line continuation after
    // a brace keeps it whole. Anywhere else a brace is part of a word, as in `xargs -I { bash -c {`.
    const continued = next === '\\' && /^\r?\n/.test(source.slice(index + 2, index + 4));
    const reservedPlace = dialect === BASH && word === null && '{}'.includes(char) && bashReservedPlace(char, words);
    const braceWord = reservedPlace && (next === undefined || continued ||
      (char === '{' ? /\s/ : /[\s;&|)<>]/).test(next));
    // The `&` of a redirect (`2>&1`, `>&`, Bash's `&>`) and the `|` of Bash's `>|` are part of
    // its word.
    const afterRedirect = plainEnd === index && '<>'.includes(plainChar);
    const redirectPart = (char === '&' && (afterRedirect || (dialect === BASH && next === '>'))) ||
      (dialect === BASH && char === '|' && afterRedirect && plainChar === '>');
    const operator = !redirectPart && dialect.operators.includes(char) && !(dialect === BASH && '{}'.includes(char) && !braceWord);
    if (operator) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      // A single `|` or Bash's `|&` continues the pipeline, `||` does not. So does a group or block
      // right after a pipe, and a PowerShell script block that is a command's argument, as in
      // `ForEach-Object { iex $_ }`, whose commands read the pipe.
      const pipe = (char === '|' && next !== '|' && source[index - 1] !== '|') ||
        (char === '&' && source[index - 1] === '|' && source[index - 2] !== '|');
      const readsPipe = ('({'.includes(char) && afterPipe) || (dialect === POWERSHELL && char === '{' &&
        word === null && words.length > 0 && !POWERSHELL_BLOCK_KEYWORDS.has(words[0].toLowerCase()));
      // A PowerShell `{` right after `=` is a script block stored for a later call.
      const storedBlock = dialect === POWERSHELL && char === '{' && word === null && words.length === 0 && assignee !== null;
      const pipedGroup = afterPipe && '({'.includes(char);
      if (pipe || readsPipe) endCommand();
      else endPipeline(dialect === BASH && char === '&' && next !== '&' && source[index - 1] !== '&');
      if (storedBlock) {
        emit({ kind: 'function', dialect: dialect.name, scope: currentScope(), conditional: isConditional(), joiner, list: listNumber, evaluated: context.evaluated });
        assignee = null;
      }

      if (pipe) {
        if (lastEmitted) lastEmitted.piped = true;
        if (afterGroup && lastClosedScope) lastClosedScope.isolated = true;
        joiner = '|';
      } else if (char === '&' && source[index - 1] === '&') {
        noteJoiner('&&');
      } else if (char === '|' && source[index - 1] === '|') {
        noteJoiner('||');
      } else if (char === ';' || (char === '&' && next !== '&' && !pipe)) {
        if (!(char === '&' && next === '&')) noteJoiner(null);
      }

      // A group after `&&` or `||` runs on only some paths.
      const joined = joiner === '&&' || joiner === '||';
      if (dialect === BASH && char === '(') {
        openScopes.push({ scope: { isolated: true }, paren: true, body: functionNext, conditional: joined });
        if (functionNext) functionBodies++;
        functionNext = false;
      } else if (dialect === BASH && char === ')' && openScopes.length > 0 && openScopes[openScopes.length - 1].paren) {
        const closed = openScopes.pop();
        if (closed.body) functionBodies--;
        lastClosedScope = closed.scope;
      } else if (dialect === BASH && char === '{') {
        openScopes.push({ scope: { isolated: pipedGroup }, paren: false, body: functionNext, conditional: joined });
        if (functionNext) functionBodies++;
        functionNext = false;
      } else if (dialect === BASH && char === '}' && openScopes.length > 0 && !openScopes[openScopes.length - 1].paren) {
        const closed = openScopes.pop();
        if (closed.body) functionBodies--;
        lastClosedScope = closed.scope;
      } else if (dialect === POWERSHELL && char === '{') {
        conditions++;
        functionNext = false;
      } else if (dialect === POWERSHELL && char === '}') {
        conditions = Math.max(0, conditions - 1);
      }

      afterPipe = pipe || readsPipe;
      afterGroup = Boolean(dialect.heredoc) && ')}'.includes(char);
      redirectTargetNext = false;
      lineOpen = char === '|' || (char === '&' && (previous === '&' || previous === '|'));
      index++;
      continue;
    }

    // A lone CR is part of a Bash word.
    const plain = dialect === POWERSHELL && word === null && POWERSHELL_DASHES.includes(char) ? '-' : char;
    if (word === null) startWord(false);
    if (dialect.variable && char === '$' && next !== undefined && dialect.variable.test(next)) wordUnknown = true;
    if (dialect.percentVariables && char === '%') wordUnknown = true;
    word += plain;
    index++;
    plainEnd = index;
    plainChar = plain;
  }

  endPipeline();
  return { steps, end: index, words: groupWords, allQuoted };
}

// The index after the brace that closes the one at `open`, past quoted parts and escapes.
function braceEnd(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
    } else if (char === "'" || char === '"') {
      const close = source.indexOf(char, index + 1);
      if (close === -1) return source.length;
      index = close;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return index + 1;
    }
  }
  return source.length;
}

// The index after the parenthesis that closes the one at `open`.
function arithmeticEnd(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '(') depth++;
    if (source[index] === ')' && --depth === 0) return index + 1;
  }
  return source.length;
}

// The steps of the substitutions inside an unquoted heredoc or an expanding here-string, which run
// even though the text around them does not.
function bodySubstitutions(literal, dialect, context) {
  const found = [];
  for (let index = 0; index < literal.length; index++) {
    const char = literal[index];
    if (char === dialect.escape) {
      index++;
      continue;
    }
    if (dialect.substitution && char === '$' && literal[index + 1] === '(') {
      const nested = walk(literal, index + 2, dialect, true, context);
      found.push(...nested.steps);
      index = nested.end - 1;
      continue;
    }
    if (dialect.backtickSubstitution && char === '`') {
      const end = literal.indexOf('`', index + 1);
      if (end === -1) break;
      found.push(...walk(literal.slice(index + 1, end), 0, dialect, false, context).steps);
      index = end;
    }
  }
  return found;
}

// Reads the quoted token at `index`, or returns null when none starts there. `literal` is what the
// program receives, `substitutions` the steps of the substitutions that run inside it, and
// `expanded` whether the shell puts a variable's or a substitution's value into it.
function readQuoted(source, index, dialect, context) {
  const char = source[index];

  if (dialect.hereString && char === '@' && (source[index + 1] === "'" || source[index + 1] === '"')) {
    const quote = source[index + 1];
    HERE_STRING_OPEN.lastIndex = index + 2;
    const open = HERE_STRING_OPEN.exec(source);
    if (open) {
      const bodyStart = index + 2 + open[0].length;
      const close = source.slice(bodyStart).search(new RegExp('\\r?\\n' + quote + '@'));
      const bodyEnd = close === -1 ? source.length : bodyStart + close;
      const end = close === -1 ? source.length : source.indexOf('@', bodyEnd + 1) + 1;
      const literal = source.slice(bodyStart, bodyEnd);
      const expands = quote === '"';
      const substitutions = expands ? bodySubstitutions(literal, dialect, context) : [];
      return { literal, substitutions, end, expanded: expands && /\$[A-Za-z_{(]/.test(literal) };
    }
  }

  if (!dialect.quotes.includes(char)) return null;

  const expands = char === '"' && dialect.substitution;
  const ansiC = dialect === BASH && char === "'" && source[index - 1] === '$';
  const escapes = dialect.escape && !dialect.literalQuotes && (char !== "'" || ansiC);
  let literal = '';
  const substitutions = [];
  let expanded = false;
  let at = index + 1;

  while (at < source.length) {
    const current = source[at];
    const following = source[at + 1];

    if (dialect.commandLine && current === '\\') {
      const run = backslashRun(source, at);
      literal += run.literal;
      at += run.length;
      continue;
    }

    if (current === char) {
      // PowerShell writes a quote inside its own kind of string by doubling it, and so does the C
      // runtime inside a quoted part.
      if ((dialect.doubledQuotes || dialect.commandLine) && following === char) {
        literal += char;
        at += 2;
        continue;
      }
      return { literal, substitutions, end: at + 1, expanded };
    }

    if (escapes && current === dialect.escape && at + 1 < source.length) {
      if (ansiC) {
        const escaped = ansiCEscape(source, at);
        literal += escaped.char;
        at += escaped.length;
        continue;
      }
      if (dialect === POWERSHELL) {
        const escaped = powershellEscape(source, at);
        literal += escaped.char;
        at += escaped.length;
        continue;
      }
      // Bash deletes an escaped line break and keeps a backslash inside double quotes unless it
      // escapes one of these.
      if (dialect === BASH && following === '\r' && source[at + 2] === '\n') {
        at += 3;
        continue;
      }
      if (dialect === BASH && following === '\n') {
        at += 2;
        continue;
      }
      if (dialect === BASH && !'"\\$`'.includes(following)) literal += current;
      literal += following;
      at += 2;
      continue;
    }

    // A substitution inside an expanding string runs, and can hold quotes of the string's kind.
    if (expands && current === '$' && following === '(') {
      const nested = walk(source, at + 2, dialect, true, context);
      substitutions.push(...nested.steps);
      literal += source.slice(at, nested.end);
      expanded = true;
      at = nested.end;
      continue;
    }
    if (expands && dialect.backtickSubstitution && current === '`') {
      const close = source.indexOf('`', at + 1);
      const end = close === -1 ? source.length : close;
      substitutions.push(...walk(source.slice(at + 1, end), 0, dialect, false, context).steps);
      literal += source.slice(at, end + 1);
      expanded = true;
      at = end + 1;
      continue;
    }
    if (expands && current === '$' && following !== undefined && dialect.variable.test(following)) expanded = true;
    if (dialect.percentVariables && current === '%') expanded = true;

    literal += current;
    at++;
  }

  return { literal, substitutions, end: source.length, expanded };
}

// A heredoc body runs from `start` to the line that is exactly its tag, after its leading tabs when
// `stripsTabs`.
function readHeredocBody(source, start, tag, stripsTabs) {
  const lines = /[^\n]*(?:\n|$)/g;
  lines.lastIndex = start;
  let match;
  while (lines.lastIndex < source.length && (match = lines.exec(source)) !== null) {
    const line = match[0].replace(/\r?\n$/, '');
    if ((stripsTabs ? line.replace(/^\t+/, '') : line) === tag) {
      return { text: source.slice(start, match.index), end: lines.lastIndex };
    }
  }
  return { text: source.slice(start), end: source.length };
}

module.exports = { scanCommands, commandName };
