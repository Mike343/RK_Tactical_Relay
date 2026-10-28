# Run book: build and deploy to the cluster

This deploys the relay to the same Kubernetes cluster that runs Hangar Addons, in its own namespace. It shares nothing with Hangar Addons except the nodes, the registry and MetalLB. Nothing here touches the `hangaraddons` namespace.

Values used below, change them if you want something different:

| Item | Value |
|---|---|
| Namespace | `rk-relay` |
| Image | `registry.geiseit.com/rk-tactical-relay:<tag>` |
| Kube context | `kubernetes-admin@kubernetes` |
| Public port | TCP 8787 |

## Scripted deploy

`deploy.ps1` does steps 0 to 5 below in one go from a PowerShell terminal, and handles a fresh start with nothing in the cluster yet.

First deploy from scratch:

```powershell
docker login registry.geiseit.com
.\deploy.ps1 -DryRun -LoadBalancerIP 192.168.1.241
.\deploy.ps1 -LoadBalancerIP 192.168.1.241
```

Other options:

```powershell
.\deploy.ps1                 # test, build, push, apply, wait, show result
.\deploy.ps1 -Yes            # same, without the confirmation prompt
.\deploy.ps1 -DryRun         # preflight checks and rendering only, change nothing
.\deploy.ps1 -SkipTests      # skip go vet and the race tests
.\deploy.ps1 -SkipBuild -Tag abc1234   # redeploy an image that is already pushed
.\deploy.ps1 -Status         # pods, autoscaler, service, players and peers per pod
.\deploy.ps1 -Rollback       # undo to the previous revision
.\deploy.ps1 -Teardown       # delete the namespace, after typing its name to confirm
```

What it does:

- **Preflight:** it refuses to run unless the kubectl context is `kubernetes-admin@kubernetes`. It checks the cluster answers, a container engine exists, the registry login is saved, and the MetalLB pool. If you pass `-LoadBalancerIP` it fails when another service already holds that address. It also checks that metrics server answers and that the network plugin enforces policies (Calico does here). Problems that don't block the deploy show up as warnings, repeated at the end.
- **Fresh start:** the first run creates the namespace, copies the registry secret from `hangaraddons` (pass `-PullSecretSource <name>` if there is more than one) and creates the replica token. Later runs leave those alone.
- **Address:** `-LoadBalancerIP` pins the MetalLB address so the OPNsense forward keeps working if the service is ever recreated. Only `.240` is used in the pool today (by ingress), so `192.168.1.241` is free. Without the flag it takes the next free address and tells you how to pin it.
- **Replica check:** after the rollout it asks every pod for its `/health` and waits up to 90 seconds for each one to report all its peers. If they don't link it warns, because pilots on different pods wouldn't see each other.
- **Slow rollouts:** it does not roll back on its own if a rollout is slow, it tells you what to check first.
- **Teardown:** it refuses to delete system namespaces, `hangaraddons` and the other namespaces already on the cluster that it recognises. The DNS record and the OPNsense rule are removed by hand.

At the end it prints the service address and the manual steps that remain: the LAN test, the DNS record, the OPNsense forward and the outside check. The manual steps below are the same thing spelled out.

## 0. Before you start

```sh
kubectl config current-context
kubectl get nodes
kubectl -n metallb-system get ipaddresspools
kubectl top nodes
```

- The context must be `kubernetes-admin@kubernetes`.
- MetalLB needs a free address in its pool (the pool is .240 to .250 and ingress already uses .240). The service takes the next free one on its own, or pin one with `metallb.universe.tf/loadBalancerIPs` on `deploy/k8s/service.yaml`.
- `kubectl top` working means metrics server is there, which the autoscaler needs.
- The network policy only works if the cluster network plugin enforces policies. Check that before relying on it to protect port 8788.
- The pods have no node selector. They land on geit-2, 3 and 4 (the data nodes) since geit-1 and astro are tainted. They are small, so that is fine.

## 1. Test the code

```sh
go vet ./...
go test -race -count=1 ./...
```

On Windows without Go installed, run the same inside a container:

```sh
podman run --rm -v "$PWD:/src" -w /src golang:1.24-alpine sh -c "apk add --no-cache gcc musl-dev && go vet ./... && CGO_ENABLED=1 go test -race -count=1 ./..."
```

## 2. Build and push the image

Tag with the commit, not `latest`, so a rollback is exact.

```sh
TAG=$(git rev-parse --short HEAD)
IMG=registry.geiseit.com/rk-tactical-relay:$TAG
docker login registry.geiseit.com
docker build -t $IMG .
docker push $IMG
```

Check it landed:

```sh
curl -s -u "$REGISTRY_USER:$REGISTRY_PASSWORD" https://registry.geiseit.com/v2/rk-tactical-relay/tags/list
```

## 3. Create the namespace and secrets

```sh
kubectl create namespace rk-relay
```

The registry needs a login, so the namespace needs a pull secret. Either copy the one Hangar Addons uses, or make a new one.

