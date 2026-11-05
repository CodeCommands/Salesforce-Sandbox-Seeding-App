<#
.SYNOPSIS
    Local web server for Sandbox Seeder (Windows PowerShell 5.1+, no installs, no admin rights).

.DESCRIPTION
    Serves the ./public folder on http://localhost:<Port>/ using System.Net.HttpListener so the
    browser app runs from a real http origin (OAuth callbacks and CORS do not work from file:///).

    Optional relay: POST/GET/PATCH/DELETE /api/proxy forwards a request to the Salesforce URL in the
    X-SF-Endpoint header. Only https Salesforce hosts are allowed and only same-origin browser calls
    are accepted. Used when the app's Transport setting is "Local proxy".

.PARAMETER Port
    TCP port to listen on (default 5050). The Connected App callback URL must use the same port.

.PARAMETER Root
    Folder to serve (default: the "public" folder next to this script).

.PARAMETER NoBrowser
    Do not open the default browser after the server starts.

.PARAMETER NoProxy
    Disable the /api/proxy relay endpoint.
#>
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 5050,
    [string]$Root = '',
    [switch]$NoBrowser,
    [switch]$NoProxy
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# --- Environment checks -------------------------------------------------------------------------

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Write-Host ''
    Write-Host ("  PowerShell is running in {0} mode (AppLocker / WDAC policy)." -f $ExecutionContext.SessionState.LanguageMode) -ForegroundColor Red
    Write-Host '  The local server needs FullLanguage mode to use .NET HttpListener.' -ForegroundColor Red
    Write-Host '  Ask IT to allow server.ps1, or host the "public" folder on any internal web server.' -ForegroundColor Red
    exit 2
}

if (-not $Root) {
    $base = $PSScriptRoot
    if (-not $base) { $base = (Get-Location).Path }
    $Root = Join-Path $base 'public'
}
$Root = [System.IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath (Join-Path $Root 'index.html'))) {
    Write-Host "  Cannot find index.html in $Root" -ForegroundColor Red
    exit 1
}
$RootWithSep = $Root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

# Older .NET defaults may not include TLS 1.2, which Salesforce requires.
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
} catch { }

# --- Configuration ------------------------------------------------------------------------------

$AppOrigin = "http://localhost:$Port"
$AppUrl = "$AppOrigin/"

$MimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.ico'  = 'image/x-icon'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.map'  = 'application/json; charset=utf-8'
    '.woff2' = 'font/woff2'
}

$SecurityHeaders = [ordered]@{
    'X-Content-Type-Options'  = 'nosniff'
    'Referrer-Policy'         = 'no-referrer'
    'X-Frame-Options'         = 'DENY'
    'Cache-Control'           = 'no-store'
    'Content-Security-Policy' = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
}

# Salesforce-owned domains the relay may call (login, My Domain, instance and sandbox hosts).
$AllowedHostPattern = '(?i)^([a-z0-9-]+\.)*(salesforce\.com|force\.com|cloudforce\.com|salesforce\.mil|force\.mil|crmforce\.mil|sfcrmproducts\.cn|sfcrmapps\.cn|database\.com)$'
$ForwardHeaders = @('Authorization', 'Sforce-Duplicate-Rule-Header', 'Sforce-Auto-Assign', 'Sforce-Query-Options', 'Sforce-Call-Options')

# --- Response helpers ---------------------------------------------------------------------------

function Send-Bytes {
    param($Context, [int]$Status, [string]$ContentType, [byte[]]$Bytes)
    $res = $Context.Response
    $res.StatusCode = $Status
    if ($ContentType) { $res.ContentType = $ContentType }
    if ($null -eq $Bytes) { $Bytes = New-Object byte[] 0 }
    $res.ContentLength64 = $Bytes.Length
    if ($Context.Request.HttpMethod -ne 'HEAD' -and $Bytes.Length -gt 0) {
        $res.OutputStream.Write($Bytes, 0, $Bytes.Length)
    }
}

