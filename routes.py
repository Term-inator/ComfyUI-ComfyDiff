import asyncio
import json
import os
from pathlib import Path
import tempfile

from aiohttp import web

from .repository import Repository, RepositoryError, workflow_path


def read_settings(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"workspace": "", "bindings": {}}


def write_settings(path, settings):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent, mode="w", encoding="utf-8", delete=False,
    ) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(settings, stream, ensure_ascii=False)
            stream.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def register_routes(server):
    users = server.user_manager
    lock = asyncio.Lock()

    def settings_path(request):
        return Path(users.get_request_user_filepath(request, "comfydiff.json", create_dir=False))

    def configured(settings, expected):
        root = settings["workspace"]
        if not root or expected != root:
            raise RepositoryError("Git 工作区设置已变更，请刷新后重试。")
        return root

    async def handle(request):
        try:
            return web.json_response(await dispatch(request), headers={"Cache-Control": "no-store"})
        except RepositoryError as error:
            return web.json_response({"error": str(error)}, status=400)
        except (KeyError, TypeError, ValueError):
            return web.json_response({"error": "无法读取请求或 ComfyDiff 设置。"}, status=400)
        except OSError:
            return web.json_response({"error": "无法读取或保存 ComfyDiff 设置。"}, status=500)

    async def dispatch(request):
        path = settings_path(request)
        operation = request.match_info["operation"]
        if request.method == "PUT":
            body = await request.json()
            async with lock:
                settings = read_settings(path)
                if operation == "settings":
                    repo = await asyncio.to_thread(Repository, body["workspace"])
                    settings["workspace"] = str(repo.root)
                elif operation == "binding":
                    root = configured(settings, body["workspace"])
                    repo = await asyncio.to_thread(Repository, root)
                    relative = body["file"]
                    await asyncio.to_thread(repo.disk, relative)
                    native = body["native"]
                    if not isinstance(native, str) or not native.startswith("workflows/"):
                        raise RepositoryError("该标签页尚无可保存的工作流路径。")
                    workflow_path(native)
                    settings["bindings"].setdefault(root, {})[native] = relative
                else:
                    raise web.HTTPNotFound()
                write_settings(path, settings)
                return {"workspace": settings["workspace"]}

        settings = read_settings(path)
        query = request.query
        if operation == "settings":
            root = settings["workspace"]
            native = query.get("native")
            relative = None
            automatic = False
            if root and native and native.startswith("workflows/"):
                # ComfyUI's native path is relative to the user's data directory.
                workflow_path(native)
                native_root = users.get_request_user_filepath(request, None, create_dir=False)
                if native_root:
                    resolved = (Path(native_root) / native).resolve()
                    if resolved.is_relative_to(root):
                        relative = resolved.relative_to(root).as_posix()
                        automatic = True
                if not relative:
                    relative = settings["bindings"].get(root, {}).get(native)
            return {"workspace": root, "file": relative, "automatic": automatic}

        root = configured(settings, query.get("workspace"))
        repo = await asyncio.to_thread(Repository, root)
        if operation == "files":
            return await asyncio.to_thread(repo.files)
        if operation == "file":
            content = await asyncio.to_thread(repo.disk, query["file"])
            return {"content": repo.decode(content, "工作区")}
        if operation == "compare":
            mode = query["mode"]
            if mode not in ("disk", "canvas"):
                raise RepositoryError("请选择比较来源。")
            return await asyncio.to_thread(repo.compare, query["file"], mode == "disk", query.get("known"))
        raise web.HTTPNotFound()

    server.routes.get("/comfydiff/{operation}")(handle)
    server.routes.put("/comfydiff/{operation}")(handle)