Copy:

```powershell
kubectl -n hangaraddons get secrets --field-selector type=kubernetes.io/dockerconfigjson
$s = kubectl -n hangaraddons get secret regcred -o json | ConvertFrom-Json
@{ apiVersion = "v1"; kind = "Secret"; type = $s.type; metadata = @{ name = "registry-creds"; namespace = "rk-relay" }; data = $s.data } |
  ConvertTo-Json -Depth 6 | kubectl apply -f -
```

Change `regcred` to the name the first command lists if it differs. The copy is named `registry-creds` so it matches the patch below and `deploy.ps1`.

Or create:

```sh
kubectl -n rk-relay create secret docker-registry registry-creds \
  --docker-server=registry.geiseit.com \
  --docker-username="$REGISTRY_USER" \
  --docker-password="$REGISTRY_PASSWORD"
```

Attach it to the default service account so the deployment doesn't need editing (use your secret's name):

```powershell
@{ apiVersion = "v1"; kind = "ServiceAccount"; metadata = @{ name = "default"; namespace = "rk-relay" }; imagePullSecrets = @(@{ name = "registry-creds" }) } |
  ConvertTo-Json -Depth 6 | kubectl apply -f -
```

Then the token the replicas use to authenticate to each other. Create it once and keep it out of git:

```sh
kubectl -n rk-relay create secret generic rk-relay-peer --from-literal=token=$(openssl rand -hex 32)
```

## 4. Deploy

This swaps in the real image while applying, so no pod ever tries to pull the placeholder name:

```sh
kubectl kustomize deploy/k8s \
  | sed "s#image: rk-tactical-relay:latest#image: $IMG#" \
  | kubectl -n rk-relay apply -f -
kubectl -n rk-relay rollout status deployment/rk-relay --timeout=180s
```

Pods stay not ready for about 8 seconds after start on purpose, so they can link to each other before taking pilots.

## 5. Check it

```sh
kubectl -n rk-relay get pods -o wide
kubectl -n rk-relay logs deploy/rk-relay --tail=30
```

Each pod should log `PEERING enabled` and then `PEER_UP` for the other pod. If there is no `PEER_UP`, see the troubleshooting table.

Reach one pod from your PC:

```sh
kubectl -n rk-relay port-forward deploy/rk-relay 18787:8787
curl http://127.0.0.1:18787/health
curl http://127.0.0.1:18787/ready
```

`/health` should show `"peers":1` with two replicas. The dashboard for that pod is at `http://localhost:18787/dashboard` while the port forward is open.

## 6. Open it to Companions

Find the address MetalLB gave the service:

```sh
kubectl -n rk-relay get svc rk-relay
```

Test from the LAN first, with a Companion pointed at it:

```
relay_url=ws://<EXTERNAL-IP>:8787
```

Run two Companions, one on each side if you can, and confirm they see each other and that combat reaches the target. Do this before exposing it publicly.

Then, for the internet, add the DNS record and the OPNsense port forward in the next section. Companions then use `relay_url=ws://rk.hangaraddons.com:8787`. Keep 8787 so existing Companion configs work.

Check that real addresses come through. Connect from outside your network and look at the log:

```sh
kubectl -n rk-relay logs deploy/rk-relay | grep CONNECT
```

The `address=` should be the pilot's public address. If it shows a node or the router, see the troubleshooting table.

## Opening the port on OPNsense

Do this once, after the deploy is healthy and a LAN test with two Companions has worked. Only TCP 8787 is opened. Never forward 8788, that is the replica link.

### What you need first

```sh
kubectl -n rk-relay get svc rk-relay
```

Note the `EXTERNAL-IP`, this is the redirect target. MetalLB hands out the next free address, so pin it before you build the rule. Otherwise a deleted and recreated service could get a different address and the forward would silently point at nothing. Add this to the metadata of `deploy/k8s/service.yaml` and deploy again:

```yaml
  annotations:
    metallb.universe.tf/loadBalancerIPs: 192.168.1.241
```

Pick an address in the MetalLB pool (.240 to .250) that nothing else uses. .240 is the ingress and .241 was free when I checked. `deploy.ps1 -LoadBalancerIP` does this for you.

Also decide the public address. The simplest is to reuse the one the websites use (4.17.242.66 from my notes, check it against what you have). Port 8787 doesn't clash with the 80 and 443 forwards. A separate address from your block needs a virtual IP on the WAN interface first.

### DNS

Add an A record, for example `rk.hangaraddons.com`, pointing at that public address. Don't add an AAAA record. The service only has an IPv4 address, so an AAAA record would send IPv6 clients to a dead end.

### The server browser

`deploy.ps1` also deploys the page at `https://rk.hangaraddons.com` (change it with `-Hostname`). It uses the existing nginx ingress and `letsencrypt-production`, so the same A record covers it as long as ports 80 and 443 already reach the ingress, like they do for the websites. The certificate can take a minute to issue. If it stays pending, `kubectl -n rk-relay get certificate,challenge` says why.

