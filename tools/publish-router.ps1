#Requires -Version 5.1
<#
.SYNOPSIS
    Builds a client's router and uploads the installer to Router Hub in one step.

.DESCRIPTION
    Runs the same build as the project's build.bat, then sends the fresh installer
    to the hub under the client's name. build.bat itself is only read, never changed
    or called: the Go output name, package path, toolchain and electron-builder
    arguments are taken from it, so this stays correct for every client folder.

    Unlike build.bat this script never deletes anything. Instead of wiping dist\
    to keep stale files from shipping, it only accepts an installer written during
    this run.

.PARAMETER ProjectDir
    The client's project folder (the one containing build.bat and package.json).
    Defaults to the current folder.

.PARAMETER Client
    Client name on the hub. Created there if it does not exist yet.
    Defaults to productName from package.json.

.PARAMETER Version
    Version label on the hub. Defaults to the version in package.json.

.PARAMETER Notes
    What changed in this build.

.PARAMETER SkipBuild
    Upload the newest installer already in dist\ without building.

.PARAMETER File
    Upload this exact file. Implies -SkipBuild.

.PARAMETER Force
    Upload even if the hub already stores an identical file for this client.

.PARAMETER Server
.PARAMETER Token
    Hub address and deploy token. Normally read from publish.config.json next to
    this script (create the token in the hub under Settings > Publish script), or
    from the ROUTER_HUB_URL / ROUTER_HUB_TOKEN environment variables.

.EXAMPLE
    .\publish-router.ps1 "D:\work\Go exe\KENYA" -Client "Kenya"
    .\publish-router.ps1 "D:\work\Go exe\GANESHAM" -Notes "API failover fix"
    .\publish-router.ps1 "D:\work\Go exe\RADX1" -SkipBuild
#>

param(
    [Parameter(Position = 0)][string]$ProjectDir = (Get-Location).Path,
    [string]$Client = "",
    [string]$Version = "",
    [string]$Notes = "",
    [switch]$SkipBuild,
    [string]$File = "",
    [switch]$Force,
    [string]$Server = "",
    [string]$Token = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg) Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Fail { param([string]$msg) Write-Host "`n    ERR $msg`n" -ForegroundColor Red; exit 1 }

