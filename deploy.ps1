[CmdletBinding()]
param(
    [string]$Namespace = "rk-relay",
    [string]$Registry = "registry.geiseit.com",
    [string]$Image = "rk-tactical-relay",
    [string]$WebImage = "rk-tactical-relay-web",
    [string]$Hostname = "rk.hangaraddons.com",
    [string]$Tag,
    [string]$Context = "kubernetes-admin@kubernetes",
    [string]$PullSecret = "registry-creds",
    [string]$PullSecretSource,
    [string]$PullSecretNamespace = "hangaraddons",
    [string]$LoadBalancerIP,
    [int]$RolloutTimeoutSeconds = 300,
    [int]$PeerTimeoutSeconds = 90,
    [switch]$SkipTests,
    [switch]$SkipBuild,
    [switch]$SkipPreflight,
    [switch]$Status,
    [switch]$Rollback,
    [switch]$Teardown,
    [switch]$DryRun,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Set-Location $PSScriptRoot

$warnings = [System.Collections.Generic.List[string]]::new()

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Warn($text) { $warnings.Add($text); Write-Host "WARNING: $text" -ForegroundColor Yellow }
function Ok($text) { Write-Host "ok: $text" -ForegroundColor Green }

function Run {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Capture {
    param([string]$File, [string[]]$Arguments)
    $ErrorActionPreference = "Continue"
    $out = & $File @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$File $($Arguments -join ' ') failed: $out"
    }
    return $out
}

function Test-Exists {
    param([string[]]$Arguments)
    $ErrorActionPreference = "Continue"
    & kubectl @Arguments *> $null
    return ($LASTEXITCODE -eq 0)
}

function Confirm-Action($question) {
    if ($Yes) { return $true }
    return ((Read-Host "$question (y/N)") -match '^[Yy]')
}

function Get-PodHealth($pod) {
    $ErrorActionPreference = "Continue"
    $raw = & kubectl get --raw "/api/v1/namespaces/$Namespace/pods/${pod}:8787/proxy/health" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    return ($raw -join "") | ConvertFrom-Json
}

function Test-Peers {
    $pods = @((Capture kubectl @("-n", $Namespace, "get", "pods", "-l", "app=rk-relay", "-o", "json")) -join "`n" | ConvertFrom-Json).items |
        Where-Object { $_.status.phase -eq "Running" }
    $pods = @($pods)
    if ($pods.Count -lt 2) { return $true }
    $bad = @()
    foreach ($p in $pods) {
        $h = Get-PodHealth $p.metadata.name
        if ($null -eq $h -or $h.peers -lt ($pods.Count - 1)) { $bad += $p.metadata.name }
    }
    return ($bad.Count -eq 0)
}

foreach ($tool in "kubectl", "git") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not installed or not on PATH"
    }
}

$current = (Capture kubectl @("config", "current-context")) | Select-Object -First 1
if ($current -ne $Context) {
    throw "kubectl context is '$current', expected '$Context'. Switch with: kubectl config use-context $Context"
}

if ($Status) {
    Step "Status of $Namespace"
    Run kubectl @("-n", $Namespace, "get", "deploy,hpa,pods,svc", "-o", "wide")
    foreach ($p in ((Capture kubectl @("-n", $Namespace, "get", "pods", "-l", "app=rk-relay", "-o", "name")))) {
        $name = $p -replace "^pod/", ""
        $h = Get-PodHealth $name
        if ($h) { Write-Host "$name players=$($h.players) peers=$($h.peers)" } else { Write-Host "$name health unavailable" }
    }
    exit 0
}

if ($Rollback) {
    Step "Rolling back deployment/rk-relay in $Namespace"
    if (-not (Confirm-Action "Roll back to the previous revision?")) { exit 1 }
    Run kubectl @("-n", $Namespace, "rollout", "undo", "deployment/rk-relay")
    Run kubectl @("-n", $Namespace, "rollout", "status", "deployment/rk-relay", "--timeout=$($RolloutTimeoutSeconds)s")
    exit 0
}