function Send-Text {
    param($Context, [int]$Status, [string]$Text, [string]$ContentType = 'text/plain; charset=utf-8')
    Send-Bytes -Context $Context -Status $Status -ContentType $ContentType -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Send-Json {
    param($Context, [int]$Status, $Object)
    Send-Text -Context $Context -Status $Status -Text (ConvertTo-Json -InputObject $Object -Compress -Depth 5) -ContentType 'application/json; charset=utf-8'
}

# --- Static files -------------------------------------------------------------------------------

function Send-StaticFile {
    param($Context)
    $req = $Context.Request
    if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') {
        Send-Text -Context $Context -Status 405 -Text 'Method not allowed'
        return
    }
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($rel -eq '/' -or $rel -eq '') { $rel = '/index.html' }
    if ($rel.IndexOf([char]0) -ge 0) {
        Send-Text -Context $Context -Status 400 -Text 'Bad request'
        return
    }
    try {
        $relative = $rel.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $candidate = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $relative))
    } catch {
        Send-Text -Context $Context -Status 400 -Text 'Bad request'
        return
    }
    # Path traversal guard: the resolved file must live inside the public folder.
    if (-not $candidate.StartsWith($RootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text -Context $Context -Status 403 -Text 'Forbidden'
        return
    }
    if ([System.IO.Directory]::Exists($candidate)) { $candidate = Join-Path $candidate 'index.html' }
    if (-not [System.IO.File]::Exists($candidate)) {
        Send-Text -Context $Context -Status 404 -Text 'Not found'
        return
    }
    $ext = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
    $type = $MimeTypes[$ext]
    if (-not $type) { $type = 'application/octet-stream' }
    Send-Bytes -Context $Context -Status 200 -ContentType $type -Bytes ([System.IO.File]::ReadAllBytes($candidate))
}

# --- Salesforce relay ---------------------------------------------------------------------------

