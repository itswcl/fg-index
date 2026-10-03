# OCI API bootstrap

This runbook covers the initial bootstrap of the compiled API on the existing OCI VM behind Caddy. Initial service startup keeps `SCHEDULERS_ENABLED=false`; only one backend may run alert schedulers. This bootstrap task does not register a runner or implement deployment automation. The owner stages the first verified artifact manually as a temporary bootstrap step; a separate reviewed task will implement the user-approved automated deployment using a restricted repo-scoped runner on the same VM or another reviewed mechanism.

## Preflight and artifact gate

Before a host change, confirm the current OCI account and VM remain within the $0/Always Free constraint, check available disk space, and record the approved full `main` commit SHA.

Use only the production artifact from a successful `push` workflow run on `main` for that exact SHA. A pull-request run can build against GitHub's synthetic merge commit; its `GITHUB_SHA` and uploaded artifact are not the production source. The passing artifact from PR #182 is an example of a validation artifact, not a deployment artifact.

Download the artifact named `api-production-<main-sha>` from the matching successful run and unpack the GitHub artifact bundle into an empty staging directory. Verify the tarball sidecar before trusting or extracting the tarball, then inspect its manifest and file list:

```sh
sha256sum -c api-release.tar.gz.sha256
tar -tzf api-release.tar.gz
tar -xOf api-release.tar.gz ./RELEASE-MANIFEST.txt
```

Require `source_commit` in the manifest to equal the approved main SHA. Confirm `node_version` is a supported Node 24 release.

The archive contains `apps/api-server` and `packages/shared-types`. For this initial bootstrap only, transfer it from the owner's workstation over the existing approved SSH path. This temporary manual staging is not the final deployment architecture. Do not store GitHub credentials or runner tokens on the VM as part of this bootstrap task; the separate automation task must review its own credentials, permissions, and rollback path.

## Node.js runtime