if ($Teardown) {
    Step "Teardown of namespace $Namespace"
    $protected = "default", "kube-system", "kube-public", "kube-node-lease", "hangaraddons", "metallb-system", "ingress-nginx", "docker-registry", "cert-manager"
    if ($protected -contains $Namespace) { throw "Refusing to delete protected namespace '$Namespace'" }
    if (-not (Test-Exists @("get", "namespace", $Namespace))) { Write-Host "Namespace $Namespace does not exist."; exit 0 }
    Write-Host "This deletes everything in $Namespace, including the replica token and the registry secret copy."
    if (-not $Yes) {
        if ((Read-Host "Type the namespace name to confirm") -ne $Namespace) { Write-Host "Cancelled."; exit 1 }
    }
    Run kubectl @("delete", "namespace", $Namespace)
    Write-Host "`nNow remove the DNS record and disable the OPNsense port forward for 8787."
    exit 0
}

$dirty = (Capture git @("status", "--porcelain")) -join ""
if (-not $Tag) {
    $Tag = (Capture git @("rev-parse", "--short", "HEAD")) | Select-Object -First 1
    if ($dirty) {
        $Tag = "$Tag-dirty-$(Get-Date -Format 'yyyyMMddHHmmss')"
    }
}
$ref = "$Registry/$($Image):$Tag"
$webRef = "$Registry/$($WebImage):$Tag"

$engine = $null
foreach ($candidate in "docker", "podman") {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) { $engine = $candidate; break }
}

Step "Preflight"
if ($SkipPreflight) {
    Write-Host "skipped"
}
else {
    $null = Test-Exists @("get", "nodes")
    if ($LASTEXITCODE -ne 0) { throw "The cluster is not reachable with context '$current'" }
    Ok "cluster reachable"

    if ($engine) { Ok "container engine: $engine" }
    elseif (-not $SkipBuild) { throw "docker or podman is required to build the image" }

    if ($engine -and -not $SkipBuild) {
        $authFiles = @("$env:USERPROFILE\.docker\config.json", "$env:APPDATA\containers\auth.json", "$env:USERPROFILE\.config\containers\auth.json")
        $loggedIn = $false
        foreach ($f in $authFiles) {
            if ((Test-Path $f) -and ((Get-Content $f -Raw) -match [regex]::Escape($Registry))) { $loggedIn = $true }
        }
        if (-not $loggedIn -and $env:REGISTRY_USER -and $env:REGISTRY_PASSWORD) {
            if (-not $DryRun) {
                $env:REGISTRY_PASSWORD | & $engine login $Registry --username $env:REGISTRY_USER --password-stdin
                if ($LASTEXITCODE -ne 0) { throw "Registry login failed" }
                $loggedIn = $true
            }
        }
        if ($loggedIn) { Ok "registry login for $Registry" }
        else { Warn "No saved login for $Registry. Run '$engine login $Registry' or set REGISTRY_USER and REGISTRY_PASSWORD, otherwise the push will fail." }
    }

    $ErrorActionPreference = "Continue"
    $pools = & kubectl -n metallb-system get ipaddresspools -o json 2>$null
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -eq 0 -and $pools) {
        $ranges = @(($pools -join "`n" | ConvertFrom-Json).items | ForEach-Object { $_.spec.addresses } | ForEach-Object { $_ })
        Ok "MetalLB pools: $($ranges -join ', ')"
    }
    else { Warn "Could not read MetalLB address pools, the service may not get an external address" }

    if ($LoadBalancerIP) {
        $svcs = (Capture kubectl @("get", "svc", "-A", "-o", "json")) -join "`n" | ConvertFrom-Json
        foreach ($svc in $svcs.items) {
            $lb = $svc.status.PSObject.Properties["loadBalancer"]
            if (-not $lb -or -not $lb.Value.PSObject.Properties["ingress"]) { continue }
            if ($svc.metadata.namespace -eq $Namespace -and $svc.metadata.name -eq "rk-relay") { continue }
            foreach ($entry in $lb.Value.ingress) {
                if ($entry.PSObject.Properties["ip"] -and $entry.ip -eq $LoadBalancerIP) {
                    throw "$LoadBalancerIP is already used by service $($svc.metadata.namespace)/$($svc.metadata.name)"
                }
            }
        }
        Ok "$LoadBalancerIP is not used by another service"
    }

    $null = Test-Exists @("top", "nodes")
    if ($LASTEXITCODE -eq 0) { Ok "metrics server answers, the autoscaler can work" }
    else { Warn "kubectl top failed, so the autoscaler will not see CPU. Pods still run at the minimum replica count." }

    $kubeSystem = (Capture kubectl @("-n", "kube-system", "get", "pods", "-o", "name")) -join " "
    $policyNamespace = (Test-Exists @("get", "namespace", "calico-system")) -or (Test-Exists @("get", "namespace", "cilium"))
    if ($policyNamespace -or $kubeSystem -match "calico|cilium|antrea|weave|kube-router") { Ok "network plugin enforces network policies" }
    else { Warn "No network plugin that enforces policies was found (flannel alone does not). Port 8788 would not be restricted to relay pods." }
}

