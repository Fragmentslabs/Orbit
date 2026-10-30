# Persistent Computer Use host on Windows.
#
# A single powershell.exe that stays alive: Orbit sends one JSON line per request on
# stdin ({"id":7,"op":"tree","args":{...}}) and reads one line per response on stdout
# ({"id":7,"ok":true,"result":...}). Add-Type (which is what costs 1-2 s) runs ONCE, at
# startup; every operation afterwards is just a call into the already compiled C#.
#
# Rules the file follows:
#  - the C# lives in windows-host.cs (reading) and windows-host-actions.cs (actions);
#    the driver writes the three files side by side as host.ps1, host.cs and actions.cs;
#  - pure ASCII (Orbit writes it with a BOM, but we do not rely on that);
#  - stdin/stdout in UTF-8 without a BOM: PowerShell 5.1 would use the ANSI codepage
#    and would corrupt text outside ASCII;
#  - the C# is C# 5 (the Add-Type compiler of PowerShell 5.1): no "?.", no string
#    interpolation and no "out var";
#  - no SetFocus: focusing a control of another app ACTIVATES its window and steals
#    the user's keyboard.

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"

# Constrained Language Mode (AppLocker/WDAC) forbids Add-Type: without it there is no
# host. Orbit still gets a clear answer instead of a timeout.
$ready = $false
$loadError = $null
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    $loadError = 'PowerShell is running in ' + $ExecutionContext.SessionState.LanguageMode + ' (Constrained Language Mode), which blocks the UI Automation host. A policy such as AppLocker or WDAC is enabled on this machine.'
} else {
    try {
        $dir = Split-Path -Parent $PSCommandPath
        Add-Type -Path (Join-Path $dir 'host.cs'), (Join-Path $dir 'actions.cs') -ReferencedAssemblies 'System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Web.Extensions'
        $ready = $true
    } catch {
        $loadError = 'The UI Automation host could not be compiled: ' + $_.Exception.Message
    }
}

while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    if ($ready) {
        $stdout.WriteLine([OrbitHost]::Handle($line))
        continue
    }
    # Without the compiled host: all we can do is say why.
    try {
        $req = $line | ConvertFrom-Json
        if ($req.op -eq 'perms') {
            $reply = @{ id = $req.id; ok = $true; result = @{ accessibility = $false; notes = @($loadError) } }
        } else {
            $reply = @{ id = $req.id; ok = $false; error = @{ code = 'axDenied'; message = $loadError } }
        }
        $stdout.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
    } catch {
        $stdout.WriteLine('{"id":0,"ok":false,"error":{"code":"bridgeError","message":"Unreadable request."}}')
    }
}
