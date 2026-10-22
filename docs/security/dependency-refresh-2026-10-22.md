# Dependency security refresh — 2026-10-22

The baseline is `origin/main` at `c4f74e01`. This branch was created in an isolated worktree; the original checkout's uncommitted changes were not copied. This is a dependency/runtime advisory review, not a penetration test or a production-host audit.

## Changes

- Require Node `>=24.22.1 <25` in the workspace, API, and web manifests. `.nvmrc` selects 24.22.1, and API/web CI plus Pages builds read that file. [The October 21 Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) identifies this patched Node 24 release.
- Refresh API runtime dependencies within compatible major lines: Express 4.22.3, express-rate-limit 8.7.1, ws 8.22.0, proxy-addr 2.0.8, and ip-address 10.7.4. Refresh the remaining compatible transitive dependencies.
- Upgrade API Vite to 7.3.7 and Vitest to 5.0.5, removing the vulnerable Vitest/tinypool chain. Adapt mock function generics, TLS certificate types, and a Prisma fixture to current types/mock reset behavior. API Node types now follow Node 24.
- Refresh macOS dependencies within the existing React Native/macOS 0.76 line. Replace CLI 15.0.0-alpha.2 with compatible stable CLI 15.1.3; update shell-quote to 1.12.0, fast-xml-parser to 4.5.7, and ws 6.x to 6.2.6. Do not force incompatible React Native, Jest, XML parser, or deepmerge major versions through overrides.
- Main already has a synchronized, audit-clean web lockfile. Its only dependency metadata change here is the Node minimum.

## Live npm advisory results

Commands used from each package directory: `npm audit --package-lock-only --workspaces=false --json`.

| Package | Before (critical / high / moderate / low) | After (critical / high / moderate / low) |
| --- | --- | --- |
| API | 3 / 12 / 3 / 1 | 0 / 3 / 0 / 0 |
| Web | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| macOS | 2 / 62 / 5 / 2 | 0 / 55 / 9 / 0 |
| Shared types | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

Counts are flagged packages, including parent dependency chains; they are not independent exploitable vulnerabilities. All critical advisory packages in these lockfiles were removed. The repository is not advisory-free.

## Remaining work

- **VM and developer runtime:** this PR does not install Node on either host. Check `/opt/nodejs/current/bin/node --version` on the OCI VM, upgrade its separately managed runtime to at least 24.22.1 within 24.x, restart the API, and verify health. The root-owned VM runtime link is independent of CI's Node selection. The earlier local scan observed 24.12.0; update the developer runtime with `nvm install && nvm use` if using nvm.
- **API / Prisma:** the three high entries are `prisma` → `@prisma/config` → `deepmerge-ts` 7.1.5, [recursive merge stack exhaustion](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). npm proposes Prisma 7.10.1. Prisma 7 requires a separate application/configuration migration; replacing deepmerge with a different major using an override would bypass that compatibility work. The finding concerns recursive configuration merges; no request-level exploit has been demonstrated here.
- **macOS / legacy toolchain:** 64 parent and leaf entries remain, originating in the five dependencies below. A coordinated RN/macOS/Jest/toolchain upgrade needs separate validation. Some upstreams have no published fixed release, so a major upgrade alone does not guarantee a clean audit.

| Remaining leaf | Severity | Advisory / next step |
| --- | --- | --- |
| braces | High | [Stack exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm); npm reports no fix for the inherited chain. |
| image-size | High | [ICNS loop](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr), [JXL/HEIF loops](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq); patched 2.x requires parent compatibility work. |
| node-forge | High | [RSA signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv); current compatible dependency line remains affected. |
| fast-xml-parser | Moderate | [XMLBuilder injection](https://github.com/advisories/GHSA-gh4j-gqv2-49f6); fixed 5.x requires a parent/toolchain migration. The critical 4.x advisory is fixed by this refresh. |
| sprintf-js | Moderate | [Unbounded precision](https://github.com/advisories/GHSA-hp3w-g68c-fv3c); npm reports no fix. |

No PHP application code, Composer dependency, or PHP deployment configuration was identified. PHP installed independently on the VM is outside this repository review.

## Validation

Used official Node 24.22.1 extracted under `/tmp`, with its archive SHA-256 checked against Node's published `SHASUMS256.txt`; the system-installed runtime was not changed.

- Clean `npm ci --workspaces=false` installs succeed for API and web; macOS clean install succeeds with `--ignore-scripts`.
- Shared types build succeeds.
- API production build and `tsc --noEmit` succeed; **33 test files / 340 tests pass**.
- Web type-check and production build succeed. Vite reports the existing large-chunk warning.
- macOS: **1 test suite passes; 3 fail (8 tests pass, 9 fail)**. The same counts and failing tests reproduce on unchanged main source with its original lockfile in a separate temporary checkout. Failures are stale FearGreedCard/VixCard UI assertions and a missing `WsStatusBadge` component. Type-check fails on that same missing component on both baseline and this branch. These failures are not introduced by the dependency refresh. A native Xcode build was not performed.
- `git diff --check` succeeds.