Step "Plan"
Write-Host "Context   : $current"
Write-Host "Namespace : $Namespace"
Write-Host "Image     : $ref"
Write-Host "Web image : $webRef"
Write-Host "Web host  : https://$Hostname"
Write-Host "Address   : $(if ($LoadBalancerIP) { $LoadBalancerIP } else { 'next free MetalLB address' })"
Write-Host "Build     : $(if ($SkipBuild) { 'skipped, tag must already be in the registry' } else { 'yes' })"
Write-Host "Tests     : $(if ($SkipTests) { 'skipped' } else { 'yes' })"
if ($dirty) { Write-Host "Working tree has uncommitted changes, the image is built from them." -ForegroundColor Yellow }
if ($DryRun) { Write-Host "Dry run: nothing is built, pushed or applied." -ForegroundColor Yellow }

if (-not $DryRun -and -not (Confirm-Action "Deploy this to the cluster?")) {
    Write-Host "Cancelled."
    exit 1
}

if (-not $SkipTests -and -not $DryRun) {
    Step "Running tests"
    if (Get-Command go -ErrorAction SilentlyContinue) {
        Run go @("vet", "./...")
        Run go @("test", "-race", "-count=1", "./...")
    }
    elseif ($engine) {
        $script = "apk add --no-cache gcc musl-dev >/dev/null 2>&1; go vet ./... && CGO_ENABLED=1 go test -race -count=1 ./..."
        Run $engine @("run", "--rm", "-v", "${PSScriptRoot}:/src", "-w", "/src", "golang:1.24-alpine", "sh", "-c", $script)
    }
    else {
        throw "Neither go nor a container engine is available to run the tests. Use -SkipTests to bypass."
    }
}

if (-not $SkipBuild -and -not $DryRun) {
    Step "Building $ref"
    Run $engine @("build", "-t", $ref, ".")
    Step "Building $webRef"
    Run $engine @("build", "-t", $webRef, "-f", "Dockerfile.web", ".")
    Step "Pushing $ref and $webRef"
    Run $engine @("push", $ref)
    Run $engine @("push", $webRef)
}

Step "Rendering manifests"
$rendered = (Capture kubectl @("kustomize", "deploy/k8s")) -join "`n"
if ($rendered -notmatch "image: rk-tactical-relay:latest") {
    throw "The deployment manifest no longer contains the placeholder image, update deploy.ps1"
}
if ($rendered -notmatch "image: rk-tactical-relay-web:latest" -or $rendered -notmatch "relay\.example\.com") {
    throw "The web manifest no longer contains its placeholders, update deploy.ps1"
}
$rendered = $rendered.Replace("image: rk-tactical-relay:latest", "image: $ref").Replace("image: rk-tactical-relay-web:latest", "image: $webRef").Replace("relay.example.com", $Hostname)
Write-Host "Rendered $($rendered.Length) characters of YAML."

if ($DryRun) {
    Write-Host "`nDry run complete."
    if ($warnings.Count) { Write-Host "$($warnings.Count) warning(s) above." -ForegroundColor Yellow }
    exit 0
}

Step "Namespace and secrets"
if (-not (Test-Exists @("get", "namespace", $Namespace))) {
    Run kubectl @("create", "namespace", $Namespace)
}

if (-not (Test-Exists @("-n", $Namespace, "get", "secret", $PullSecret))) {
    if (-not $PullSecretSource) {
        $json = (Capture kubectl @("-n", $PullSecretNamespace, "get", "secrets", "--field-selector", "type=kubernetes.io/dockerconfigjson", "-o", "json")) -join "`n"
        $names = @(($json | ConvertFrom-Json).items | ForEach-Object { $_.metadata.name })
        if ($names.Count -ne 1) {
            throw "Found $($names.Count) registry secrets in $PullSecretNamespace ($($names -join ', ')). Pass -PullSecretSource <name>."
        }
        $PullSecretSource = $names[0]
    }
    Write-Host "Copying registry secret '$PullSecretSource' from $PullSecretNamespace as '$PullSecret'"
    $secret = (Capture kubectl @("-n", $PullSecretNamespace, "get", "secret", $PullSecretSource, "-o", "json")) -join "`n" | ConvertFrom-Json
    $copy = [ordered]@{
        apiVersion = "v1"
        kind       = "Secret"
        type       = $secret.type
        metadata   = [ordered]@{ name = $PullSecret; namespace = $Namespace }
        data       = $secret.data
    }
    $copy | ConvertTo-Json -Depth 6 | & kubectl apply -f -
    if ($LASTEXITCODE -ne 0) { throw "Could not create the registry secret" }
}
@{ apiVersion = "v1"; kind = "ServiceAccount"; metadata = @{ name = "default"; namespace = $Namespace }; imagePullSecrets = @(@{ name = $PullSecret }) } |
    ConvertTo-Json -Depth 6 | & kubectl apply -f -
