import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess


class RepositoryError(Exception):
    pass


def workflow_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise RepositoryError("请选择仓库内的工作流路径。")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(
        part in ("..", ".git") for part in path.parts
    ) or path.suffix.lower() != ".json":
        raise RepositoryError("请选择仓库内的 JSON 工作流。")
    return path


class Repository:
    def __init__(self, directory):
        if not isinstance(directory, str) or not Path(directory).is_absolute():
            raise RepositoryError("请输入 ComfyUI 服务器上的绝对路径。")
        self.root = Path(directory).resolve()
        if not self.root.is_dir():
            raise RepositoryError("Git 工作区目录不存在。")
        result = self.git("rev-parse", "--show-toplevel")
        if result.returncode or Path(os.fsdecode(result.stdout).rstrip("\n")).resolve() != self.root:
            raise RepositoryError("请选择 Git 工作区的根目录。")

    def git(self, *args):
        # Ignore inherited repository overrides and disable lazy remote reads.
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env["GIT_NO_LAZY_FETCH"] = "1"
        try:
            return subprocess.run(
                ["git", "--no-replace-objects", "-C", str(self.root), *args],
                env=env, capture_output=True, timeout=10, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RepositoryError("无法运行 Git 或 Git 读取超时。") from error

    def files(self):
        files = []
        for directory, children, names in os.walk(self.root):
            children[:] = [
                name for name in children
                if name != ".git" and not (Path(directory) / name).is_symlink()
            ]
            for name in names:
                path = Path(directory) / name
                if path.suffix.lower() == ".json" and not path.is_symlink() and path.is_file():
                    files.append(path.relative_to(self.root).as_posix())
        return sorted(files)

    def disk(self, relative):
        path = self.root / workflow_path(relative)
        try:
            if path.resolve() != path or not stat.S_ISREG(path.stat().st_mode):
                raise RepositoryError("工作区文件必须是仓库内的普通 JSON 文件。")
            return path.read_bytes()
        except FileNotFoundError as error:
            raise RepositoryError("工作区中找不到该文件，可能已移动或删除。") from error
        except OSError as error:
            raise RepositoryError("无法读取工作区文件。") from error

    def compare(self, relative, disk, known=None):
        workflow_path(relative)
        commit = self.git("rev-parse", "--verify", "HEAD^{commit}")
        if commit.returncode:
            raise RepositoryError("无法读取 HEAD，Git 工作区可能尚无提交。")
        head = commit.stdout.decode("ascii").strip()
        current = self.disk(relative) if disk else None
        fingerprint = hashlib.sha256(current).hexdigest() if disk else ""
        token = f"{head}:{fingerprint}"
        if known == token:
            return {"unchanged": True}

        entry = self.git("--literal-pathspecs", "ls-tree", "-z", head, "--", relative)
        if entry.returncode:
            raise RepositoryError("无法读取 HEAD 的文件记录。")
        previous = None
        if entry.stdout:
            mode, kind, oid = entry.stdout.split(b"\t", 1)[0].split()
            if kind != b"blob" or mode not in (b"100644", b"100755"):
                raise RepositoryError("HEAD 中的工作流必须是普通 JSON 文件。")
            blob = self.git("cat-file", "blob", oid.decode("ascii"))
            if blob.returncode:
                raise RepositoryError("无法读取 HEAD 中的工作流。")
            previous = blob.stdout
        return {
            "head": head, "token": token,
            "before": self.decode(previous, "HEAD"),
            "after": self.decode(current, "工作区"),
        }

    @staticmethod
    def decode(content, source):
        try:
            return content.decode("utf-8-sig") if content is not None else None
        except UnicodeError as error:
            raise RepositoryError(f"{source}的工作流不是 UTF-8 JSON。") from error