function Assert-Command {
    param([string]$Name, [string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Write-Fail "$Name not found in PATH  -  $Hint" }
}

# First capture group of a regex in build.bat, or the fallback when the line is absent.
function Get-BatValue {
    param([string]$Text, [string]$Pattern, [string]$Fallback)
    $m = [regex]::Match($Text, $Pattern, 'IgnoreCase, Multiline')
    if ($m.Success) { $m.Groups[1].Value.Trim() } else { $Fallback }
}

# -- Hub connection --
$configPath = Join-Path $PSScriptRoot "publish.config.json"
if (Test-Path -LiteralPath $configPath) {
    try { $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
    catch { Write-Fail "publish.config.json is not valid JSON: $($_.Exception.Message)" }
    if (-not $Server -and $cfg.PSObject.Properties['server']) { $Server = $cfg.server }
    if (-not $Token  -and $cfg.PSObject.Properties['token'])  { $Token  = $cfg.token }
}
if (-not $Server) { $Server = $env:ROUTER_HUB_URL }
if (-not $Token)  { $Token  = $env:ROUTER_HUB_TOKEN }
if (-not $Server -or -not $Token) {
    Write-Fail "No hub address or deploy token. In Router Hub open Settings > Publish script, create a token, and save the config it shows as:`n        $configPath"
}
$Server = $Server.TrimEnd('/')
Assert-Command "curl.exe" "curl ships with Windows 10 and later"

# -- Project --
if (-not (Test-Path -LiteralPath $ProjectDir -PathType Container)) { Write-Fail "Project folder not found: $ProjectDir" }
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$pkgPath = Join-Path $ProjectDir "package.json"
if (-not (Test-Path -LiteralPath $pkgPath)) { Write-Fail "No package.json in $ProjectDir  -  point this at a router project folder." }

$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $pkg.version }
if (-not $Client)  { $Client  = $pkg.build.productName }
if (-not $Client)  { $Client  = Split-Path $ProjectDir -Leaf }
$distDir = Join-Path $ProjectDir "dist"

Write-Host ""
Write-Host "  Router Hub  -  publish" -ForegroundColor Magenta
Write-Host "  Project : $ProjectDir"
# Folder scripts pass the client's ID; its name is shown once the hub answers.
if ($Client -notmatch '^[0-9a-f]{24}$') { Write-Host "  Client  : $Client" }
Write-Host "  Version : $Version"
Write-Host "  Hub     : $Server"

if ($File) { $SkipBuild = $true }
$buildStarted = Get-Date

# -- Build (the steps of build.bat, minus the deletes) --
if (-not $SkipBuild) {
    $batPath = Join-Path $ProjectDir "build.bat"
    if (-not (Test-Path -LiteralPath $batPath)) { Write-Fail "No build.bat in $ProjectDir to take the build settings from." }
    $bat = Get-Content -LiteralPath $batPath -Raw

    $goBuild = [regex]::Match($bat, '^\s*go build\b.*?-o\s+(\S+)\s+(\S+)\s*$', 'IgnoreCase, Multiline')
    if (-not $goBuild.Success) { Write-Fail "Could not find the 'go build ... -o <exe> <package>' line in build.bat." }
    $goOut       = $goBuild.Groups[1].Value
    $goPackage   = $goBuild.Groups[2].Value
    $toolchain   = Get-BatValue $bat '^\s*set\s+GOTOOLCHAIN=(\S+)'  'go1.20.14'
    $goArch      = Get-BatValue $bat '^\s*set\s+GOARCH=(\S+)'       '386'
    $cgo         = Get-BatValue $bat '^\s*set\s+CGO_ENABLED=(\S+)'  '0'
    $builderArgs = (Get-BatValue $bat '^\s*call\s+npx\s+electron-builder\s+(.+)$' '--win --ia32') -split '\s+'

    Write-Step "[1/6] Checking prerequisites"
    Assert-Command "go"  "Install Go from https://go.dev/dl/"
    Assert-Command "npm" "Install Node.js from https://nodejs.org/"
    Write-OK ((go version) -replace '^go version ', '')
    Write-OK "Node $(node --version)"

    # build.bat wipes dist\ here so a failed build cannot leave an old installer
    # behind to ship. This script gets the same guarantee without deleting: only
    # an installer written after this moment is accepted for upload.
    Write-Step "[2/6] Skipping clean  -  nothing is deleted; only a freshly written installer will be uploaded"

    Push-Location $ProjectDir
    try {
        # Windows 7 compatibility: Go 1.21+ dropped Win7 support, so the toolchain
        # pinned in build.bat is forced (auto-downloaded by the installed Go).
        $env:GOTOOLCHAIN = $toolchain
        $env:GOARCH      = $goArch
        $env:CGO_ENABLED = $cgo

        Write-Step "[3/6] Building $goOut  ($toolchain, $goArch)"
        go build -ldflags "-X main.version=$Version -s -w" -o $goOut $goPackage
        if ($LASTEXITCODE -ne 0) { Write-Fail "go build failed." }
        Write-OK "$goOut  ($([math]::Round((Get-Item -LiteralPath $goOut).Length / 1MB, 2)) MB)"

        # Editing go.mod does not produce a Win7 binary - only the compiling
        # toolchain does. Check the binary itself rather than trusting the env.
        Write-Step "[4/6] Verifying binary toolchain"
        $built = (go version $goOut) -join ' '
        if ($built -notmatch [regex]::Escape($toolchain)) {
            Write-Fail "$goOut was NOT built with $toolchain ($built). It will not run on Windows 7."
        }
        Write-OK "toolchain verified: $toolchain / $goArch"

        Write-Step "[5/6] Installing Node dependencies"
        # Quiet, but not --silent: when this step fails the reason must be visible.
        npm install --prefer-offline --no-fund --no-audit --loglevel=error
        if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed  -  see the npm error above." }
        Write-OK "node_modules up to date"

        Write-Step "[6/6] Packaging Electron installer  (electron-builder $($builderArgs -join ' '))"
        npx electron-builder @builderArgs
        if ($LASTEXITCODE -ne 0) { Write-Fail "electron-builder failed." }
    } finally {
        Pop-Location
    }
}

# -- Pick the installer --
Write-Step "Locating the installer"
if ($File) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { Write-Fail "File not found: $File" }
    $installer = Get-Item -LiteralPath $File
} else {
    if (-not (Test-Path -LiteralPath $distDir)) { Write-Fail "No dist folder in $ProjectDir  -  build first, or drop -SkipBuild." }
    # Top level only: dist\win-ia32-unpacked\ holds the app's own exe, not the installer.
    $candidates = @(Get-ChildItem -LiteralPath $distDir -File -Filter *.exe | Sort-Object LastWriteTime -Descending)
    if (-not $SkipBuild) {
        $candidates = @($candidates | Where-Object { $_.LastWriteTime -ge $buildStarted })
        if ($candidates.Count -eq 0) {
            Write-Fail "The build finished but wrote no new installer to dist\. Refusing to upload an older one."
        }
    } else {
        # Without a build to date them, prefer the installer named for this version.
        $named = @($candidates | Where-Object { $_.Name -like "*Setup*$Version*" })
        if ($named.Count -gt 0) { $candidates = $named }
        if ($candidates.Count -eq 0) { Write-Fail "No installer (.exe) found in $distDir." }
    }
    $installer = $candidates[0]
}
$sizeMB = [math]::Round($installer.Length / 1MB, 1)
Write-OK "$($installer.Name)  ($sizeMB MB, written $($installer.LastWriteTime.ToString('yyyy-MM-dd HH:mm')))"

