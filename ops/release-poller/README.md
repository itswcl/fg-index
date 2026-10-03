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

A separate reviewed promotion task must later verify a candidate and copy it into the root-owned `/opt/fg-index/releases/<SHA>` tree before an operator can change the root-owned `/opt/fg-index/current` symlink. This PR does not install a privileged promotion unit, grant the poller sudo or `/opt` access, or activate a release.

The poller writes `.fg-index-verification.json` into each staged release with the source SHA, release tag and ID, verified digests, signer workflow, predicate, and verification time. If that exact SHA is already staged with a matching marker and manifest, future polls only check the current `main` SHA and do not redownload it. A directory at the target SHA without a valid marker is left untouched and causes an error. The poller caps finalized verified candidates at three and prunes only the oldest eligible candidate in this private quarantine. It protects current `main`, the newest verified candidate, and SHAs in the root-maintained policy. Unknown entries, stale temporary trees, malformed candidates, a missing policy, or a protected set that cannot fit the cap stop polling without pruning. The current in-progress tree is not counted as finalized.

### Disk capacity and retention

The poller refuses to download unless the declared asset sizes fit while preserving an 8 GiB free-space reserve. It stops each asset download as soon as the stream exceeds that asset's declared size. Before extraction, it budgets filesystem block allocation and path metadata and refuses if that estimate would breach the reserve. A concurrent disk consumer can still cause extraction to fail; the incomplete quarantine tree is cleaned up. Retention touches only `/var/lib/fg-index-release-poller/staged`; it never deletes or modifies `/opt/fg-index/releases` or `/opt/fg-index/current`.

Retention reads `/etc/fg-index-release-poller/retention-policy.json`. The operator must create this as a regular file owned by root and not writable by its group or other users. Its format is:

```json
{
  "schema_version": 1,
  "protected_shas": []
}
```

List each approved rollback or operator-protected candidate as a full lowercase SHA in `protected_shas`; keep the array empty when there are none. Keep the timer disabled until the owner has reviewed the protected set, measured current guest free bytes and inodes, and confirmed the retention and 8 GiB reserve fit actual capacity. The OCI console's configured volume size and earlier free-space estimates are not substitutes for guest measurements.

No runner or deploy credential is needed. REST and release downloads are public. The `gh` verification process receives a temporary empty home/config directory and no inherited GitHub token variables; it uses the public GitHub attestation API and Sigstore's public-good trust root. It needs outbound HTTPS to `api.github.com`, `github.com`, and GitHub's release-asset hosts.

## Runtime requirements

- Linux with systemd
- Python 3.12 or newer
- GitHub CLI with `gh attestation verify` support
- A dedicated `fg-index-release-poller` system user and same-named primary group, with no membership in `fg-index`
- A private systemd state directory at `/var/lib/fg-index-release-poller`, writable only by the poller service
- The poller script installed at `/usr/local/libexec/fg-index-release-poller/poller.py`

The CI test uses only local fixtures and mocks. It does not make GitHub, VM, or staging requests.

## Install after review

Install the script and units from this directory, then create the dedicated poller account and group. The service uses a private systemd state directory under `/var/lib/fg-index-release-poller`; it has no write access to `/opt/fg-index` and no membership in group `fg-index`, so it cannot read `/etc/fg-index/api.env`. The install commands leave the timer disabled. Capacity measurement and timer activation are a separate gate below.

```sh
sudo install -d -m 0755 /usr/local/libexec/fg-index-release-poller
sudo install -m 0755 poller.py /usr/local/libexec/fg-index-release-poller/poller.py
sudo install -m 0644 systemd/fg-index-release-poller.service /etc/systemd/system/
sudo install -m 0644 systemd/fg-index-release-poller.timer /etc/systemd/system/
sudo groupadd --system fg-index-release-poller
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid fg-index-release-poller fg-index-release-poller
sudo systemctl daemon-reload
```

The service unit creates `/var/lib/fg-index-release-poller` as mode `0700` when it first runs. Installing the units does not start the service or enable the timer.

## Capacity gate and timer activation

Keep the timer disabled while measuring a real, verified candidate. Record free space before one manual poll, run the one-shot service, then measure the staged tree's allocated size and free space again. This writes only to the private quarantine; it does not install code or change `current`:

```sh
sudo df -B1 /var/lib
sudo systemctl start fg-index-release-poller.service
sudo du -sB1 /var/lib/fg-index-release-poller/staged/<SHA>
sudo df -B1 /var/lib/fg-index-release-poller
```

Recalculate the expected retention runway using that measured allocated size, observed main commit cadence, and current VM free space. Record the retention owner and confirm the 8 GiB reserve remains available after the planned candidate set. If the allocated size, current free space, or retention plan is unknown, keep the timer disabled. Only after this capacity review is approved may the owner enable periodic polling:

```sh
sudo systemctl enable --now fg-index-release-poller.timer
```

The timer starts two minutes after boot and then runs every ten minutes. A normal unchanged poll makes one unauthenticated GitHub REST request; a new `main` SHA triggers the release, tag, and final branch checks plus one public attestation lookup. This leaves room below GitHub's unauthenticated REST limit while avoiding repeated asset downloads for an already staged SHA. Check `journalctl -u fg-index-release-poller.service` for its result.


## Offline tests

```sh
python3.12 -m unittest discover -s ops/release-poller -p 'test_*.py'
```

The verifier options and release fields follow the [GitHub CLI attestation verification manual](https://cli.github.com/manual/gh_attestation_verify), [GitHub artifact attestation documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations), and [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases?apiVersion=latest).
