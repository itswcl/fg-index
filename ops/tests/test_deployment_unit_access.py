"""Static systemd contracts for the single serialized deployment cadence."""
import configparser
from pathlib import Path
import unittest

OPS = Path(__file__).parents[1]
UNITS = OPS / "deployment/systemd"


def read_unit(path: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(path)
    return parser


class DeploymentUnitTest(unittest.TestCase):
    def test_deployment_service_runs_one_shot_install_without_watchdog_or_probe(self):
        unit = read_unit(UNITS / "fg-index-deployment.service")
        service = unit["Service"]
        self.assertEqual("oneshot", service["Type"])
        self.assertEqual("root", service["User"])
        self.assertEqual("20min", service["TimeoutStartSec"])
        stale_intent_recovery_and_deploy_budget = 10 + 240 + 10 + 190 + 10 + 240 + 10 + 180
        timeout_seconds = 20 * 60
        self.assertEqual(890, stale_intent_recovery_and_deploy_budget)
        self.assertEqual(310, timeout_seconds - stale_intent_recovery_and_deploy_budget)
        self.assertEqual("/usr/bin/python3.12 /usr/local/libexec/fg-index-deployment/deploy_api_release.py --once",
                         service["ExecStart"])
        self.assertIn("/opt/fg-index", service["ReadWritePaths"])
        self.assertNotIn("watchdog", " ".join(service.values()).lower())

    def test_only_deployment_timer_is_shipped(self):
        timer = read_unit(UNITS / "fg-index-deployment.timer")["Timer"]
        self.assertEqual("fg-index-deployment.service", timer["Unit"])
        self.assertEqual("2min", timer["OnBootSec"])
        self.assertEqual("10min", timer["OnUnitInactiveSec"])
        self.assertFalse((OPS / "release-poller/systemd/fg-index-release-poller.timer").exists())
        self.assertFalse((UNITS / "fg-index-deployment-watchdog.timer").exists())

    def test_obsolete_guard_and_recovery_units_are_removed(self):
        for name in ("20-deployment-boot-guard.conf", "fg-index-api-boot-guard.service",
                     "fg-index-deployment-recovery.service", "fg-index-deployment-watchdog.service",
                     "fg-index-deployment-watchdog.timer"):
            self.assertFalse((UNITS / name).exists(), name)

    def test_api_keeps_fixed_loopback_service_contract_without_guard_dependency(self):
        unit = read_unit(OPS / "oci/fg-index-api.service")
        self.assertNotIn("Requires", unit["Unit"])
        argv = unit["Service"]["ExecStart"]
        self.assertIn("HOST=127.0.0.1", argv)
        self.assertIn("PORT=8080", argv)
        self.assertIn("SCHEDULERS_ENABLED=false", argv)
        self.assertIn("/opt/fg-index/current/apps/api-server/dist/index.js", argv)
        self.assertEqual("on-failure", unit["Service"]["Restart"])
        self.assertEqual("30s", unit["Service"]["TimeoutStopSec"])


if __name__ == "__main__":
    unittest.main()
