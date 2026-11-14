from server import PromptServer

from .routes import register_routes

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}

register_routes(PromptServer.instance)
