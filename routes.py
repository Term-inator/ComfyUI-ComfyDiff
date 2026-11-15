import asyncio
import json
import os
from pathlib import Path
import tempfile

from aiohttp import web

from .directories import browse_directories
from .repository import Repository, RepositoryChanged, RepositoryError, fingerprint, resolve_workflow, workflow_path


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
        except RepositoryChanged as error:
            return web.json_response({"error": str(error)}, status=409)
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
                    repo = await asyncio.to_thread(Repository.select, body["workspace"])
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
                elif operation in ("stage", "unstage", "commit", "save"):
                    root = configured(settings, body["workspace"])
                    repo = await asyncio.to_thread(Repository, root)
                    if operation in ("stage", "unstage"):
                        return await asyncio.to_thread(repo.change_index, body["file"], operation == "stage")
                    if operation == "commit":
                        message = body["message"]
                        if not isinstance(message, str) or not message.strip() or "\0" in message:
                            raise RepositoryError("请输入提交说明。")
                        return await asyncio.to_thread(repo.commit, message.strip(), body["expected"])
                    content = body["content"]
                    data = json.loads(content)
                    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
                        raise RepositoryError("请选择有效的工作流。")
                    version = await asyncio.to_thread(repo.save_workflow, body["file"], content.encode("utf-8"), body["expected"])
                    return {"version": version}
                else:
                    raise web.HTTPNotFound()
                write_settings(path, settings)
                return {"workspace": settings["workspace"]}

        settings = read_settings(path)
        query = request.query
        if operation == "directories":
            return await asyncio.to_thread(browse_directories, query.get("path"), settings["workspace"])
        if operation == "settings":
            root = settings["workspace"]
            native = query.get("native")
            relative = None
            source = None
            if root and native and native.startswith("workflows/"):
                temporary = query.get("temporary") == "1"
                native_root = None if temporary else users.get_request_user_filepath(request, None, create_dir=False)
                binding = None if temporary else settings["bindings"].get(root, {}).get(native)
                relative, source = resolve_workflow(root, native, native_root, binding)
            return {"workspace": root, "file": relative, "source": source}

        root = configured(settings, query.get("workspace"))
        repo = await asyncio.to_thread(Repository, root)
        if operation == "status":
            return await asyncio.to_thread(repo.status)
        if operation == "files":
            return await asyncio.to_thread(repo.files)
        if operation == "file":
            relative = query["file"]
            content = await asyncio.to_thread(repo.disk, relative)
            native_root = users.get_request_user_filepath(request, None, create_dir=False)
            native = None
            for candidate in query.getall("open", []):
                file, source = resolve_workflow(root, candidate, native_root, None)
                if source == "native" and file == relative:
                    native = candidate
                    break
            if native is None:
                native = repo.native_path(relative, native_root)
            return {"content": repo.decode(content, "已保存文件"), "version": fingerprint(content), "native": native}
        if operation == "compare":
            mode = query["mode"]
            if mode not in ("auto", "staged", "changed"):
                raise RepositoryError("请选择比较来源。")
            return await asyncio.to_thread(repo.compare, query["file"], mode, query.get("known"))
        raise web.HTTPNotFound()

    server.routes.get("/comfydiff/{operation}")(handle)
    server.routes.put("/comfydiff/{operation}")(handle)
