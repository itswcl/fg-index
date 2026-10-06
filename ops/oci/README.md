# OCI API host contract

The API runs on the existing Always Free OCI VM behind Caddy. The listener stays on `127.0.0.1:8080`; the existing proxy serves `https://fg-index-api.duckdns.org` and `wss://fg-index-api.duckdns.org`. Do not open port 8080 or change ingress as part of release deployment.

## Runtime and configuration

- Install the API unit as `/etc/systemd/system/fg-index-api.service`.
- Keep the API environment at `/etc/fg-index/api.env`, `root:fg-index`, mode `0640`. Record required variable names only; enter values on the host and never copy them into a repository, CI log, or handoff.
- The reviewed unit uses `/opt/nodejs/current/bin/node` (Node 24), `/opt/fg-index/current/apps/api-server/dist/index.js`, and the fixed loopback host and port.
- Keep release directories and `current` root-owned and readable by `fg-index`; the service account cannot modify application files.
- The base API unit keeps `SCHEDULERS_ENABLED=false`. Preserve the existing scheduler-owner drop-in exactly. Only one backend may own alert schedulers; verify Render is stopped before changing ownership.
- Preserve the API's existing `SIGTERM` shutdown behavior and `TimeoutStopSec=30s` during restart.

## Release operations

The artifact publisher, verifier poller, offline promoter, serialized installer, manual rollback, and one-time source-bound host transition are documented in [`ops/deployment/README.md`](../deployment/README.md). The transition leaves the API inactive, retains the existing current release, removes the obsolete boot guard and watchdog/recovery units, and leaves the new deployment timer disabled for independent QA and CI.

The release selection is determined by `/opt/fg-index/current` and its source manifest. Deployment attempts a fixed `systemctl restart fg-index-api.service` after recording the selected version. A restart error is reported while that selection remains current. There is no automatic application rollback or health-based deployment gate. The existing UptimeRobot outage alerts remain unchanged; rollback is a manual operator action.

## Proxy and secrets

Keep the Caddy upstream at `127.0.0.1:8080` and preserve its existing request-log redaction policy. Caddy handles WebSocket upgrades in `reverse_proxy`; do not add custom `Connection` or `Upgrade` headers. Never inspect, echo, or transfer values from `api.env` during release deployment.
