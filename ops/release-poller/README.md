# VM API release poller

This poller runs on the VM and makes outbound HTTPS requests to GitHub. It stages a production API build in a private quarantine under `/var/lib/fg-index-release-poller/staged` only when that build is for the exact commit currently at `itswcl/fg-index` `main`, and the release, archive checksum, and build attestation all pass verification. It does not write under `/opt/fg-index`, activate a release, change `/opt/fg-index/current`, restart a service, or contact a staging service.

## Release policy

For the commit returned by GitHub's public `main` branch API, the poller requires all of the following:

1. The `api-<40-character-SHA>` Git tag is a lightweight tag pointing directly to that commit.
2. The matching release is published, stable, and marked `immutable: true` by GitHub.
3. The release has exactly `api-release.tar.gz` and `api-release.tar.gz.sha256`, both uploaded and carrying REST API SHA-256 digests.
4. The downloaded bytes match those REST digests, and the checksum sidecar matches the archive.
5. `gh attestation verify` accepts the archive for that source SHA and `refs/heads/main`, signed by `.github/workflows/ci.yml` with the SLSA provenance predicate.
6. GitHub still reports the same `main` SHA after verification.

The release must already be immutable. An absent release or tag is treated as “not ready”; any present release with missing, mutable, extra, or mismatched data fails closed. These checks depend on the release publisher and repository immutability setting described in PR #187. If that repository setting or publisher gate is not enabled, the poller will not stage the release.

## Staging behavior

The poller extracts the verified archive into a temporary directory under `/var/lib/fg-index-release-poller/staged`, checks the embedded `RELEASE-MANIFEST.txt`, then atomically renames the result to `/var/lib/fg-index-release-poller/staged/<SHA>`. It uses Python's safe `tarfile` data filter, rejects archive paths that escape the destination, rejects special files, caps the archive at 100,000 filesystem entries, and limits logical member sizes to 4 GiB. Before extraction, it rounds each regular file to the actual filesystem block size, budgets an additional block for each extracted path (including implicit directories), and requires 10,000 free inodes beyond the candidate's path count. The dedicated poller user and private primary group own staged files; directories are mode `0700` and regular files are mode `0600` (with owner execute bits preserved). The API service cannot read or alter this quarantine, and the poller has no writable path under `/opt/fg-index`.

The root deployment service starts this poller as a one-shot, then calls `ops/promote_api_release.py` to independently verify the staged evidence and copy an eligible candidate into the root-owned `/opt/fg-index/releases/<SHA>` tree. Offline verification uses a separately provisioned, root-owned Sigstore trusted-root file and does not treat the poller-writable marker as proof. The poller has no sudo or `/opt` access; only the root deployment service can select a release or restart the API.

Each finalized candidate also retains the evidence that the online verification used:

| File | Contents | Bound |
| --- | --- | --- |
| `api-release.tar.gz` | Exact downloaded archive that passed GitHub's asset digest and checksum checks | 2 GiB |
| `api-release.tar.gz.sha256` | Exact uploaded checksum sidecar | 1 KiB |
| `attestation-bundle.jsonl` | GitHub attestation bundle downloaded for that archive digest and verified by `gh attestation verify` | 16 MiB, one selected build bundle |
| `.fg-index-verification.json` | Source SHA, release ID/tag, evidence SHA-256 digests, signer workflow, predicate, verification time | — |

The poller records evidence hashes in the marker and checks all retained files when inventorying a candidate for retention. Since the marker and files are writable by the poller identity, this detects missing or inconsistent evidence but does not authenticate the quarantine to a root process. A future offline promotion operation must reverify the retained archive against the bundle and a separately trusted root-owned Sigstore trust root. If the exact SHA is already staged with matching evidence and manifest, future polls only check current `main` and do not redownload it. A malformed or incomplete candidate is left untouched and causes an error. The poller caps finalized verified candidates at three and prunes only the oldest eligible candidate in this private quarantine. It protects current `main`, the newest verified candidate, and SHAs in the root-maintained policy. Unknown entries, stale temporary trees, malformed candidates, a missing policy, or a protected set that cannot fit the cap stop polling without pruning. The current in-progress tree is not counted as finalized.

### Disk capacity and retention

The poller refuses to download unless declared archive/checksum sizes plus the 16 MiB bundle allowance and 64 KiB filesystem-allocation margin fit while preserving an 8 GiB free-space reserve. Before attestation retrieval, it checks that reserve again. It fetches one public REST page from the exact repository/archive-SHA256 endpoint with `per_page=30`. Both the response body and the serialized retained bundle are capped at 16 MiB; an oversized stream or declared size fails before any bundle file is written. It validates the response and signed-envelope shapes and selects the first original SLSA provenance bundle whose subject includes the exact archive digest. These untrusted fields only select evidence; `gh attestation verify` authenticates it. The poller does not follow `bundle_url` or fetch further pages. This bounded lookup is not a complete attestation inventory: missing acceptable evidence, malformed records, HTTP/rate-limit errors, and verification failures stop the poll without finalizing a candidate. A later matching record is not tried after a selected bundle fails cryptographic verification. Each release asset download stops as soon as the stream exceeds its declared size. Before extraction, the poller budgets filesystem block allocation and path metadata and refuses if that estimate would breach the reserve. The retained archive and bundle occupy up to 2 GiB plus 16 MiB per finalized candidate in addition to the expanded tree; the three-candidate cap bounds this evidence overhead. A concurrent disk consumer can still cause an operation to fail; the incomplete quarantine tree is cleaned up. Retention touches only `/var/lib/fg-index-release-poller/staged`; it never deletes or modifies `/opt/fg-index/releases` or `/opt/fg-index/current`.