# -- Upload --
function Read-HubResponse {
    # curl prints the body, then the status code on its own last line.
    param([string[]]$Lines)
    $status = 0
    if ($Lines -and $Lines.Count -gt 0) { [void][int]::TryParse($Lines[-1], [ref]$status) }
    $body = if ($Lines -and $Lines.Count -gt 1) { ($Lines[0..($Lines.Count - 2)] -join "`n") } else { "" }
    $json = $null
    try { if ($body) { $json = $body | ConvertFrom-Json } } catch {}
    [pscustomobject]@{ Status = $status; Json = $json; Body = $body }
}

function Get-HubError {
    param($Response)
    if ($Response.Status -eq 0)   { return "Could not reach the hub at $Server. Is it running?" }
    if ($Response.Status -eq 401) { return "The hub rejected the deploy token. Create a new one under Settings > Publish script." }
    if ($Response.Json -and $Response.Json.PSObject.Properties['error']) { return $Response.Json.error }
    "The hub answered HTTP $($Response.Status)."
}

$enc  = { param($s) [uri]::EscapeDataString([string]$s) }
$auth = "Authorization: Bearer $Token"
$sha  = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLower()

Write-Step "Uploading to $Server"
if (-not $Force) {
    $check = Read-HubResponse (& curl.exe -sS -m 30 -H $auth -w "`n%{http_code}" "$Server/api/upload/check?client=$(& $enc $Client)&sha256=$sha")
    if ($check.Status -ne 200) { Write-Fail (Get-HubError $check) }
    if ($check.Json.PSObject.Properties['client'] -and $check.Json.client) { Write-OK "Client on the hub: $($check.Json.client.name)" }
    else { Write-OK "New client on the hub: $Client" }
    if ($check.Json.duplicate) {
        Write-Host "    --  The hub already stores this exact file as version $($check.Json.duplicate.version) (build $($check.Json.duplicate.build))." -ForegroundColor Yellow
        Write-Host "        Nothing to upload. Use -Force to store it again.`n"
        exit 0
    }
}

$query = "client=$(& $enc $Client)&version=$(& $enc $Version)&filename=$(& $enc $installer.Name)&sha256=$sha&notes=$(& $enc $Notes)"
if ($Force) { $query += "&force=1" }
# The progress bar goes to the console (stderr); the response is captured from stdout.
$upload = Read-HubResponse (& curl.exe --globoff --progress-bar -H $auth -H "Content-Type: application/octet-stream" -T $installer.FullName -w "`n%{http_code}" "$Server/api/upload?$query")
if ($upload.Status -ne 201) { Write-Fail (Get-HubError $upload) }

$release = $upload.Json.release
Write-Host ""
Write-Host "  Published $($upload.Json.client.name) $($release.version)  (build $($release.build))" -ForegroundColor Green
Write-Host "  Manage         : $Server/clients/$($upload.Json.client.slug)"
Write-Host "  Protected link : $($release.links.protected)"
Write-Host "  The passwordless link is available to the master account in the hub."
Write-Host ""
