"""Regression controls for complete, fresh quality evidence without API calls."""

import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "release_ci", Path(__file__).with_name("release-ci.py")
)
release_ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_ci)


def job(name, step="Canonical TypeScript quality phase"):
    return {
        "name": name,
        "conclusion": "success",
        "steps": [{"name": step, "conclusion": "success"}],
    }


class FullGateEvidence(unittest.TestCase):
    def setUp(self):
        self.phases = [
            job(f"TypeScript gate / {phase} (Ubuntu x64)")
            for phase in ["static", "docs", "tests", "package"]
        ]
        self.legacy = job(
            "TypeScript gate (Ubuntu x64)", "Canonical TypeScript quality gate"
        )

    def accepts(self, jobs):
        with patch.object(release_ci, "api", return_value={"jobs": jobs}) as api:
            result = release_ci.completed_full_gate(123)
        api.assert_called_once_with("actions/runs/123/jobs?per_page=100")
        return result

    def test_accepts_complete_parallel_gate(self):
        self.assertTrue(self.accepts(self.phases))

    def test_requires_every_phase(self):
        for missing in range(4):
            with self.subTest(missing=missing):
                self.assertFalse(self.accepts(self.phases[:missing] + self.phases[missing + 1:]))

    def test_refuses_unsuccessful_jobs_and_steps(self):
        for index in range(4):
            for conclusion in ["failure", "cancelled", "skipped", None]:
                for target in ["job", "step"]:
                    with self.subTest(phase=index, conclusion=conclusion, target=target):
                        jobs = copy.deepcopy(self.phases)
                        record = jobs[index] if target == "job" else jobs[index]["steps"][0]
                        record["conclusion"] = conclusion
                        self.assertFalse(self.accepts(jobs))

    def test_requires_the_phase_step(self):
        for index in range(4):
            with self.subTest(phase=index):
                jobs = copy.deepcopy(self.phases)
                jobs[index]["steps"] = []
                self.assertFalse(self.accepts(jobs))

    def test_refuses_ambiguous_phase_jobs(self):
        self.assertFalse(self.accepts(self.phases + [self.phases[0]]))

    def test_accepts_historical_full_gate(self):
        self.assertTrue(self.accepts([self.legacy]))

    def test_historical_gate_cannot_excuse_incomplete_parallel_evidence(self):
        self.assertFalse(self.accepts([self.legacy, self.phases[0]]))

    def test_refuses_unsuccessful_or_ambiguous_historical_gate(self):
        self.assertFalse(self.accepts([self.legacy, self.legacy]))
        for conclusion in ["failure", "cancelled", "skipped", None]:
            with self.subTest(conclusion=conclusion):
                legacy = copy.deepcopy(self.legacy)
                legacy["steps"][0]["conclusion"] = conclusion
                self.assertFalse(self.accepts([legacy]))

    def test_reused_release_status_is_not_fresh_test_evidence(self):
        self.assertFalse(self.accepts([
            job("Release metadata checks", "Static release metadata checks"),
            job("TypeScript quality", "Require complete or reused quality evidence"),
        ]))

    def test_refuses_missing_evidence(self):
        self.assertFalse(self.accepts([]))


if __name__ == "__main__":
    unittest.main()
