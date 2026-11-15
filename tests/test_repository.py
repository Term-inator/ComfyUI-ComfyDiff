from pathlib import Path
import tempfile
import unittest

from repository import RepositoryError, resolve_workflow


class ResolveWorkflowTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.repo = Path(directory) / "repo"
        self.user = Path(directory) / "user"
        self.repo.mkdir()
        (self.user / "workflows").mkdir(parents=True)

    def workflow(self, relative):
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"nodes": []}', encoding="utf-8")
        return path

    def test_matches_full_relative_path_from_saved_or_imported_tab(self):
        self.workflow("portraits/sdxl.json")
        self.workflow("tests/sdxl.json")
        for native_root in (self.user, None):
            self.assertEqual(
                resolve_workflow(self.repo, "workflows/portraits/sdxl.json", native_root, None),
                ("portraits/sdxl.json", True),
            )

    def test_does_not_search_nested_directories_by_basename(self):
        self.workflow("portraits/sdxl.json")
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", None, None), (None, False),
        )

    def test_explicit_binding_wins_over_a_matching_relative_path(self):
        self.workflow("sdxl.json")
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", self.user, "tests/sdxl.json"),
            ("tests/sdxl.json", False),
        )

    def test_prefers_confirmed_path_for_native_workflow(self):
        path = self.workflow("portraits/sdxl.json")
        self.workflow("sdxl.json")
        (self.user / "workflows" / "sdxl.json").symlink_to(path)
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", self.user, "tests/sdxl.json"),
            ("portraits/sdxl.json", True),
        )

    def test_rejects_path_traversal_and_outside_symlink(self):
        outside = self.user / "outside.json"
        outside.touch()
        (self.repo / "sdxl.json").symlink_to(outside)
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", None, None), (None, False),
        )
        with self.assertRaises(RepositoryError):
            resolve_workflow(self.repo, "workflows/../outside.json", None, None)


if __name__ == "__main__":
    unittest.main()
