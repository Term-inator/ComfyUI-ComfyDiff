from contextlib import suppress
import os
from pathlib import Path
from string import ascii_uppercase

from .repository import RepositoryError


def windows_drives():
    from ctypes import WinError, windll

    mask = windll.kernel32.GetLogicalDrives()
    if not mask:
        raise WinError()
    return [f"{letter}:\\" for index, letter in enumerate(ascii_uppercase) if mask & (1 << index)]


def list_directory(path):
    if path == "" and os.name == "nt":
        return {
            "path": None, "parent": None,
            "folders": [{"name": drive, "path": drive} for drive in windows_drives()],
        }

    directory = Path(path)
    if not directory.is_absolute() or (os.name == "nt" and len(directory.drive) != 2):
        raise RepositoryError("error.chooseServerFolder")
    directory = Path(os.path.abspath(directory))
    folders = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.lower() == ".git":
                    continue
                with suppress(OSError):
                    if entry.is_dir():
                        folders.append({"name": entry.name, "path": entry.path})
    except (FileNotFoundError, NotADirectoryError) as error:
        raise RepositoryError("error.folderUnavailable") from error
    except OSError as error:
        raise RepositoryError("error.readFolder") from error

    parent = str(directory.parent) if directory != directory.parent else ("" if os.name == "nt" else None)
    return {"path": str(directory), "parent": parent, "folders": sorted(folders, key=lambda item: item["name"].casefold())}


def browse_directories(path, workspace):
    if path is not None:
        return list_directory(path)
    if workspace:
        with suppress(RepositoryError):
            return list_directory(workspace)
    return list_directory(Path.cwd())
