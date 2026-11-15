from contextlib import contextmanager
import hashlib
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import secrets
import stat
import subprocess
import tempfile


class RepositoryError(Exception):
    def __init__(self, code, *, source=None, detail=None):
        super().__init__(code)
        self.code = code
        self.source = source
        self.detail = detail


class RepositoryChanged(RepositoryError):
    pass


WORKTREE_FILE_ERROR = "error.invalidWorktreeFile"


def repository_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise RepositoryError("error.invalidRepositoryPath")
    path = PurePosixPath(value)
    if not path.parts or path.is_absolute() or PureWindowsPath(value).drive or path.as_posix() != value or any(
        part == ".." or part.casefold() == ".git" for part in path.parts
    ):
        raise RepositoryError("error.invalidRepositoryPath")
    if os.name == "nt" and any(":" in part or part.endswith((" ", ".")) for part in path.parts):
        raise RepositoryError("error.invalidRepositoryPath")
    return path


def workflow_path(value):
    path = repository_path(value)
    if path.suffix.lower() != ".json":
        raise RepositoryError("error.invalidWorkflowPath")
    return path


@contextmanager
def _posix_parent(root, relative):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(root.anchor, flags)
    try:
        for name in (*root.parts[1:], *relative.parts[:-1]):
            child = os.open(name, flags, dir_fd=parent)
            os.close(parent)
            parent = child
        yield parent
    finally:
        os.close(parent)


def _open_posix_file(root, relative):
    with _posix_parent(root, relative) as parent:
        return os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)


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
        raise RepositoryError("error.chooseServerWorkspace")
    return Path(directory)


def fingerprint(content):
    return hashlib.sha256(content).hexdigest()


def check_write_version(descriptor, expected):
    with open(descriptor, "rb", closefd=False) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise RepositoryError(WORKTREE_FILE_ERROR)
        if fingerprint(stream.read()) != expected:
            raise RepositoryChanged("error.saveConflict")
    return stat.S_IMODE(info.st_mode)


