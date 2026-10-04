#!/usr/bin/env python3
"""Exercise Caddy's runtime and access-log redaction with a synthetic 502."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[2]
CADDYFILE = REPO_ROOT / "ops" / "oci" / "Caddyfile"
POLICY_START = "# BEGIN request log redaction policy"
POLICY_END = "# END request log redaction policy"
MARKERS = (
    "QUERY_TOKEN_MARKER",
    "QUERY_APIKEY_MARKER",
    "AUTH_HEADER_MARKER",
    "X_API_KEY_MARKER",
)


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def extract_policy() -> str:
    source = CADDYFILE.read_text(encoding="utf-8")
    try:
        policy = source.split(POLICY_START, 1)[1].split(POLICY_END, 1)[0]
    except IndexError:
        fail("Caddyfile redaction policy markers are missing or out of order")
    required_rules = (
        "delete token",
        "delete apiKey",
        "request>headers>Authorization delete",
        "request>headers>X-Api-Key delete",
    )
    if any(policy.count(rule) != 2 for rule in required_rules):
        fail("global runtime and reusable access-log filters must carry the same four rules")
    if "(sensitive-request-fields)" not in policy:
        fail("reusable access-log filter snippet is missing")
    return f"{POLICY_START}{policy}{POLICY_END}"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def read_json_lines(path: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    if not path.exists():
        return entries
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            entries.append(value)
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--static-only",
        action="store_true",
        help="check the committed runtime and access-log rules without requiring Caddy",
    )
    args = parser.parse_args()
    policy = extract_policy()
    if args.static_only:
        print("Caddy log redaction policy static check passed.")
        return 0

    caddy = shutil.which("caddy")
    if not caddy:
        fail("Caddy is required on PATH")

    # The production admin endpoint is already bound on the host. Disable it
    # only for this isolated process; the logging policy itself stays identical.
    policy = policy.replace("{\n", "{\n\tadmin off\n", 1)
    listen_port = free_port()
    upstream_port = free_port()
    while upstream_port == listen_port:
        upstream_port = free_port()

    with tempfile.TemporaryDirectory(prefix="fg-index-caddy-redaction-") as temp_name:
        temp_dir = Path(temp_name)
        caddyfile = temp_dir / "Caddyfile"
        runtime_log = temp_dir / "runtime.jsonl"
        access_log = temp_dir / "access.jsonl"
        caddyfile.write_text(
            f"""{policy}

http://127.0.0.1:{listen_port} {{
    log {{
        output file {access_log}
        import sensitive-request-fields
    }}
    reverse_proxy 127.0.0.1:{upstream_port}
}}
""",
            encoding="utf-8",
        )

        subprocess.run(
            [caddy, "validate", "--config", str(CADDYFILE), "--adapter", "caddyfile"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            [caddy, "fmt", "--overwrite", str(caddyfile)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            [caddy, "validate", "--config", str(caddyfile), "--adapter", "caddyfile"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        with runtime_log.open("w", encoding="utf-8") as stdout_file:
            process = subprocess.Popen(
                [caddy, "run", "--config", str(caddyfile), "--adapter", "caddyfile"],
                stdout=stdout_file,
                stderr=subprocess.STDOUT,
                env={**os.environ, "XDG_CONFIG_HOME": str(temp_dir), "XDG_DATA_HOME": str(temp_dir)},
            )
            try:
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        fail("isolated Caddy process exited before opening its loopback listener")
                    try:
                        with socket.create_connection(("127.0.0.1", listen_port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    fail("isolated Caddy process did not open its loopback listener")

                request = Request(
                    f"http://127.0.0.1:{listen_port}/synthetic-502"
                    "?token=QUERY_TOKEN_MARKER&apiKey=QUERY_APIKEY_MARKER",
                    headers={
                        "Authorization": "Bearer AUTH_HEADER_MARKER",
                        "X-API-KEY": "X_API_KEY_MARKER",
                    },
                )
                try:
                    with urlopen(request, timeout=4) as response:
                        status = response.status
                        body = response.read()
                except HTTPError as error:
                    status = error.code
                    body = error.read()
                if status != 502:
                    fail(f"synthetic upstream failure returned HTTP {status}, expected 502")
                if any(marker.encode() in body for marker in MARKERS):
                    fail("synthetic 502 response echoed a marker")
                time.sleep(0.1)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)

        runtime_entries = read_json_lines(runtime_log)
        access_entries = read_json_lines(access_log)
        if not any(str(entry.get("level", "")).upper() == "ERROR" for entry in runtime_entries):
            levels = sorted({str(entry.get("level", "<missing>")) for entry in runtime_entries})
            loggers = sorted({str(entry.get("logger", "<missing>")) for entry in runtime_entries})
            fail(
                "Caddy runtime error log did not retain an observable upstream error "
                f"(levels={levels}, loggers={loggers})"
            )
        if not any(entry.get("status") == 502 for entry in access_entries):
            fail("Caddy access log did not retain the synthetic 502 status")

        combined_logs = runtime_log.read_bytes() + access_log.read_bytes()
        if any(marker.encode() in combined_logs for marker in MARKERS):
            fail("a synthetic query or header marker appeared in Caddy logs")

    print("Caddy log redaction test passed: synthetic 502 observable; query/header markers absent.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Caddy log redaction test failed: {error}", file=sys.stderr)
        raise SystemExit(1)