Retention reads `/etc/fg-index-release-poller/retention-policy.json`. The operator must create this as a regular file owned by root and not writable by its group or other users. Its format is:

```json
{
  "schema_version": 1,
  "protected_shas": []
}
```

The serialized root deployment service writes the selected and previous SHAs to `protected_shas` before it starts a poll. The one-time host transition reconciles the earlier protected set into the new current/previous selection after each old SHA has an explicit disposition. The poller's own artifact-size and free-space checks continue to enforce the 8 GiB and inode reserves.

No runner or deploy credential is needed. REST and release downloads are public. Attestation retrieval uses public REST directly because `gh attestation download` requires CLI authentication even for this public repository. The local `gh attestation verify --bundle` process receives a temporary empty home/config directory and no inherited GitHub token variables. It uses `--custom-trusted-root /etc/fg-index-release-promoter/trusted_root.jsonl`, the separately provisioned Sigstore root snapshot also used by the promoter, and denies self-hosted runners. The root file and its directory must be root-owned, regular file/directory respectively, and not group- or world-writable. Verification retains the exact repository, source SHA, main ref, signer workflow, SLSA predicate, and default GitHub Actions OIDC issuer constraints. Only REST and release downloads need outbound HTTPS to `api.github.com`, `github.com`, and GitHub's release-asset hosts; bundle verification uses local evidence and roots.

## Runtime requirements

- Linux with systemd
- Python 3.12 or newer
- GitHub CLI with offline `gh attestation verify --bundle --custom-trusted-root` support
- Root-owned, read-only Sigstore trusted-root snapshot at `/etc/fg-index-release-promoter/trusted_root.jsonl`
- A dedicated `fg-index-release-poller` system user and same-named primary group, with no membership in `fg-index`
- A private systemd state directory at `/var/lib/fg-index-release-poller`, writable only by the poller service
- The poller script installed at `/usr/local/libexec/fg-index-release-poller/poller.py`

The poller and promoter CI tests use local fixtures and mocked command execution. They do not make GitHub, VM, or staging requests. Promoter tests cover offline verifier arguments, untrusted evidence, capacity reserves, archive traversal and symlink cases, and inactive atomic installation.

## Install after review

Install only the poller service and script from this directory, then create the dedicated poller account and group. The service uses a private state directory under `/var/lib/fg-index-release-poller`; it has no write access to `/opt/fg-index` and no membership in group `fg-index`, so it cannot read `/etc/fg-index/api.env`. Do not install a poller timer. The single deployment timer invokes this one-shot service.

```sh
sudo install -d -m 0755 /usr/local/libexec/fg-index-release-poller
sudo install -m 0755 poller.py /usr/local/libexec/fg-index-release-poller/poller.py
sudo install -m 0644 systemd/fg-index-release-poller.service /etc/systemd/system/
sudo groupadd --system fg-index-release-poller
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid fg-index-release-poller fg-index-release-poller
sudo systemctl daemon-reload
```

The service unit creates `/var/lib/fg-index-release-poller` as mode `0700` when it first runs. Its `TimeoutStartSec=180` bounds each one-shot poll; a timeout marks the service failed and terminates it. The service has no automatic restart, and the timer stays disabled until a separate capacity review, so this one-shot is not automatically retried. A timeout may interrupt candidate staging; inspect the journal and staged directory before any manual retry. Installing the units does not start the service or enable the timer.

## One-shot poll and deployment cadence

For a reviewed read-only poll, start the service directly. This writes only to the private quarantine; it does not install code or change `current`:

```sh
sudo df -B1 /var/lib
sudo systemctl start fg-index-release-poller.service
sudo du -sB1 /var/lib/fg-index-release-poller/staged/<SHA>
sudo df -B1 /var/lib/fg-index-release-poller
```

The root deployment service runs this same poller and selects only a candidate for the exact current `main` SHA. The host transition installs one deployment timer but leaves it disabled until independent QA, green CI, the initial verified release, and PM's separate operations approval:

```sh
sudo systemctl enable --now fg-index-deployment.timer
```

That timer owns release discovery and deployment together; there is no independent poller cadence. A normal unchanged poll makes one unauthenticated GitHub REST request; a new `main` SHA triggers release, tag, and final branch checks plus one bounded public attestation lookup (up to 30 records, no pagination). Check `journalctl -u fg-index-release-poller.service` for poll results and `journalctl -u fg-index-deployment.service` for selection/restart results. Application health is not an automatic deployment gate.


## Offline tests

```sh
python3.12 -m unittest discover -s ops/release-poller -p 'test_*.py'
```

The verifier options and release fields follow the [GitHub CLI attestation verification manual](https://cli.github.com/manual/gh_attestation_verify), [GitHub artifact attestation documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations), and [GitHub repository attestations REST API](https://docs.github.com/en/rest/repos/attestations), and [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases?apiVersion=latest).

Offline trust-root provisioning and the source-bound host transition are documented in [`ops/oci/README.md`](../oci/README.md) and [`ops/deployment/README.md`](../deployment/README.md).
