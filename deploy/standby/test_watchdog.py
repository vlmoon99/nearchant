# python3 -m unittest deploy/standby/test_watchdog.py — the takeover rule of the standby watchdog (ADR 0020).
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from watchdog import RESTART_EVERY_S, TAKEOVER_AFTER_S, TUNNEL_AFTER_S, should_restart, should_restart_tunnel, should_take_over


class TakeoverRule(unittest.TestCase):
    def test_takes_over_only_when_the_spark_is_down_everywhere_and_this_mac_is_online(self):
        self.assertTrue(should_take_over(False, False, True, TAKEOVER_AFTER_S))

    def test_never_when_the_spark_answers_on_the_tailnet(self):
        self.assertFalse(should_take_over(True, False, True, 999))

    def test_never_when_the_public_site_still_works(self):  # only our tailnet link is broken
        self.assertFalse(should_take_over(False, True, True, 999))

    def test_never_when_this_mac_is_the_one_offline(self):
        self.assertFalse(should_take_over(False, False, False, 999))

    def test_waits_three_minutes(self):
        self.assertFalse(should_take_over(False, False, True, TAKEOVER_AFTER_S - 1))


class RestartRule(unittest.TestCase):
    def test_restarts_a_site_that_does_not_answer(self):
        self.assertTrue(should_restart(False, RESTART_EVERY_S))

    def test_leaves_a_working_site_alone(self):
        self.assertFalse(should_restart(True, 999))

    def test_does_not_retry_in_a_tight_loop(self):
        self.assertFalse(should_restart(False, RESTART_EVERY_S - 1))


class TunnelRule(unittest.TestCase):
    def test_restarts_the_tunnel_when_only_the_public_site_is_down(self):
        self.assertTrue(should_restart_tunnel(True, False, True, TUNNEL_AFTER_S, RESTART_EVERY_S))

    def test_not_when_the_local_site_is_down_too(self):  # that is restart_site's job
        self.assertFalse(should_restart_tunnel(False, False, True, 999, 999))

    def test_not_when_this_mac_is_offline(self):
        self.assertFalse(should_restart_tunnel(True, False, False, 999, 999))

    def test_waits_a_minute_and_does_not_loop(self):
        self.assertFalse(should_restart_tunnel(True, False, True, TUNNEL_AFTER_S - 1, 999))
        self.assertFalse(should_restart_tunnel(True, False, True, 999, RESTART_EVERY_S - 1))


if __name__ == "__main__":
    unittest.main()
