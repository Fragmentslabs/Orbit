# Host persistente do Computer Use no Windows.
#
# Um unico powershell.exe que fica vivo: o Orbit manda uma linha JSON por
# pedido no stdin ({"id":7,"op":"tree","args":{...}}) e le uma linha por
# resposta no stdout ({"id":7,"ok":true,"result":...}). O Add-Type (que e o
# que custa 1-2 s) roda UMA vez, na partida; cada operacao depois e so uma
# chamada ao C# ja compilado.
#
# Regras que o arquivo segue:
#  - o C# mora em windows-host.cs (o driver grava os dois arquivos lado a lado
#    como host.ps1 e host.cs);
#  - ASCII puro (o Orbit grava com BOM, mas nao dependemos disso);
#  - stdin/stdout em UTF-8 sem BOM: o PowerShell 5.1 usaria a pagina de codigo
#    ANSI e corromperia texto fora do ASCII;
#  - o C# e C# 5 (o compilador do Add-Type do PowerShell 5.1): sem "?.",
#    interpolacao de string nem "out var";
#  - nada de SetFocus: focar um controle de outro app ATIVA a janela dele e
#    rouba o teclado do usuario.

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"

# Constrained Language Mode (AppLocker/WDAC) proibe Add-Type: sem ele nao ha
# host. O Orbit ainda assim recebe uma resposta clara em vez de um timeout.
$ready = $false
$loadError = $null
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    $loadError = 'PowerShell is running in ' + $ExecutionContext.SessionState.LanguageMode + ' (Constrained Language Mode), which blocks the UI Automation host. A policy such as AppLocker or WDAC is enabled on this machine.'
} else {
    try {
        Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSCommandPath) 'host.cs') -Raw -Encoding UTF8) -ReferencedAssemblies 'System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Web.Extensions'
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
    # Sem o host compilado: so da para dizer por que.
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
