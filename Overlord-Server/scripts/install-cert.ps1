#Requires -RunAsAdministrator
# Overlord Certificate Installer
# Finds existing Overlord certs in the Windows trust store, removes them if
# desired, then installs a new one downloaded from the server.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Overlord Certificate Installer" -ForegroundColor Cyan
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Find existing Overlord certs ──────────────────────────────────────────

$stores = @(
    @{ Location = "CurrentUser";  Name = "Root" },
    @{ Location = "CurrentUser";  Name = "My" },
    @{ Location = "LocalMachine"; Name = "Root" },
    @{ Location = "LocalMachine"; Name = "My" }
)

$found = @()
foreach ($s in $stores) {
    $path = "Cert:\$($s.Location)\$($s.Name)"
    try {
        $certs = Get-ChildItem -Path $path -ErrorAction SilentlyContinue |
                 Where-Object { $_.Subject -match "O\s*=\s*Overlord" }
        foreach ($c in $certs) {
            $found += [PSCustomObject]@{
                Store       = "$($s.Location)\$($s.Name)"
                Subject     = $c.Subject
                Thumbprint  = $c.Thumbprint
                NotAfter    = $c.NotAfter
                Path        = "$path\$($c.Thumbprint)"
            }
        }
    } catch {}
}

if ($found.Count -gt 0) {
    Write-Host "  Found $($found.Count) existing Overlord certificate(s):" -ForegroundColor Yellow
    Write-Host ""
    $i = 1
    foreach ($c in $found) {
        Write-Host "    [$i] $($c.Subject)" -ForegroundColor White
        Write-Host "        Store      : $($c.Store)"
        Write-Host "        Thumbprint : $($c.Thumbprint)"
        Write-Host "        Expires    : $($c.NotAfter.ToString('yyyy-MM-dd'))"
        Write-Host ""
        $i++
    }

    $remove = Read-Host "  Remove existing Overlord certs before installing? (Y/n)"
    if ($remove -ne "n" -and $remove -ne "N") {
        foreach ($c in $found) {
            try {
                Remove-Item -Path $c.Path -Confirm:$false
                Write-Host "    Removed $($c.Thumbprint) from $($c.Store)" -ForegroundColor DarkGray
            } catch {
                Write-Host "    Failed to remove $($c.Thumbprint) from $($c.Store): $_" -ForegroundColor Red
            }
        }
        Write-Host ""
    }
} else {
    Write-Host "  No existing Overlord certificates found in the trust store." -ForegroundColor DarkGray
    Write-Host ""
}

# ── 2. Prompt for the new certificate ────────────────────────────────────────

Write-Host "  To download the certificate, log into your Overlord panel and visit:" -ForegroundColor Cyan
Write-Host ""
Write-Host "    https://<your-server>:5173/api/cert/download" -ForegroundColor White
Write-Host ""
Write-Host "  The file will save as 'overlord-ca.crt'." -ForegroundColor DarkGray
Write-Host ""

$certPath = Read-Host "  Path to the downloaded .crt file"
$certPath = $certPath.Trim('"', "'", " ")

if (-not (Test-Path $certPath)) {
    Write-Host ""
    Write-Host "  File not found: $certPath" -ForegroundColor Red
    Write-Host "  Exiting." -ForegroundColor Red
    exit 1
}

# ── 3. Install the certificate ───────────────────────────────────────────────

Write-Host ""
Write-Host "  Installing certificate..." -ForegroundColor Cyan

try {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
} catch {
    Write-Host "  Failed to read certificate: $_" -ForegroundColor Red
    exit 1
}

if ($cert.Subject -notmatch "O\s*=\s*Overlord") {
    Write-Host "  Warning: this certificate does not appear to be from Overlord." -ForegroundColor Yellow
    Write-Host "  Subject: $($cert.Subject)" -ForegroundColor Yellow
    $proceed = Read-Host "  Install anyway? (y/N)"
    if ($proceed -ne "y" -and $proceed -ne "Y") {
        Write-Host "  Cancelled." -ForegroundColor Red
        exit 0
    }
}

$storeChoice = Read-Host "  Install for [1] Current User or [2] Local Machine? (1/2)"
$storeLocation = if ($storeChoice -eq "2") {
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
} else {
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
}

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    $storeLocation
)

try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($cert)
    $store.Close()
} catch {
    Write-Host "  Failed to install certificate: $_" -ForegroundColor Red
    exit 1
}

$locationLabel = if ($storeChoice -eq "2") { "Local Machine" } else { "Current User" }
Write-Host ""
Write-Host "  Certificate installed successfully." -ForegroundColor Green
Write-Host "    Subject    : $($cert.Subject)" -ForegroundColor White
Write-Host "    Thumbprint : $($cert.Thumbprint)" -ForegroundColor White
Write-Host "    Store      : $locationLabel\Trusted Root Certification Authorities" -ForegroundColor White
Write-Host "    Expires    : $($cert.NotAfter.ToString('yyyy-MM-dd'))" -ForegroundColor White
Write-Host ""
Write-Host "  Restart your browser for the change to take effect." -ForegroundColor Yellow
Write-Host ""
