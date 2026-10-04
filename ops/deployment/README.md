# Root API deployment controller

`ops/deploy_api_release.py` owns image activation, durable receipts, recovery and
local watchdog rollback. It reuses the unchanged root promoter and existing
unprivileged poller. Its default `--check` reads only; it never provisions state,
adopts an unknown image, starts the API, resets failed units, installs Node,
migrates a database, deletes an image or enables a timer.

## Installation and adoption are separate operational gates

These unit templates are **disabled** until PM/QA accept installation, adoption,
controlled deployment/recovery, retention and cadence. This PR provides source
and CI coverage only. Keep `fg-index-release-poller.timer` disabled. Root
coordinates units; application imports, anonymous WS and `SELECT 1` probes run
as `fg-index` in bounded transient units with captured/discarded child output.
No authenticated HTTP, JWT or User writes are used.

A reviewed installation must create `/var/lib/fg-index-deployment` root:root
0700, install the controller root:root0755 under
`/usr/local/libexec/fg-index-deployment/`, and provide a root:root0600
`/etc/fg-index/deployment-policy.json` (parents root-owned without write grants
or ACLs). There is no default permissive policy. Required policy shape:

```json
{
  "schema_version": 1,
  "role": {"generation": 1, "enabled": true},
  "boot_enabled": true,
  "schema": "<reviewed SHA256 of apps/api-server/prisma/schema.prisma>",
  "nodes": {"v24.21.0": "<reviewed SHA256 of /opt/nodejs/releases/node-v24.21.0/bin/node>"},
  "pins": {
    "/usr/local/libexec/fg-index-deployment/deploy_api_release.py": "<reviewed SHA256>",
    "/usr/local/libexec/fg-index-release-promoter/promote_api_release.py": "<accepted SHA256>",
    "/usr/local/libexec/fg-index-release-poller/poller.py": "<accepted SHA256>",
    "/etc/fg-index-release-promoter/trusted_root.jsonl": "<accepted SHA256>",
    "/etc/systemd/system/fg-index-api.service": "<accepted SHA256>",
    "/etc/systemd/system/fg-index-release-poller.service": "<accepted SHA256>",
    "/etc/systemd/system/fg-index-api.service.d/10-scheduler-owner.conf": "32452cac8814231866521e8e5af192f7aa4df9b12573309ac071e499b8bcef64",
    "/root/fg-index-api-activation-fa654555b1692111af882f45/scheduler-owner-receipt.json": "<accepted complete owner receipt SHA256>",
    "/root/fg-index-api-activation-fa654555b1692111af882f45/boot-enable-receipt.json": "6b38e986dba34088e42d4027f34850a5d8fe4f06b987098eff39a74961903f33"
  },
  "manual_adoption": {"<full independently accepted source SHA>": "<reviewed image inventory SHA256>"}
}
```

Placeholders are invalid. After independent provenance/image/runtime acceptance,
review the canonical inventory: sorted walk of all relative paths, each encoded
as compact JSON `[relative_path, permission_bits, content_sha256_or_directory_or_link_target]`
plus newline, fed into SHA256. `Host.image` is the single implementation;
use it in the reviewed read-only preparation script to obtain the digest,
then independently compare the installed tree against accepted archive contents.
A directory existing under `/opt/fg-index/releases` is insufficient evidence.
The policy's exact manual-adoption entry is the operator's explicit approval
of that independently verified tree, including source, schema and runtime.

Execute exactly the reviewed command after fresh runtime acceptance:

```text
sudo /usr/bin/python3.12 /usr/local/libexec/fg-index-deployment/deploy_api_release.py \
  --adopt <full accepted SHA> --inventory <reviewed inventory SHA256>
```

Adoption requires absent state, exact policy approval/inventory, accepted schema,
provisioned Node binary, exact app+Node links, loaded argv/scheduler role,
positive stable PID, zero restarts, loopback listener, structured health,
anonymous WS and read-only DB. It protects evidence and atomically writes the
first known-good receipt; it does not switch links/start/enable any service.
`--check` then validates receipt inventory, runtime and pins without probes or
writes. Never hand-edit state to bypass adoption or clear a HOLD.

## Transaction and recovery