def replace_worktree_file(root, relative, content, expected):
    if os.name == "nt":
        target = root.joinpath(*relative.parts)
        if target.parent.resolve() != target.parent:
            raise RepositoryError(WORKTREE_FILE_ERROR)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(content)
            descriptor = _open_windows_file(root, relative)
            try:
                mode = check_write_version(descriptor, expected)
            finally:
                os.close(descriptor)
            os.chmod(temporary, mode)
            os.replace(temporary, target)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
        return

    with _posix_parent(root, relative) as parent:
        temporary = ".comfydiff-" + secrets.token_hex(12) + ".tmp"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent)
        try:
            with open(descriptor, "wb") as stream:
                stream.write(content)
                current = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    mode = check_write_version(current, expected)
                finally:
                    os.close(current)
                os.fchmod(stream.fileno(), mode)
            os.replace(temporary, relative.name, src_dir_fd=parent, dst_dir_fd=parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


class Repository:
    @classmethod
    def select(cls, directory):
        return cls(str(absolute_workspace(directory).resolve()))

    def __init__(self, directory):
        self.root = absolute_workspace(directory)
        if not self.root.is_dir():
            raise RepositoryError("error.workspaceMissing")
        result = self.git("rev-parse", "--show-toplevel")
        if result.returncode or Path(os.fsdecode(result.stdout).rstrip("\n")).resolve() != self.root:
            raise RepositoryError("error.chooseWorkspaceRoot")

    def git(self, *args):
        # Ignore inherited repository overrides and disable lazy remote reads.
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
        try:
            return subprocess.run(
                ["git", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", str(self.root), *args],
                env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RepositoryError("error.gitUnavailable") from error

    def checked_git(self, code, *args, source=None):
        result = self.git(*args)
        if result.returncode:
            detail = result.stderr.decode(errors="replace").strip()[:800]
            raise RepositoryError(code, source=source, detail=detail)
        return result.stdout

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
        content = self.worktree_content(relative)
        if content is None:
            raise RepositoryError("error.fileMissing")
        return content

    def worktree_content(self, relative):
        try:
            with open_worktree_file(self.root, relative) as stream:
                return stream.read()
        except FileNotFoundError:
            return None
        except OSError as error:
            raise RepositoryError("error.readFile") from error

    def native_path(self, relative, native_root):
        candidate = self.root.joinpath(*workflow_path(relative).parts)
        native_workflows = (Path(native_root) / "workflows").resolve()
        if candidate.is_relative_to(native_workflows):
            return "workflows/" + candidate.relative_to(native_workflows).as_posix()

    def save_workflow(self, relative, content, expected):
        path = workflow_path(relative)
        try:
            replace_worktree_file(self.root, path, content, expected)
        except FileNotFoundError as error:
            raise RepositoryChanged("error.fileMoved") from error
        except OSError as error:
            raise RepositoryError("error.saveFile") from error
        return fingerprint(content)

    def index_entry(self, relative):
        listing = self.checked_git("error.readIndex", "--literal-pathspecs", "ls-files", "--stage", "-z", "--", relative)
        for record in listing.split(b"\0"):
            metadata, _, name = record.partition(b"\t")
            if name == os.fsencode(relative):
                mode, oid, stage = metadata.split()
                if stage != b"0":
                    raise RepositoryError("error.fileConflict")
                return mode, oid

    def head_entry(self, head, relative):
        if head is None:
            return None
        listing = self.checked_git("error.readHead", "--literal-pathspecs", "ls-tree", "-z", head, "--", relative)
        if listing:
            mode, _, oid = listing.split(b"\t", 1)[0].split()
            return mode, oid

    def workflow_blob(self, entry, source):
        if entry is None:
            return None
        mode, oid = entry
        if mode not in (b"100644", b"100755"):
            raise RepositoryError("error.invalidGitBlob", source=source)
        return self.checked_git("error.readGitBlob", "cat-file", "blob", oid.decode("ascii"), source=source)

    def compare(self, relative, mode, known=None):
        workflow_path(relative)
        commit = self.git("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
        head = commit.stdout.decode("ascii").strip() or None
        previous = self.head_entry(head, relative)
        index = self.index_entry(relative)
        staged = index != previous
        disk = self.worktree_content(relative) if mode != "staged" else None
        disk_hash = fingerprint(disk) if disk is not None else None
        indexed = None
        if mode == "auto":
            if staged:
                indexed = self.workflow_blob(index, "version.index")
            mode = "staged" if staged and disk == indexed else "changed"
        token = fingerprint(repr((mode, head, previous, index, disk_hash)).encode("ascii"))
        if known == token:
            return {"unchanged": True}

        if indexed is None:
            indexed = self.workflow_blob(index, "version.index")
        committed = self.workflow_blob(previous, "version.head") if mode == "staged" else None
        return {
            "head": head, "token": token, "mode": mode, "staged": staged,
            "before": self.decode(committed, "version.head") if mode == "staged" else self.decode(indexed, "version.index"),
            "after": self.decode(indexed, "version.index") if mode == "staged" else self.decode(disk, "version.disk"),
        }

    def status(self):
        raw = self.checked_git(
            "error.readGitStatus", "--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch",
            "--no-ahead-behind", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty",
        )
        result = {"head": None, "branch": None, "staged": [], "changed": [], "blocked": ""}
        staged_entries = []
        for record in raw.split(b"\0"):
            if record.startswith(b"# branch.oid "):
                oid = record.removeprefix(b"# branch.oid ")
                result["head"] = None if oid == b"(initial)" else oid.decode("ascii")
            elif record.startswith(b"# branch.head "):
                result["branch"] = os.fsdecode(record.removeprefix(b"# branch.head "))
            elif record.startswith(b"1 "):
                _, xy, _, _, mode, _, _, oid, path = record.split(b" ", 8)
                file = os.fsdecode(path)
                if xy[:1] != b".":
                    result["staged"].append({"file": file, "code": chr(xy[0])})
                    staged_entries.append((path, mode, oid, xy[:1]))
                if xy[1:] != b".":
                    result["changed"].append({"file": file, "code": chr(xy[1])})
            elif record.startswith(b"? "):
                result["changed"].append({"file": os.fsdecode(record[2:]), "code": "U"})
            elif record.startswith(b"u "):
                file = os.fsdecode(record.split(b" ", 10)[-1])
                result["changed"].append({"file": file, "code": "!"})
                result["blocked"] = "error.unresolvedConflicts"
        git_dir = Path(os.fsdecode(self.checked_git("error.readGitDirectory", "rev-parse", "--absolute-git-dir")).rstrip("\n"))
        if any((git_dir / name).exists() for name in (
            "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer",
        )):
            result["blocked"] = "error.unfinishedGitOperation"
        result["commitToken"] = fingerprint(repr((result["branch"], result["head"], sorted(staged_entries))).encode("ascii", "backslashreplace"))
        return result

    def change_index(self, relative, stage):
        repository_path(relative)
        state = self.status()
        if state["blocked"]:
            raise RepositoryError(state["blocked"])
        if relative not in {row["file"] for row in state["changed" if stage else "staged"]}:
            raise RepositoryChanged("error.fileStatusChanged")
        args = ("add",) if stage else ("reset", "-q")
        self.checked_git("error.updateIndex", "--literal-pathspecs", *args, "--", relative)
        return self.status()

    def commit(self, message, expected):
        state = self.status()
        if state["blocked"]:
            raise RepositoryError(state["blocked"])
        if state["commitToken"] != expected:
            raise RepositoryChanged("error.commitTargetChanged")
        if not state["staged"]:
            raise RepositoryError("error.nothingStaged")
        self.checked_git("error.commitFailed", "commit", "-m", message)
        return self.status()

    @staticmethod
    def decode(content, source):
        try:
            return content.decode("utf-8-sig") if content is not None else None
        except UnicodeError as error:
            raise RepositoryError("error.invalidEncoding", source=source) from error
