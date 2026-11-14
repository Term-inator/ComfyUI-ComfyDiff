# ComfyDiff

在 ComfyUI 的「工作流差异」侧栏比较工作流与 Git `HEAD`，并定位节点、参数和接线。

1. 将此仓库放入 ComfyUI 的 `custom_nodes/ComfyUI-ComfyDiff`，重启 ComfyUI 并刷新浏览器。
2. 在 ComfyUI 设置中启用 **Nodes 2.0**。首版开发基线为前端 `1.57.6`。
3. 打开「工作流差异」侧栏，在「设置」中填写 ComfyUI 服务器上 Git 工作区的绝对路径。服务器需要能运行 `git` 并读取该仓库。
4. 从侧栏打开仓库工作流，或为当前标签页选择对应的仓库文件。默认比较磁盘文件。「对比当前画布」会采集包括未保存编辑在内的快照。

从侧栏打开仓库文件后，ComfyUI 按导入工作流处理该标签页。磁盘比较读取设置中的 Git 工作区。使用 ComfyUI 的原生保存时，请检查保存目标路径。

[需求与验收场景](docs/requirements.md)