Install the exact Node version recorded in the verified artifact manifest from the official Node.js release site. Select the Linux archive matching `uname -m`, verify the signed `SHASUMS256` file and the selected archive checksum, and do not use a per-user version manager. Node 24 is the supported LTS line; as of this review the [official download page](https://nodejs.org/en/download/) lists v24.21.0 LTS, with updates scheduled through April 2028 per the [release schedule](https://nodejs.org/en/blog/migrations/v22-to-v24). Recheck the current patch and support status at deployment time.

```text
/opt/nodejs/releases/node-v<version>/
/opt/nodejs/current -> /opt/nodejs/releases/node-v<version>
```

Keep `/opt/nodejs` root-owned and not writable by the service account. Point systemd at `/opt/nodejs/current/bin/node`. This avoids replacing the host's existing `/usr/bin/node`; update the `current` symlink only to a verified release. Check the runtime with `/opt/nodejs/current/bin/node --version` and `sudo -u fg-index /opt/nodejs/current/bin/node --version`.

## Account, release, and environment

Create the `fg-index` system group and a same-named system user with home `/var/lib/fg-index` and shell `/usr/sbin/nologin`. Make the home directory owned by `fg-index:fg-index`; the application does not need a writable release or log directory.

Keep `/opt/fg-index`, its `releases` directory, each release, and `current` root-owned and group-readable by `fg-index` (directories `0750`, regular files `0640`, preserving executable bits on any executable artifact files). Extract each verified archive into `/opt/fg-index/releases/<main-sha>`, set ownership and permissions, then atomically point `/opt/fg-index/current` at that release. The service account must not be able to modify application code.

The release poller described in PR #188 stages verified candidates under `/var/lib/fg-index-release-poller/staged` with its own service identity. It is not a member of group `fg-index` and has no write access under `/opt/fg-index`. The manual helper described below is separate code; this runbook update does not install it on the VM or grant the poller access to the deployment tree.

## Offline promotion into the inactive release tree

The reviewed helper `ops/promote_api_release.py` independently verifies one staged candidate and copies its application files into `/opt/fg-index/releases/<SHA>`. It does not change `/opt/fg-index/current`, restart or enable a service, change scheduler ownership, call GitHub, or use the poller-owned verification marker as proof. Promotion remains a manual root action after this code and the host prerequisites have been reviewed; merging the helper does not authorize a host installation or promotion.

### Trust-root provisioning

On a trusted, internet-connected administrator workstation with a trusted GitHub CLI installation, obtain the Sigstore trust-root snapshot:

```sh
gh attestation trusted-root > trusted_root.jsonl
sha256sum trusted_root.jsonl
```

Record the fetch date and SHA-256 out of band. GitHub's command returns roots for both the Sigstore Public Good instance and GitHub's Sigstore instance; this public repository currently uses Public Good. Transfer the file to the VM only through an independently trusted host access path. Do not learn or accept the VM's SSH host key from a network observation. Install it as a root-owned, non-writable file:

```sh
sudo install -d -o root -g root -m 0755 /etc/fg-index-release-promoter
sudo install -o root -g root -m 0644 trusted_root.jsonl \
  /etc/fg-index-release-promoter/trusted_root.jsonl
sudo stat -c '%U:%G %a %n' /etc/fg-index-release-promoter/trusted_root.jsonl
```

`gh attestation trusted-root` obtains trust metadata through Sigstore's TUF trust mechanism. Refresh the snapshot when importing later artifacts; offline verification cannot learn about a key rotation or revocation that happened after the snapshot. Keep the recorded digest with the operator's release evidence. The helper checks that the trust-root file and its directory are regular, root-owned, and not writable by group or other users.

### Host requirements and operation

Before installing or running the helper, verify that the host has Python 3.12 or newer; a trusted, root-installed GitHub CLI supporting `attestation verify --bundle`, `--custom-trusted-root`, and `--deny-self-hosted-runners`; the dedicated poller staging tree; the `fg-index` group; and a root-owned, non-writable `/opt/fg-index/releases` tree beneath a root-owned parent. The promoter snapshots the archive, checksum, and bundle into private temporary storage on the release filesystem before verification, so it does not trust a path or marker owned by the poller. Its capacity preflights preserve an 8 GiB byte reserve and 10,000 free inodes for both evidence snapshot and expansion.

Install the reviewed helper as root-owned code at `/usr/local/libexec/fg-index-release-promoter/promote_api_release.py`. A later, separately authorized manual promotion uses only the full lowercase source SHA:

```sh
sudo /usr/local/libexec/fg-index-release-promoter/promote_api_release.py <40-character-main-sha>
```

The helper checks the archive checksum and retained evidence, then uses the local bundle and trusted root to verify the exact repository, source SHA, `refs/heads/main`, `.github/workflows/ci.yml` signer, and SLSA provenance predicate without saved GitHub credentials. It validates archive paths, member types, symlinks, size, and the embedded `source_commit`, then atomically creates the inactive release directory with `root:fg-index` ownership. An existing SHA destination is never overwritten. If verification, extraction, ownership, or the capacity preflight fails, no release is installed. Activating the release by changing `current` and restarting the API remains a separate reviewed and approved operation.

Create `/etc/fg-index` as `root:fg-index`, mode `0750`, and `/etc/fg-index/api.env` as `root:fg-index`, mode `0640`. The API service can read the file; the release poller cannot traverse the directory because it runs only in its dedicated group. An owner enters values on the host only; repository files and handoffs contain variable names, never values. Required names are:

```text
CNN_FEAR_GREED_URL
GOOGLE_FINANCE_VIX_URL
YAHOO_FINANCE_VIX_URL
GOOGLE_FINANCE_BTC_URL
YAHOO_FINANCE_BTC_URL
GOOGLE_FINANCE_SPX_URL
YAHOO_FINANCE_SPX_URL
SCRAPER_USER_AGENT
DATABASE_URL
DIRECT_URL
SUPABASE_URL
SUPABASE_JWKS_URL
INTERNAL_API_KEY
```

Optional names are `CORS_ORIGIN` and `MASSIVE_API_KEY`. Set `INTERNAL_API_KEY` explicitly to its production value; do not rely on the development default. With `NODE_ENV=production`, the API refuses to start when this value is missing or set to `dev-key-123`. Set `CORS_ORIGIN` to the Pages origin when preparing the host.

Systemd gives `EnvironmentFile=` entries precedence over matching `Environment=` entries ([systemd.exec](https://man7.org/linux/man-pages/man5/systemd.exec.5.html)). The unit therefore fixes `NODE_ENV`, `HOST`, `PORT`, and `SCHEDULERS_ENABLED` in the final `/usr/bin/env` invocation. Keep those reserved names out of `api.env` as well; the service must start with production mode, `127.0.0.1:8080`, and schedulers disabled. Confirm the installed runtime with `/opt/nodejs/current/bin/node --version`, including when run as `fg-index`.

## Service and Caddy

Install `fg-index-api.service` as `/etc/systemd/system/fg-index-api.service`. It runs as `fg-index`, reads the protected environment file, uses the root-owned release through `/opt/fg-index/current`, and sends logs to journald. Its `TimeoutStopSec=30s` accommodates the planned #184 shutdown contract: a shared 20-second HTTP/WebSocket/alert-work drain followed by the existing 5-second Prisma disconnect cap, leaving 5 seconds of margin. Keep that value in sync if the shutdown contract changes; until the matching backend code is merged and in the verified artifact, do not claim alert-work draining is active.

Inspect `/etc/caddy/Caddyfile` and update or add this site block without duplicating it or replacing unrelated sites. Keep the upstream at `127.0.0.1:8080`. Caddy's [`reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) handles WebSocket upgrades, so do not add custom `Connection` or `Upgrade` headers. Do not expose port 8080 through OCI ingress or the host firewall.

After reviewing the staged files, validate the unit and Caddy configuration, then reload and start them:

```sh
sudo systemd-analyze verify /etc/systemd/system/fg-index-api.service
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl reload caddy
sudo systemctl enable --now fg-index-api
sudo systemctl status fg-index-api
sudo journalctl -u fg-index-api -n 100 --no-pager
```

## Liveness and readiness

Use systemd process state and the loopback listener for liveness:

```sh
sudo systemctl is-active fg-index-api
sudo ss -lntp 'sport = :8080'
curl --max-time 2 --silent --show-error --output /tmp/fg-index-health.json \
  --write-out 'HTTP %{http_code}\n' http://127.0.0.1:8080/api/health
```

Do not add curl's `--fail` option. With schedulers disabled, `/api/health` can return a JSON `503 degraded` because its market caches are empty. That is a readiness result; an HTTP response plus an active service and loopback listener demonstrate liveness. A timeout, connection failure, or Caddy upstream error needs investigation. Keep the readiness `503` visible; do not restart the process solely because schedulers are off.

The listener must be `127.0.0.1:8080` only; stop if it appears on `0.0.0.0:8080` or `[::]:8080`. At a separately approved cutover, confirm the Render worker is stopped, then use a reviewed systemd drop-in that replaces `ExecStart` with the same fixed environment except `SCHEDULERS_ENABLED=true`. Run `daemon-reload` and restart OCI only after Render is confirmed off. For fallback, turn OCI schedulers off and confirm they stopped before re-enabling Render.

Keep Render's scheduler active while OCI starts with schedulers disabled so two workers never run at once.

## Host firewall correction (separate guarded operation)

The read-only audit found the host's IPv4 nftables INPUT policy set to `accept` with no deny rule; UFW is absent. This does not describe every IPv6 or chained rule, so inspect the complete live and persistent IPv4/IPv6 ruleset and the active firewall service before planning a correction. OCI security lists/NSGs remain a separate layer. Do not widen or otherwise change OCI SSH ingress as part of this work.

The target host policy is default-deny inbound with explicit allowances for loopback, established/related traffic, SSH only from the already-approved source CIDR(s), Caddy on TCP 80/443, and required ICMP/ICMPv6 or DHCP traffic. Keep outbound policy unchanged and do not allow inbound 8080. Preserve existing OCI and host-managed rules; do not flush the whole nftables ruleset. This PR contains no host-specific firewall configuration and changes no SSH rules.

For a later firewall change, save the active and persistent rules first. Keep the current SSH session open and schedule a five-minute systemd timer to invoke a root-owned one-shot rollback script that restores both snapshots before applying the new policy. After applying it, open a new independent SSH session from an already-approved source and verify Caddy on 80/443, the local API on 127.0.0.1:8080, and that 8080 is unreachable externally. Cancel the timer only after those checks pass. If a new SSH session fails, leave the timer armed and allow restoration. If the approved SSH source range or required IPv6/network-control rules are unknown, do not apply the default-deny policy yet.

## Cost and ownership boundary

Use the existing Always Free VM only; recheck account status, budget, and disk before execution. Budget displays are not a hard spending cap. This bootstrap task creates no OCI resources, paid services, or runner registration. The GitHub-hosted workflow builds the artifact. An owner handles production secret values and the temporary initial artifact transfer; no secret values go into this repository, CI logs, or this runbook. The later reviewed automation task will decide and implement the approved restricted deployment mechanism.
