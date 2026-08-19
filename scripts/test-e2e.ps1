param(
    [int]$Port = 3199,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$base = "http://127.0.0.1:$Port"
$token = 'e2e-test-token'

$work = Join-Path $env:TEMP ("aedificator-e2e-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Test-Request {
    param([string]$Method, [string]$Url, [object]$Body = $null)
    try {
        $params = @{ Method = $Method; Uri = $Url; TimeoutSec = 15; Headers = @{ Authorization = "Bearer $token" } }
        if ($null -ne $Body) {
            $params.ContentType = 'application/json'
            $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
        }
        $res = Invoke-RestMethod @params
        return @{ ok = $true; data = $res }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message }
    }
}

try {
    Write-Host "==> Copiando projeto para fora do OneDrive: $work" -ForegroundColor Cyan
    $copy = Join-Path $work 'app'
    New-Item -ItemType Directory -Force -Path $copy | Out-Null
    Copy-Item -Path (Join-Path $repoRoot 'backend')   -Destination $copy -Recurse
    Copy-Item -Path (Join-Path $repoRoot 'frontend')  -Destination $copy -Recurse
    Copy-Item -Path (Join-Path $repoRoot 'main.js')   -Destination $copy
    Copy-Item -Path (Join-Path $repoRoot 'package.json') -Destination $copy
    if (Test-Path (Join-Path $repoRoot 'node_modules')) {
        Copy-Item -Path (Join-Path $repoRoot 'node_modules') -Destination $copy -Recurse
    }

    Write-Host "==> Criando repo de teste git" -ForegroundColor Cyan
    $testRepo = Join-Path $work 'testrepo'
    New-Item -ItemType Directory -Force -Path $testRepo | Out-Null
    Set-Content -LiteralPath (Join-Path $testRepo 'base.txt') -Value 'linha inicial' -Encoding UTF8
    git -C $testRepo init -q
    git -C $testRepo add -A
    git -C $testRepo -c user.email="teste@teste.com" -c user.name="Teste" commit -qm "inicial"
    Set-Content -LiteralPath (Join-Path $testRepo 'novo.js') -Value "console.log('oi');" -Encoding UTF8

    Write-Host "==> Subindo servidor (cwd=$copy, PROJECT_ROOT=$testRepo)" -ForegroundColor Cyan
    $env:PORT = "$Port"
    $env:PROJECT_ROOT = $testRepo
    $env:BACKEND_TOKEN = $token
    $server = Start-Process -FilePath 'node' -ArgumentList 'backend/server.js' -WorkingDirectory $copy `
        -RedirectStandardOutput (Join-Path $work 'srv.log') `
        -RedirectStandardError (Join-Path $work 'srv.err.log') -PassThru -WindowStyle Hidden

    $ready = $false
    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 200
        if ($server.HasExited) { break }
        try { $null = Invoke-RestMethod -Uri "$base/api/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 2; $ready = $true; break } catch { }
    }
    if (-not $ready) {
        Write-Host "FALHA: servidor nao subiu. Erro:" -ForegroundColor Red
        Get-Content (Join-Path $work 'srv.err.log') -ErrorAction SilentlyContinue
        throw "servidor nao iniciou"
    }
    Write-Host "OK: servidor no ar (PID $($server.Id))" -ForegroundColor Green

    $failures = 0
    $checks = @(
        @{ n = 'health';            m = 'GET';  u = '/api/health';                        b = $null },
        @{ n = 'explorer list';     m = 'POST'; u = '/api/explorer/list';                 b = @{ path = '.' } },
        @{ n = 'file read';         m = 'POST'; u = '/api/file/read';                     b = @{ path = 'base.txt' } },
        @{ n = 'file create';       m = 'POST'; u = '/api/file/create';                   b = @{ path = 'novo.txt'; content = 'conteudo de teste' } },
        @{ n = 'file mkdir';        m = 'POST'; u = '/api/file/mkdir';                    b = @{ path = 'src' } },
        @{ n = 'file rename';       m = 'POST'; u = '/api/file/rename';                   b = @{ path = 'novo.txt'; newPath = 'renomeado.txt' } },
        @{ n = 'file delete';       m = 'POST'; u = '/api/file/delete';                   b = @{ path = 'renomeado.txt' } },
        @{ n = 'git status';        m = 'POST'; u = '/api/git/status';                    b = @{} },
        @{ n = 'git diff';          m = 'POST'; u = '/api/git/diff';                      b = @{ path = 'novo.js' } },
        @{ n = 'git stage';         m = 'POST'; u = '/api/git/stage';                     b = @{ file = 'novo.js' } },
        @{ n = 'git commit';        m = 'POST'; u = '/api/git/commit';                    b = @{ message = 'teste e2e' } },
        @{ n = 'snapshot create';   m = 'POST'; u = '/api/snapshot/create';               b = @{ name = 'e2e' } },
        @{ n = 'snapshot list';     m = 'POST'; u = '/api/snapshot/list';                 b = @{} },
        @{ n = 'snapshot diff';     m = 'POST'; u = '/api/snapshot/diff';                 b = @{ name = 'e2e' } },
        @{ n = 'backup list';       m = 'POST'; u = '/api/backup/list';                   b = @{} },
        @{ n = 'build';             m = 'POST'; u = '/api/build';                         b = @{ command = 'node novo.js' } }
    )

    foreach ($c in $checks) {
        if ($c.n -eq 'file mkdir') {
            Write-Host ("DEBUG antes mkdir: {0}" -f ((Get-ChildItem -Force $testRepo | Select-Object -ExpandProperty Name) -join ', ')) -ForegroundColor Magenta
            if (Test-Path (Join-Path $testRepo 'src')) { Write-Host 'DEBUG src EXISTE antes do mkdir' -ForegroundColor Magenta }
        }
        $r = Test-Request -Method $c.m -Url ($base + $c.u) -Body $c.b
        $ok = $r.ok -and (($null -ne $r.data.success -and $r.data.success) -or ($r.data.status -eq 'ok'))
        if ($ok) {
            Write-Host ("PASS  {0,-16} {1}" -f $c.n, $c.u) -ForegroundColor Green
        } else {
            $failures++
            $err = if ($r.ok) { ($r.data | ConvertTo-Json -Depth 4 -Compress) } else { $r.error }
            Write-Host ("FAIL  {0,-16} {1} -> {2}" -f $c.n, $c.u, $err) -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host ("Resultado: {0} falha(s) em {1} verificacoes" -f $failures, $checks.Count) -ForegroundColor $(if ($failures -eq 0) { 'Green' } else { 'Red' })
    if ($failures -eq 0) {
        Write-Host "PASSOU" -ForegroundColor Green
    } else {
        Write-Host "FALHOU" -ForegroundColor Red
    }
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Servidor encerrado (PID $($server.Id))" -ForegroundColor DarkGray
    }
    if (-not $Keep -and $work) {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
        Write-Host "Limpo: $work" -ForegroundColor DarkGray
    } elseif ($Keep) {
        Write-Host "Arquivos mantidos em: $work" -ForegroundColor Yellow
    }
}