if ($LASTEXITCODE -ne 0) { throw "Could not set the image pull secret on the default service account" }

if (-not (Test-Exists @("-n", $Namespace, "get", "secret", "rk-relay-peer"))) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    Run kubectl @("-n", $Namespace, "create", "secret", "generic", "rk-relay-peer", "--from-literal=token=$token")
    Write-Host "Created the replica token secret."
}

Step "Applying to $Namespace"
$rendered | & kubectl -n $Namespace apply -f -
if ($LASTEXITCODE -ne 0) { throw "kubectl apply failed" }

if ($LoadBalancerIP) {
    Run kubectl @("-n", $Namespace, "annotate", "svc", "rk-relay", "metallb.universe.tf/loadBalancerIPs=$LoadBalancerIP", "--overwrite")
}

Step "Waiting for the rollout"
& kubectl -n $Namespace rollout status deployment/rk-relay "--timeout=$($RolloutTimeoutSeconds)s"
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nThe rollout did not finish in time. Check before reverting:" -ForegroundColor Yellow
    Write-Host "  kubectl -n $Namespace get pods"
    Write-Host "  kubectl -n $Namespace logs deploy/rk-relay --tail=50"
    Write-Host "  .\deploy.ps1 -Rollback"
    exit 1
}

& kubectl -n $Namespace rollout status deployment/rk-relay-web "--timeout=$($RolloutTimeoutSeconds)s"
if ($LASTEXITCODE -ne 0) {
    Warn "The server browser did not become ready. Check: kubectl -n $Namespace get pods,ingress,certificate"
}

Step "Checking that replicas linked up"
$linked = $false
$deadline = (Get-Date).AddSeconds($PeerTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (Test-Peers) { $linked = $true; break }
    Start-Sleep -Seconds 3
}
if ($linked) { Ok "every pod reports its peers" }
else {
    Warn "Replicas did not all link within $PeerTimeoutSeconds seconds. Pilots on different pods will not see each other."
    Write-Host "  kubectl -n $Namespace logs deploy/rk-relay | findstr PEER"
}

Step "Result"
Run kubectl @("-n", $Namespace, "get", "pods", "-o", "wide")
Run kubectl @("-n", $Namespace, "get", "svc", "rk-relay")

$ErrorActionPreference = "Continue"
$ip = (& kubectl -n $Namespace get svc rk-relay -o "jsonpath={.status.loadBalancer.ingress[0].ip}" 2>$null)
$ErrorActionPreference = "Stop"
Write-Host ""
if ($ip) {
    Write-Host "Service address: $ip" -ForegroundColor Green
    Write-Host "Companion test on the LAN: relay_url=ws://${ip}:8787"
    if (-not $LoadBalancerIP) {
        Write-Host "To keep this address when the service is recreated: .\deploy.ps1 -LoadBalancerIP $ip" -ForegroundColor Yellow
    }
}
else {
    Warn "The service has no external address yet. Check the MetalLB pool and the service events."
}

Write-Host "Server browser: https://$Hostname (the certificate can take a minute to issue)"

Write-Host "`nStill to do by hand, see RUNBOOK.md:"
Write-Host "  1. Test with two Companions on the LAN"
Write-Host "  2. Add the DNS A record (no AAAA)"
Write-Host "  3. Add the OPNsense port forward for TCP 8787 to $(if ($ip) { $ip } else { 'the service address' })"
Write-Host "  4. From outside, check /health and that the CONNECT log shows the real address"

if ($warnings.Count) {
    Write-Host "`n$($warnings.Count) warning(s):" -ForegroundColor Yellow
    $warnings | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}
Write-Host "`nDeployed $ref"