### The port forward

In OPNsense open Firewall, NAT, Port Forward (called Destination NAT on newer versions) and add a rule:

| Field | Value |
|---|---|
| Interface | WAN |
| TCP/IP version | IPv4 |
| Protocol | TCP |
| Source | any |
| Destination | the public address chosen above (or WAN address) |
| Destination port range | 8787 to 8787 |
| Redirect target IP | the service EXTERNAL-IP |
| Redirect target port | 8787 |
| Description | RK Tactical Relay |
| NAT reflection | Enable (only if LAN machines will use the public name) |
| Filter rule association | Add associated filter rule |

Save, then Apply changes. The associated filter rule lets the traffic through, so no separate WAN rule is needed. If you create the rule by hand instead, it is pass, WAN, TCP, destination the public address, port 8787.

Don't turn on outbound NAT or source rewriting for this traffic. The service keeps the real client address because of `externalTrafficPolicy: Local`, and masquerading the connection would put the firewall address in every log line and make the per address limit apply to everyone at once.

### LAN clients using the public name

A machine inside the network that connects to `rk.hangaraddons.com` goes out and back through the firewall. Either keep NAT reflection on in the rule above, or add a split DNS override in PowerDNS or Unbound so the name resolves to the service's LAN address inside the network. The override is cleaner.

### Checking it

From outside the network (a phone on mobile data works):

```sh
curl http://rk.hangaraddons.com:8787/health
```

It should return JSON with `"ok":true`. Then connect a Companion with `relay_url=ws://rk.hangaraddons.com:8787` and look at the log:

```sh
kubectl -n rk-relay logs deploy/rk-relay | grep CONNECT
```

The `address=` must be the pilot's real public address. In OPNsense, Firewall, Log Files, Live View shows the traffic hitting the rule if it doesn't connect.

### Backing it out

Disable the port forward rule and apply changes. That closes the port straight away and leaves the deployment running for LAN testing.

## 7. Upgrade

```sh
TAG=$(git rev-parse --short HEAD)
IMG=registry.geiseit.com/rk-tactical-relay:$TAG
docker build -t $IMG . && docker push $IMG
kubectl kustomize deploy/k8s \
  | sed "s#image: rk-tactical-relay:latest#image: $IMG#" \
  | kubectl -n rk-relay apply -f -
kubectl -n rk-relay rollout status deployment/rk-relay --timeout=180s
```

Pods roll one at a time. Each old pod drains for 10 seconds and then closes its pilots, who reconnect to the other pod. Expect a brief reconnect for pilots on the pod being replaced.

Roll back:

```sh
kubectl -n rk-relay rollout undo deployment/rk-relay
```

## 8. Scaling

The autoscaler runs 2 to 6 pods on CPU. To change the range, edit `deploy/k8s/hpa.yaml` and apply it again. Don't use `kubectl scale`, the autoscaler will undo it. Replicas link in a full mesh, which is fine for a handful of pods.

## 9. Remove it

```sh
kubectl delete namespace rk-relay
```

Then remove the DNS record and the OPNsense forward.

## Troubleshooting

| Symptom | Check |
|---|---|
| `ImagePullBackOff` | The pull secret is attached to the default service account and the tag exists in the registry. `kubectl -n rk-relay describe pod` shows the exact error. |
| Pods never become ready | Readiness waits about 8 seconds, then needs `/ready` to answer. Check the log for a crash. |
| No `PEER_UP`, `"peers":0` | The `rk-relay-peer` secret exists. `POD_IP` is set. The headless service is `rk-relay-peers` and `PEER_DNS` matches it. The network policy isn't blocking port 8788. |
| Pilots on different pods can't see each other | `/health` on both pods must show `peers` of 1 or more. Peer links form within about 5 seconds of a pod appearing. |
| Log addresses are a node or router address | The service must keep `externalTrafficPolicy: Local`. With an ingress in front, `TRUST_PROXY` has to be true and the ingress must send `X-Forwarded-For`. |
| No external IP on the service | MetalLB pool is full or the address is taken. Check `kubectl -n metallb-system get ipaddresspools` and the service events. |
| Pilot connection resets after a long idle | Anything in front with a short idle timeout. The relay pings every 5 seconds, so the proxy timeout should be well above that. |
| `too many connections` | One address has more than `MAX_CONNS_PER_IP` connections, 64 by default. Raise it in `deploy/k8s/deployment.yaml` if a big group shares one public address. |
| Autoscaler shows unknown | Metrics server isn't returning pod CPU. `kubectl top pods -n rk-relay` should work. |

## Things to remember

- Nothing has been run against real Companions on this cluster yet. Test with two before you announce the address.
- The room lives in memory, so a restart of every pod at once drops everyone. Rolling updates never do that.
- Port 8788 is the replica link. It is not on the public service, and must never be forwarded.