function Invoke-SalesforceProxy {
    param($Context)
    $req = $Context.Request

    # Only accept calls made by this app's own pages (blocks other websites from using the relay).
    $reqOrigin = $req.Headers['Origin']
    $fetchSite = $req.Headers['Sec-Fetch-Site']
    if (($reqOrigin -and $reqOrigin -ne $AppOrigin) -or ($fetchSite -and $fetchSite -ne 'same-origin')) {
        Send-Json -Context $Context -Status 403 -Object @{ proxyError = 'Cross-origin requests are not allowed' }
        return
    }

    $endpoint = $req.Headers['X-SF-Endpoint']
    $uri = $null
    $valid = $false
    if ($endpoint -and [System.Uri]::TryCreate($endpoint, [System.UriKind]::Absolute, [ref]$uri)) {
        $valid = ($uri.Scheme -eq 'https') -and ($uri.Host -match $AllowedHostPattern) -and ($uri.IsDefaultPort)
    }
    if (-not $valid) {
        Send-Json -Context $Context -Status 400 -Object @{ proxyError = 'X-SF-Endpoint must be an https Salesforce URL' }
        return
    }

    $bodyBytes = $null
    if ($req.HasEntityBody) {
        $buffer = New-Object System.IO.MemoryStream
        $req.InputStream.CopyTo($buffer)
        $bodyBytes = $buffer.ToArray()
    }

    $out = [System.Net.HttpWebRequest]::Create($uri)
    $out.Method = $req.HttpMethod
    $out.AllowAutoRedirect = $false
    $out.Timeout = 300000
    $out.ReadWriteTimeout = 300000
    $out.KeepAlive = $true
    $out.Accept = 'application/json'
    $out.UserAgent = 'SandboxSeeder/1.0 (local relay)'
    $out.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    # Corporate proxies: use the system proxy with the signed-in Windows user's credentials.
    if ($null -ne $out.Proxy) { $out.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials }
    foreach ($name in $ForwardHeaders) {
        $value = $req.Headers[$name]
        if ($value) { $out.Headers[$name] = $value }
    }
    if ($null -ne $bodyBytes -and $bodyBytes.Length -gt 0) {
        if ($req.ContentType) { $out.ContentType = $req.ContentType } else { $out.ContentType = 'application/json' }
        $out.ContentLength = $bodyBytes.Length
        $stream = $out.GetRequestStream()
        try { $stream.Write($bodyBytes, 0, $bodyBytes.Length) } finally { $stream.Close() }
    } elseif ($req.HttpMethod -eq 'POST' -or $req.HttpMethod -eq 'PATCH') {
        $out.ContentLength = 0
    }

    $resp = $null
    try {
        $resp = $out.GetResponse()
    } catch {
        $ex = $_.Exception
        while ($null -ne $ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
        if ($null -ne $ex -and $null -ne $ex.Response) {
            $resp = $ex.Response
        } else {
            $msg = $_.Exception.Message
            if ($null -ne $ex) { $msg = $ex.Message }
            Send-Json -Context $Context -Status 502 -Object @{ proxyError = $msg }
            return
        }
    }
    try {
        $copy = New-Object System.IO.MemoryStream
        $rs = $resp.GetResponseStream()
        if ($null -ne $rs) { $rs.CopyTo($copy); $rs.Close() }
        Send-Bytes -Context $Context -Status ([int]$resp.StatusCode) -ContentType $resp.ContentType -Bytes ($copy.ToArray())
    } finally {
        $resp.Close()
    }
}

# --- Request dispatch ---------------------------------------------------------------------------

function Invoke-Request {
    param($Context)
    $path = $Context.Request.Url.AbsolutePath
    $method = $Context.Request.HttpMethod
    $detail = ''
    try {
        foreach ($key in $SecurityHeaders.Keys) { $Context.Response.AddHeader($key, $SecurityHeaders[$key]) }
        if ($path -eq '/api/proxy') {
            if ($NoProxy) {
                Send-Json -Context $Context -Status 404 -Object @{ proxyError = 'Relay disabled (-NoProxy)' }
            } else {
                $ep = $Context.Request.Headers['X-SF-Endpoint']
                if ($ep) { try { $u = [System.Uri]$ep; $detail = ' -> ' + $u.Host + $u.AbsolutePath } catch { } }
                Invoke-SalesforceProxy -Context $Context
            }
        } elseif ($path -eq '/api/health') {
            Send-Json -Context $Context -Status 200 -Object @{ ok = $true; proxy = (-not $NoProxy); port = $Port }
        } else {
            Send-StaticFile -Context $Context
        }
    } catch {
        $detail = $detail + ' ERROR: ' + $_.Exception.Message
        try { Send-Json -Context $Context -Status 500 -Object @{ proxyError = $_.Exception.Message } } catch { }
    } finally {
        $status = 0
        try { $status = $Context.Response.StatusCode } catch { }
        try { $Context.Response.Close() } catch { }
        $color = 'Gray'
        if ($status -ge 400) { $color = 'Yellow' }
        if ($status -ge 500) { $color = 'Red' }
        Write-Host ('  {0:HH:mm:ss}  {1,-6} {2,3}  {3}{4}' -f (Get-Date), $method, $status, $path, $detail) -ForegroundColor $color
    }
}

# --- Main loop ----------------------------------------------------------------------------------

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($AppUrl)
try {
    $listener.Start()
} catch {
    Write-Host ''
    Write-Host ("  Could not listen on {0} : {1}" -f $AppUrl, $_.Exception.Message) -ForegroundColor Red
    Write-Host '  Another program may already use this port (is the Seeder already running?).' -ForegroundColor Red
    Write-Host '  To use a different port run:  start.bat 5051' -ForegroundColor Red
    Write-Host '  (and add http://localhost:5051/oauth/callback.html to the Connected App callback URLs).' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  ==============================================================' -ForegroundColor Cyan
Write-Host '   Sandbox Seeder is running' -ForegroundColor Cyan
Write-Host ('   App:           {0}' -f $AppUrl) -ForegroundColor Cyan
Write-Host ('   OAuth callback: {0}oauth/callback.html' -f $AppUrl) -ForegroundColor Cyan
Write-Host ('   CORS origin:   {0}' -f $AppOrigin) -ForegroundColor Cyan
if ($NoProxy) { Write-Host '   Relay:         disabled' -ForegroundColor Cyan } else { Write-Host '   Relay:         enabled (/api/proxy)' -ForegroundColor Cyan }
Write-Host '   Keep this window open. Press Ctrl+C to stop.' -ForegroundColor Cyan
Write-Host '  ==============================================================' -ForegroundColor Cyan
Write-Host ''

if (-not $NoBrowser) {
    try { Start-Process $AppUrl } catch { Write-Host ("  Open {0} in your browser." -f $AppUrl) }
}

try {
    while ($listener.IsListening) {
        $pendingContext = $listener.BeginGetContext($null, $null)
        # Short waits keep Ctrl+C responsive (a blocking GetContext() ignores it).
        while (-not $pendingContext.AsyncWaitHandle.WaitOne(250)) { }
        $context = $null
        try { $context = $listener.EndGetContext($pendingContext) } catch { continue }
        Invoke-Request -Context $context
    }
} finally {
    try { $listener.Stop(); $listener.Close() } catch { }
    Write-Host '  Server stopped.'
}
