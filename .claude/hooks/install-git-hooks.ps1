<#
.SYNOPSIS
Installs, or with -Remove removes, the guard's git hooks in this repository, and makes git wait for a
locked ref instead of failing. -Check reports what an install would change.

.DESCRIPTION
pre-push is pre-push.sh from this folder. Before a push rewrites or deletes the shared branch on a
shared remote, it saves the remote's old tip under refs/guard/ (pre-push-save.js).

reference-transaction is reference-transaction.sh from this folder. Before the shared branch moves,
it runs the checks in reference-transaction/ beside this script, from the working tree, so an edit
to a check needs no new install. It is installed only while that folder holds a .sh file, and an
install removes it once the folder holds none.

It sets core.filesRefLockTimeout to 30000 ms. Agents commit at once, and git holds a ref's lock
while it updates the ref, and while a reference-transaction hook runs for it, so without the wait a
peer's commit that meets the lock fails with "Unable to create '...lock': File exists".

It refuses to replace a hook it did not write. -Remove leaves the lock timeout set.

Run it again after a change to pre-push.sh or reference-transaction.sh, and after adding the first
check to reference-transaction/ or removing the last.

Exit codes: 0 done; 1 another hook is in the way, or core.hooksPath is set. Move the other hook
aside, which stops it running, and run this script again. Or keep it by setting core.hooksPath to a
folder whose hooks run it and the guard's scripts.

With -Check, 0 means the guard's hooks are current.
2 means a MISSING, STALE, UNWANTED or FOREIGN line names each hook that needs a change. Move each
FOREIGN hook aside, then run this script without -Check. To keep one, set core.hooksPath as exit 1
says. Where core.hooksPath is set, add the missing hooks there by hand.
3 means git could not read the repository. Fix what git says under the ERROR line, or pass
-RepoRoot with the repository's folder.

.PARAMETER Remove
Remove the hooks that are this script's.

.PARAMETER Check
Change nothing, and report each hook that an install would add, replace or remove in the folder git
reads hooks from. Where core.hooksPath is set, it reports only the hooks missing there.

.PARAMETER RepoRoot
The repository. Defaults to the one this script is in.

.EXAMPLE
pwsh -NoProfile -File .claude/hooks/install-git-hooks.ps1
#>
[CmdletBinding(PositionalBinding = $false, DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Remove')]
    [switch] $Remove,
    [Parameter(ParameterSetName = 'Check')]
    [switch] $Check,
    [string] $RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
)

$ErrorActionPreference = 'Stop'

# Each git hook, with the file in this folder that is installed as it. A hook whose second line
# starts with its mark was written by this script and is replaced.
$hookFiles = [ordered]@{
    'pre-push' = @{ Source = 'pre-push.sh'; Mark = '# guard pre-push:' }
    'reference-transaction' = @{ Source = 'reference-transaction.sh'; Mark = '# guard reference-transaction:' }
}
# reference-transaction runs the checks in this folder, so it is installed only while there is one.
$checks = Join-Path $PSScriptRoot 'reference-transaction'
$hasChecks = [bool](Get-ChildItem -LiteralPath $checks -Filter '*.sh' -File -ErrorAction SilentlyContinue)
$wanted = @($hookFiles.Keys | Where-Object { $_ -ne 'reference-transaction' -or $hasChecks })

$isOurs = {
    param([string] $Target, [string] $Mark)
    if (-not (Test-Path -LiteralPath $Target)) { return $false }
    $second = @(Get-Content -LiteralPath $Target -TotalCount 2)[1]
    return [bool]($second -and $second.StartsWith($Mark))
}
$sourceText = { param([string] $Name) (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot $hookFiles[$Name].Source)) -replace "`r`n", "`n" }

$hooksPath = git -C $RepoRoot config --get core.hooksPath 2>$null

