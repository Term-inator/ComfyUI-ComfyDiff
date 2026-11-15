from contextlib import contextmanager
import hashlib
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import stat
import subprocess


class RepositoryError(Exception):
    pass


WORKTREE_FILE_ERROR = "工作区文件必须是仓库内的普通 JSON 文件。"


def workflow_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise RepositoryError("请选择仓库内的工作流路径。")
    path = PurePosixPath(value)
    if path.is_absolute() or PureWindowsPath(value).drive or path.as_posix() != value or any(
        part == ".." or part.casefold() == ".git" for part in path.parts
    ) or path.suffix.lower() != ".json":
        raise RepositoryError("请选择仓库内的 JSON 工作流。")
    if os.name == "nt" and any(":" in part or part.endswith((" ", ".")) for part in path.parts):
        raise RepositoryError("请选择仓库内的 JSON 工作流。")
    return path


def _open_posix_file(root, relative):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(root.anchor, flags)
    try:
        for name in (*root.parts[1:], *relative.parts[:-1]):
            child = os.open(name, flags, dir_fd=parent)
            os.close(parent)
            parent = child
        return os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)


def _open_windows_file(root, relative):
    from ctypes import WinDLL, WinError, create_unicode_buffer, get_last_error, wintypes
    from msvcrt import get_osfhandle

    def extended(path):
        prefix = "\\\\?\\"
        name = str(path)
        if name.startswith(prefix):
            return Path(name)
        if name.startswith("\\\\"):
            return Path(prefix + "UNC\\" + name[2:])
        return Path(prefix + name)

    root = extended(root)
    expected = root.joinpath(*relative.parts)
    final_path = WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
    final_path.argtypes = (wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD)
    final_path.restype = wintypes.DWORD
    descriptor = os.open(expected, os.O_RDONLY | os.O_BINARY)
    try:
        buffer = create_unicode_buffer(32768)
        size = final_path(get_osfhandle(descriptor), buffer, len(buffer), 0)
        if not size:
            raise WinError(get_last_error())
        if size >= len(buffer):
            raise RepositoryError(WORKTREE_FILE_ERROR)
        actual = Path(buffer.value)
        if actual.parts[:len(root.parts)] != root.parts or actual != expected:
            raise RepositoryError(WORKTREE_FILE_ERROR)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


@contextmanager
def open_worktree_file(root, value):
    relative = workflow_path(value)
    opener = _open_windows_file if os.name == "nt" else _open_posix_file
    descriptor = opener(root, relative)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RepositoryError(WORKTREE_FILE_ERROR)
        with open(descriptor, "rb", closefd=False) as stream:
            yield stream
    finally:
        os.close(descriptor)


def resolve_workflow(root, native, native_root, binding):
    workflow_path(native)
    root = Path(root)
    if native_root:
        resolved = (Path(native_root) / native).resolve()
        if resolved.is_relative_to(root):
            return resolved.relative_to(root).as_posix(), "native"
    if binding:
        return binding, "binding"

    # ComfyUI prefixes tab paths with workflows/, including imported tabs.
    # Check the remaining full path directly in the configured worktree.
    relative = native.removeprefix("workflows/")
    try:
        with open_worktree_file(root, relative):
            pass
    except (OSError, RepositoryError):
        return None, None
    return relative, "match"


def absolute_workspace(directory):
    if not isinstance(directory, str) or not Path(directory).is_absolute():
        raise RepositoryError("请选择 ComfyUI 服务器上的工作区目录。")
    return Path(directory)


class Repository:
    @classmethod
    def select(cls, directory):
        return cls(str(absolute_workspace(directory).resolve()))

    def __init__(self, directory):
        self.root = absolute_workspace(directory)
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
                if name.casefold() != ".git" and not (Path(directory) / name).is_symlink()
            ]
            for name in names:
                path = Path(directory) / name
                if path.suffix.lower() == ".json" and not path.is_symlink() and path.is_file():
                    files.append(path.relative_to(self.root).as_posix())
        return sorted(files)

    def disk(self, relative):
        try:
            with open_worktree_file(self.root, relative) as stream:
                return stream.read()
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
