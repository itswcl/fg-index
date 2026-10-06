# OCI API release operations

The API release chain is: attested `main` artifact → unprivileged poller verification → root offline promotion → one root deployment cadence. The poller keeps its private three-candidate limit and the existing 8 GiB / 10,000-inode reserve. The root release tree retains exactly the selected and previous releases. Unknown pre-transition trees require an explicit disposition.

## Install and restart

The root deployment service takes one nonblocking lock shared by automatic install, manual rollback, and operator restart. For a new candidate it asks the poller to fetch the exact current `main` SHA, checks that `main` stayed unchanged, and considers only the staged directory for that SHA. A waiting or newer main commit never falls back to an older staged candidate. The offline promoter independently verifies the artifact checksum, GitHub attestation, source commit, archive paths, and capacity before atomically installing a fresh inactive release tree.

Before promotion, the installer durably records the exact SHA as its promotion intent and protects that staged evidence from poller retention. If interrupted after the promoter's atomic rename, a later cadence re-verifies the staged attestation and compares the entire existing tree against the authenticated archive before adoption. If `main` has advanced, it performs the same comparison before retiring only that exact intent SHA. Mismatched trees remain untouched and block for review.

The installer writes the selected and previous SHA to root-private state, atomically switches `/opt/fg-index/current`, updates the poller protected-release policy, and runs the fixed `systemctl restart fg-index-api.service`. The selected SHA remains recorded when the restart command fails. The failed selection stays current; the installer does not probe `/health`, a socket, WebSocket, database, PID, or process ownership, and it does not automatically roll back. A restart with an unknown outcome is held for operator review. `--restart-selected` is the explicit operator action to retry it.

Only a release SHA already verified and selected by the installer can become the recorded previous release. The manual rollback command accepts exactly that SHA, records the currently selected SHA in the suppression set before changing `current`, and attempts the same fixed API restart. The suppressed SHA remains ineligible for automatic installation until an operator deliberately changes the state after review. The suppression list is capped at 32 entries.

```sh
sudo /usr/bin/python3.12 /usr/local/libexec/fg-index-deployment/deploy_api_release.py --rollback <recorded-previous-sha>
sudo /usr/bin/python3.12 /usr/local/libexec/fg-index-deployment/deploy_api_release.py --restart-selected
```

Systemd still applies the API unit's fixed `SIGTERM` timeout and its ordinary `Restart=on-failure` policy. These are service controls; deployment acceptance remains the verified artifact, durable selection, and attempted fixed restart. Existing UptimeRobot outage alerts remain external and unchanged. Manual rollback is the recovery path.

## Reviewed host transition

This transition removes the old API boot guard, controller recovery unit, health watchdog, duplicate poller timer, and receipt-bound root retention helper. It source-pins and updates the poller helper while preserving its existing one-shot service and unprivileged identity. It preserves the API unit, current release link, Node 24.21.0 runtime, protected API environment file, scheduler-owner drop-in, Caddy configuration, and ingress. It archives the old controller and retention state, including a held/incomplete transaction; it does not run the old recovery or health-gated rollback code. The API remains inactive during transition. The new deployment timer is installed disabled, and the transition never starts the API.

The source tree used on the host must come from the approved merged `main` commit, staged root-owned under `/root`, and checked against a checksum list retained on the trusted workstation. Do not run from a user-writable checkout. The source archive needs these files:

```text
ops/deploy_api_release.py
ops/promote_api_release.py
ops/transition_oci_deployment.py
ops/deployment/systemd/fg-index-deployment.service
ops/deployment/systemd/fg-index-deployment.timer
```

First run the default read-only plan, then repeat the exact command with `--apply` only after reviewing its receipt, inventory, capacity, and unit checks. The script independently verifies selected current/previous release evidence offline through the source promoter and compares the expanded release inventory with the old accepted receipt. This uses file integrity and provenance only; application health is not checked.

For the host inventory accepted on October 6, 2026, the proposed selection is current `dc7d2ea9c8c2d7bebf1dbca94edda6abc9613589`, previous `bc8ae43c018c200f40a4b10698bbe0f8658a09f5`, with the previous SHA initially suppressed because the interrupted legacy transaction had been rolling it back. Recheck every value against fresh host state. If release directories or poller protected SHAs exist beyond current/previous, list each exact SHA with `--discard-release` or `--forget-protected`; the plan fails when a legacy item has no explicit disposition.

```sh
SOURCE=/root/fg-index-stage1
CURRENT=dc7d2ea9c8c2d7bebf1dbca94edda6abc9613589
PREVIOUS=bc8ae43c018c200f40a4b10698bbe0f8658a09f5
sudo /usr/bin/python3.12 "$SOURCE/ops/transition_oci_deployment.py" \
  --source "$SOURCE" --current-sha "$CURRENT" --previous-sha "$PREVIOUS" \
  --suppress-release "$PREVIOUS"
```

Only after the plan is reviewed, run the same command with `--apply`. Add explicit `--discard-release <sha>` or `--forget-protected <sha>` options from the reviewed plan when needed. The transition disables the old cadence, removes only source-pinned guard/watchdog/recovery files, installs the reviewed installer, promoter, and disabled deployment timer, migrates the state, and reloads systemd. It rechecks that the API is inactive and still boot-enabled, the API no longer requires the old guard, and the new timer is still disabled. It never reads or logs environment values.

The source's automatic cadence is one timer, `fg-index-deployment.timer`; it invokes a root one-shot that starts the private poller service as needed. The poller has no timer. Keep the deployment timer disabled through independent QA and green CI, then enable it only as a separate reviewed PM operation:

```sh
sudo systemctl enable --now fg-index-deployment.timer
```

Only the already-reviewed scheduler-owner override may enable API schedulers; do not change it during this deployment transition. Reconfirm the Render worker is off before any separate scheduler ownership change. The transition has no production SSH, Render, database, health, or alert-delivery action.

## Disk and release ownership

The offline promoter installs only a completely verified release with an atomic same-filesystem rename. It refuses an existing destination during installation. Candidate verification and extraction preserve the established 8 GiB free-space and 10,000-inode reserves. The 20-minute deployment unit timeout covers an 890-second worst-case stale-intent verification, poll, promotion, main check, and restart budget, leaving a 310-second margin. Each successful deployment keeps the newly selected SHA and the prior selected SHA; it prunes only the older SHA that the previous controller state already recorded as managed. Unknown directories block automatic pruning and must be reviewed explicitly. The poller independently bounds staged evidence to three candidates and protects current, previous, and any in-progress promotion intent.

Check service command results and journal entries when an operator requests an install, rollback, or restart:

```sh
sudo systemctl status fg-index-api.service --no-pager
sudo journalctl -u fg-index-api.service -n 100 --no-pager
sudo journalctl -u fg-index-deployment.service -n 100 --no-pager
sudo readlink /opt/fg-index/current
```

These are operational observations, not automated release gates. User sign-in, notification delivery, and broader product checks remain user-owned.
