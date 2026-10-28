$ErrorActionPreference = "Stop"

# Set explicitly, because its default has changed across PowerShell 7 releases. When it is on, the
# first harness that exits non-zero stops this script, and the other harnesses never run.
$PSNativeCommandUseErrorActionPreference = $false

# Runs every test-*.js harness in this folder, found by name so a new harness needs no edit here.
# Finding none is a failure: a rename would otherwise leave every hook untested.
$harnesses = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter "test-*.js" | Sort-Object Name)
if ($harnesses.Count -eq 0) {
    throw "No Node hook harness sits beside this script, so every hook is unverified."
}

$failures = 0
foreach ($harness in $harnesses) {
    Write-Host ""
    Write-Host "RUN  $($harness.Name)"
    & node $harness.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL $($harness.Name) exited $LASTEXITCODE"
        $failures++
    }
}

if ($failures -ne 0) {
    throw "$failures hook harnesses failed."
}

Write-Host ""
Write-Host "PASS: hook policy checks succeeded."
