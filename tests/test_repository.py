import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from repository import Repository, RepositoryError, resolve_workflow, workflow_path


class WorktreeReadTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.root = self.directory / "checkout"
        self.root.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True, capture_output=True)
        self.repo = Repository(str(self.root))

    def test_workflow_path_must_be_git_relative(self):
        for name in ("C:/fixture/flow.json", "C:flow.json", ".GIT/flow.json"):
            with self.subTest(name=name), self.assertRaises(RepositoryError):
                workflow_path(name)

    def test_reads_regular_json_in_a_nested_worktree_folder(self):
        (self.root / "workflows").mkdir()
        (self.root / "workflows" / "flow.json").write_bytes(b'{"nodes":[]}')
        self.assertEqual(self.repo.disk("workflows/flow.json"), b'{"nodes":[]}')

    @unittest.skipUnless(os.name == "posix", "requires POSIX links")
    def test_disk_read_does_not_follow_a_link_installed_at_open(self):
        file = self.root / "flow.json"
        file.write_bytes(b'{"nodes":[]}')
        other = self.directory / "other.json"
        other.write_bytes(b'{}')
        open_file = io.open
        open_descriptor = os.open

        def swap(name):
            if name in (file, file.name):
                file.unlink()
                file.symlink_to(other)

        def patched_file(name, *args, **kwargs):
            swap(name)
            return open_file(name, *args, **kwargs)

        def patched_descriptor(name, *args, **kwargs):
            swap(name)
            return open_descriptor(name, *args, **kwargs)

        with patch("io.open", patched_file), patch("os.open", patched_descriptor):
            with self.assertRaises(RepositoryError):
                self.repo.disk("flow.json")


class ResolveWorkflowTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.repo = Path(directory).resolve() / "repo"
        self.user = Path(directory).resolve() / "user"
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
                ("portraits/sdxl.json", "match"),
            )

    def test_does_not_search_nested_directories_by_basename(self):
        self.workflow("portraits/sdxl.json")
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", None, None), (None, None),
        )

    def test_explicit_binding_wins_over_a_matching_relative_path(self):
        self.workflow("sdxl.json")
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", self.user, "tests/sdxl.json"),
            ("tests/sdxl.json", "binding"),
        )

    def test_prefers_confirmed_path_for_native_workflow(self):
        path = self.workflow("portraits/sdxl.json")
        self.workflow("sdxl.json")
        (self.user / "workflows" / "sdxl.json").symlink_to(path)
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", self.user, "tests/sdxl.json"),
            ("portraits/sdxl.json", "native"),
        )

    def test_rejects_path_traversal_and_outside_symlink(self):
        outside = self.user / "outside.json"
        outside.touch()
        (self.repo / "sdxl.json").symlink_to(outside)
        self.assertEqual(
            resolve_workflow(self.repo, "workflows/sdxl.json", None, None), (None, None),
        )
        with self.assertRaises(RepositoryError):
            resolve_workflow(self.repo, "workflows/../outside.json", None, None)


if __name__ == "__main__":
    unittest.main()