if ($Check) {
    $hooks = @(git -C $RepoRoot rev-parse --path-format=absolute --git-path hooks 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0 -or $hooks.Count -ne 1) {
        Write-Host "ERROR: git could not read $RepoRoot as a repository. Fix what git says below, or pass -RepoRoot with the repository's folder."
        foreach ($line in $hooks) { Write-Host "  $line" }
        Write-Host "EXIT: 3 unchecked: the hooks could not be checked. Fix what git says above, or pass -RepoRoot with the repository's folder."
        exit 3
    }
    $hooks = $hooks[0]
    $gaps = 0
    $foreign = 0
    foreach ($name in $hookFiles.Keys) {
        $target = Join-Path $hooks $name
        $source = $hookFiles[$name].Source
        if ($wanted -contains $name) {
            if (-not (Test-Path -LiteralPath $target)) {
                Write-Host "MISSING: $name`: $target is not installed."
                $gaps++
            }
            elseif (-not $hooksPath -and -not (& $isOurs $target $hookFiles[$name].Mark)) {
                Write-Host "FOREIGN: $name`: $target is another hook, so the guard's $name never runs."
                $gaps++
                $foreign++
            }
            elseif (-not $hooksPath -and
                ((Get-Content -Raw -LiteralPath $target) -replace "`r`n", "`n") -ne (& $sourceText $name)) {
                Write-Host "STALE: $name`: $target differs from $source."
                $gaps++
            }
        }
        elseif (-not $hooksPath -and (& $isOurs $target $hookFiles[$name].Mark)) {
            Write-Host "UNWANTED: $name`: $target is installed, but $checks holds no check for it to run."
            $gaps++
        }
    }
    if ($gaps -eq 0 -and $hooksPath) {
        Write-Host "EXIT: 0 current: $hooks has each hook the guard needs; whether they call the guard's scripts is not checked."
        exit 0
    }
    if ($gaps -eq 0) {
        Write-Host "EXIT: 0 current: the guard's hooks in $hooks are current."
        exit 0
    }
    if ($hooksPath) {
        Write-Host "EXIT: 2 gaps: git reads hooks from $hooksPath, which lacks the hooks above. Call the guard's scripts from the hooks there."
    }
    elseif ($foreign -gt 0) {
        Write-Host "EXIT: 2 gaps: the hooks above need a change. Move each FOREIGN hook aside, which stops it running, and run pwsh -NoProfile -File `"$PSCommandPath`" -RepoRoot `"$RepoRoot`". Or keep it: set core.hooksPath to a folder whose hooks run it and the guard's scripts."
    }
    else {
        Write-Host "EXIT: 2 gaps: an install would change the hooks above. Run pwsh -NoProfile -File `"$PSCommandPath`" -RepoRoot `"$RepoRoot`"."
    }
    exit 2
}

if ($hooksPath) {
    Write-Host "EXIT: 1 blocked: git reads hooks from $hooksPath, not .git/hooks, so these hooks would never run. Nothing was changed. Call the guard's scripts from the hooks in $hooksPath."
    exit 1
}
$hooks = Join-Path (git -C $RepoRoot rev-parse --path-format=absolute --git-common-dir) 'hooks'

if ($Remove) {
    foreach ($name in $hookFiles.Keys) {
        $target = Join-Path $hooks $name
        if (& $isOurs $target $hookFiles[$name].Mark) {
            Remove-Item -LiteralPath $target
            Write-Host "$name`: removed."
        }
        else {
            Write-Host "$name`: no guard hook was installed."
        }
    }
    Write-Host "EXIT: 0 done: the guard's hooks are removed."
    exit 0
}

$foreign = @($wanted | Where-Object {
    $target = Join-Path $hooks $_
    (Test-Path -LiteralPath $target) -and -not (& $isOurs $target $hookFiles[$_].Mark)
})
if ($foreign.Count -gt 0) {
    foreach ($name in $foreign) { Write-Host "$name`: $(Join-Path $hooks $name) is another hook." }
    Write-Host "EXIT: 1 blocked: nothing was installed. Move each hook above aside, which stops it running, and run this script again. Or keep it: set core.hooksPath to a folder whose hooks run it and the guard's scripts."
    exit 1
}

New-Item -ItemType Directory -Force -Path $hooks | Out-Null
foreach ($name in $hookFiles.Keys) {
    $target = Join-Path $hooks $name
    if ($wanted -contains $name) {
        # A temp file moved into place, so a git command running meanwhile never reads half a hook.
        [System.IO.File]::WriteAllText("$target.tmp", (& $sourceText $name), [System.Text.UTF8Encoding]::new($false))
        # Off Windows, WriteAllText creates the file without execute bits, and git skips a hook it cannot execute.
        if (-not $IsWindows) {
            [System.IO.File]::SetUnixFileMode("$target.tmp", [System.IO.UnixFileMode]'UserRead, UserWrite, UserExecute, GroupRead, GroupExecute, OtherRead, OtherExecute')
        }
        [System.IO.File]::Move("$target.tmp", $target, $true)
        Write-Host "$name`: installed at $target."
    }
    elseif (& $isOurs $target $hookFiles[$name].Mark) {
        Remove-Item -LiteralPath $target
        Write-Host "$name`: removed $target, because $checks holds no check for it to run."
    }
    elseif (Test-Path -LiteralPath $target) {
        Write-Host "$name`: not installed, because $checks holds no check. $target is another hook and stays."
    }
}
git -C $RepoRoot config core.filesRefLockTimeout 30000
Write-Host "EXIT: 0 done: the guard's hooks are installed, and git waits up to 30 s for a locked ref."
exit 0