```text
shared root lock + private state + exact policy/unit/runtime
  baseline -> protect evidence -> public immutable main -> existing poller
  durable promotion intent -> unchanged promoter -> root inventory receipt
  exact-main recheck -> role/links recheck -> durable activation intent
  stop + no PID/control PID/listener -> switch both links -> start
  stable PID/NRestarts0 + bounded HTTP/anonymous WS/SELECT1
  commit current + previous rollback receipts
```

State (`state.json`, root0600) and parent are fsynced on each stage. A failed
write/replace/fsync during activation or rollback stops only a positively
identified transaction-owned API and records HOLD if persistence permits; it
never starts another process. Commit is written from a copy while retaining
the started transaction, so a failed commit cannot erase its recovery intent. Check rejects
an incomplete transaction. Crash recovery `--recover` accepts only recorded
activation stages and transaction-owned link targets; it restores the prior
verified image once under the **current committed role generation**. Promoting
or interrupted rollback stages, changed role/links/inventory, failed stop and
partial/unknown receipts HOLD for a new reviewed operator action. No speculative
link overwrite, reset-failed, second automatic rollback or bad-SHA retry occurs.

Hard new-image failure triggers one stop/restore/start/accept attempt. Baseline
DB failure never touches a healthy current API. A DB failure after activation
allows one fallback; failure there records HOLD, preserving the receipt rather
than trying more images. Watchdog clears the hard-failure counter on provider-only DB degradation; two
consecutive hard HTTP/WS/runtime failures allow one recorded local rollback.
Cold-cache structured503 is accepted. Restart count or PID drift is failure.

`--once` does not silently adopt a root image left by a prior interrupted
promotion. If main advances after promotion, it records HOLD and retains the
inactive image for reviewed disposition. Images with unknown/different schema
fingerprints or unprovisioned Node versions are ineligible. No schema migration
or downgrade is performed.

## Role, retention and cadence limitations

The accepted production state is OCI role true, generation1, with API boot
startup enabled. Policy pins the committed owner/boot receipts and only
`10-scheduler-owner.conf` with its accepted exact hash. The shared lock is
`/root/fg-index-api-activation-fa654555b1692111af882f45/role-deployment.lock`,
also used by the accepted role/boot scripts. No generic drop-ins are allowed.
The initial false/disabled contract requires absence of owner/boot receipts
and boot link; a later owner transition requires a separate reviewed contract
revision and Backend/PM positive persistent other-owner-off evidence.
A local lock does not fence a remote host.
Rollback preserves the current role, including a separately approved true
role. No automatic Render worker activation or cross-host failover exists.

The controller adds current/rollback/pending evidence to the existing root
protected-SHA policy and never removes existing protected entries. The poller
still enforces its three-candidate cap and capacity reserves; the promoter
independently enforces8GiB/10000inode reserves on new images. A full protected
set holds. Root-image pruning and unprivileged rejected-candidate retirement
remain a dependent PR; **do not enable these timers before that gate**.
Unknown root images are never overwritten/pruned. This conservative first
controller may eventually HOLD at capacity, requiring reviewed retirement.

Suggested cadence templates: deployment2min after boot /10min after completion,
with30s jitter; watchdog1min after boot/completion. Both use the same nonblocking
lock. No `[Install]` section exists on the services; timers are opt-in.
Proposed coordinator30min/watchdog10min envelopes replace the initial
15min/4min estimate to include bounded90s inventories and recovery. These are
source templates awaiting operational approval; health waits at
most60s, each HTTP3s, WS5s and DB8s. The watchdog envelope includes current-image verification, a failed health
window, both recovery inventory checks, stop/start and a second health window.
Individual fixed commands have bounded timeouts; image hashing checks its
90s deadline per chunk. No claim of a120s total rollback is made. Installation must verify templates with the
installed systemd version before any enablement.

Tests use the same `Controller` interface with real temporary durable files,
controlled host adapter, interruption at each activation stage, partial links,
ambiguous stops, role drift, bad image/provenance, single recovery and DB outage.
Linux CI validates units and native no-ACL behavior. No host mutation is needed
for these tests.

The loaded poller is checked before starting: exact fragment/no drop-ins,
fg-index-release-poller identity, one exact Python/poller argv, empty env-file
and working-directory properties, and3min timeout. Disk pins alone are
insufficient. Both root controller units expose home read-only and whitelist
only the accepted role-stage directory for shared-lock writes. Linux CI uses
a synthetic root directory to verify this systemd namespace contract; it never
touches the production stage or starts an application.
