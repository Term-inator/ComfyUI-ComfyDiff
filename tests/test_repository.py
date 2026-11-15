import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from repository import Repository, RepositoryChanged, RepositoryError, fingerprint, resolve_workflow, workflow_path


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


class SourceControlTests(unittest.TestCase):
    name = "portraits/测试 [1].json"

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.root)], check=True, capture_output=True)
        self.repo = Repository(str(self.root))
        for key, value in (
            ("user.name", "ComfyDiff test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", os.devnull),
        ):
            self.repo.checked_git("config", "config", key, value)
        (self.root / self.name).parent.mkdir()

    def write(self, steps):
        content = json.dumps({"nodes": [], "steps": steps}).encode()
        (self.root / self.name).write_bytes(content)
        return content

    def commit(self, message):
        return self.repo.commit(message, self.repo.status()["commitToken"])

    def test_compare_and_commit_keep_disk_and_index_versions_separate(self):
        self.write(20)
        self.repo.change_index(self.name, True)
        self.commit("Initial")
        self.write(28)
        self.repo.change_index(self.name, True)
        self.assertEqual(self.repo.compare(self.name, "auto")["mode"], "staged")
        self.write(30)
        (self.root / "README.md").write_text("about the workflow", encoding="utf-8")
        self.repo.change_index("README.md", True)
        status = self.repo.status()
        self.assertEqual({row["file"] for row in status["staged"]}, {"README.md", self.name})
        self.assertEqual(status["changed"], [{"file": self.name, "code": "M"}])
        for mode, old, new in (("staged", 20, 28), ("changed", 28, 30)):
            data = self.repo.compare(self.name, mode)
            self.assertEqual((json.loads(data["before"])["steps"], json.loads(data["after"])["steps"]), (old, new))
            self.assertEqual(self.repo.compare(self.name, mode, data["token"]), {"unchanged": True})
        self.commit("Update workflow and documentation")
        head = self.repo.checked_git("read", "show", "HEAD:" + self.name)
        self.assertEqual(json.loads(head)["steps"], 28)
        self.assertEqual(json.loads(self.repo.disk(self.name))["steps"], 30)

    def test_commit_rejects_new_staged_contents_at_the_same_path(self):
        self.write(20)
        initial = self.repo.change_index(self.name, True)
        self.write(30)
        self.repo.change_index(self.name, True)
        with self.assertRaises(RepositoryChanged):
            self.repo.commit("Outdated preview", initial["commitToken"])
        self.assertIsNone(self.repo.status()["head"])
        self.repo.change_index(self.name, False)
        self.assertEqual(self.repo.status()["changed"], [{"file": self.name, "code": "U"}])
        self.assertEqual(json.loads(self.repo.disk(self.name))["steps"], 30)

    def test_staged_and_unstaged_deletion_produce_a_missing_right_side(self):
        self.write(20)
        self.repo.change_index(self.name, True)
        self.commit("Initial")
        (self.root / self.name).unlink()
        self.assertIsNone(self.repo.compare(self.name, "changed")["after"])
        self.repo.change_index(self.name, True)
        data = self.repo.compare(self.name, "auto")
        self.assertEqual(data["mode"], "staged")
        self.assertIsNone(data["after"])

    def test_save_rejects_external_file_changes_without_replacing_them(self):
        original = self.write(20)
        external = self.write(28)
        with self.assertRaises(RepositoryChanged):
            self.repo.save_workflow(self.name, original, fingerprint(original))
        self.assertEqual(self.repo.disk(self.name), external)
        self.assertEqual(self.repo.save_workflow(self.name, original, fingerprint(external)), fingerprint(original))
        self.assertEqual(self.repo.disk(self.name), original)


if __name__ == "__main__":
    unittest.main()
