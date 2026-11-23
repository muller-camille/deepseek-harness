---
description: "通过 DeepSeek Harness 浏览器扩展和 Web UI 连接，在用户自己的 Chrome 中使用其已登录会话操作网页。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-browser-use-extension-bridge

[English](README.md) | 中文

## 概述

让 Agent（智能体）在用户自己的 Chrome 中打开、读取、点击和输入。页面使用用户的已登录会话加载并运行其 JavaScript，而 Agent 运行在 DeepSeek Harness 服务器上。随附的 Chrome 扩展从 Web UI 标签页经由 Web UI 自身的地址和登录连接到此插件，因此用户的计算机不开放任何端口，也不需要 SSH 隧道。扩展只在用户允许的站点上操作。这个已发布的实验性包只有在显式挂载时才会启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`dsh` 安装把此包作为可选 bundle 随附，随附的 profile 默认不启用它。在 Web UI 的插件页面开启 **浏览器操作（你的 Chrome）**；它的 [`cordis.patch.yml`](cordis.patch.yml) 会插入 browser-use 服务和此提供方。然后在打开 Web UI 的计算机上设置 Chrome：

1. 打开 `chrome://extensions`，开启**开发者模式**，选择**加载已解压的扩展程序**，然后选择此包的 `extension` 目录。
2. 打开扩展的选项，在 **DeepSeek Harness server** 下添加 Web UI 地址，并接受 Chrome 的访问提示。
3. 在 **Allowed sites** 下添加 Agent 可以使用的每个站点，例如 `intranet.example.com` 或 `*.example.com`。
4. 在该 Chrome 中打开 Web UI。只要有 Web UI 标签页处于打开状态，选项页就会显示 **Connected**。

Agent 在名为 "DSH agent" 的标签页组中工作。关闭该标签页，或在选项中开启 **Pause agent**，即可停止浏览器控制。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `commandTimeoutMs` | `30000` | 单个浏览器命令的时间预算，包括页面加载和 `wait_for` |
| `maxContentChars` | `50000` | 单次 `browser_read` 返回的 Markdown 上限 |
| `maxHtmlChars` | `2000000` | 扩展为单次读取发送的已清理 HTML 上限 |
| `heartbeatIntervalMs` | `30000` | 向每个已连接 Web UI 标签页发送 ping 的间隔 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

提供方在 `ctx.webServer` 上注册需要认证的 `/browser-bridge` WebSocket upgrade 路由。扩展的中继内容脚本只在用户配置了其 origin 的 Web UI 标签页中运行。它的 WebSocket 携带该页面的 origin 和登录 cookie，因此 Web 服务器的 Host 与 Origin 检查及其认证会像接纳 Web UI 一样接纳它；该登录结束时 socket 随之关闭。中继把帧转发给扩展的 service worker，由后者在 Agent 标签页组中执行每个命令。

最近一个完成 hello 的 Web UI 标签页负责处理命令，它关闭后由较早的标签页接替。所有 Agent 共享同一个 Agent 标签页，因此命令逐个执行。超出时间预算的命令会在扩展中被取消，并以 `BROWSER_TIMEOUT` 失败。

service worker 会根据 Chrome 已授予的主机权限检查每个目标以及每个操作到达的页面，并拒绝已配置的服务器主机，使 Agent 无法操作 Web UI，包括其审批控件。读取会移除脚本、样式和隐藏元素，用 `[ref=N]` 标记可见的链接、按钮和表单字段，并返回 HTML，由提供方使用 turndown 转换为 Markdown。扩展会把深度超过 300 层元素的子树压平为文本，提供方会拒绝嵌套超过 512 层元素的标记，因为 turndown 的同步转换会随深度急剧变慢。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [浏览器使用](../../../docs/subsystems/browser-use.zh.md) — 提供方选择与 Session 所有权。
- [浏览器使用服务](../../browser-use/browser-use/README.zh.md) — 提供方独占注册。
- [Web 服务器](../../host/webserver/README.zh.md) — upgrade 路由与请求准入。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器工具

#### 模型可见内容

四个工具：`browser_open`（URL 和可选的 `wait_for` 选择器）、`browser_read`（可选的 `selector` 和 `wait_for`）、`browser_click` 和 `browser_type`（来自最近一次读取的 `ref` 或 CSS `selector`，输入时另有 `text` 和 `submit`）。操作返回 Agent 标签页的标题和 URL。读取返回页面标题和 URL、不可信内容提示，以及在链接、按钮和表单字段上带有 `[ref=N]` 标记的 Markdown；每次读取都会重新分配 ref。一个系统提示词段落说明用户的浏览器、已登录会话、允许的站点、ref，以及页面内容只是数据。没有连接装有扩展的 Web UI 标签页时，工具仍保留在列表中，并以 `BROWSER_NOT_CONNECTED` 失败；被拒绝的站点会列出允许的站点。

#### Token 影响

四个工具定义和提示词段落保持不变。每次读取会向 Session 历史追加最多 `maxContentChars` 的 Markdown。

#### KV Cache 影响

工具定义和提示词段落不随连接状态变化，因此前缀保持可复用。结果追加到历史中。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 Chrome 和其他支持 Manifest V3 扩展的 Chromium 浏览器；扩展以已解压方式加载，未发布到 Chrome 应用商店。
- 服务器上的所有 Session 共享一个 Agent 标签页，命令逐个执行。
- Agent 在允许的站点上使用用户的已登录会话操作。取消不会撤销已经送达的导航、点击或输入。
- 读取只覆盖顶层文档；框架内的内容不会返回。不支持截图、文件上传和下载。
- 在 Web UI 标签页打开期间，控制服务器或持有用户 Web UI 登录的任何人都可以在允许的站点上驱动浏览器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

扩展源码是 Chrome 直接加载的纯 JavaScript，无需构建步骤。`DSH_BROWSER_BRIDGE_E2E=1` 时，`tests/extension.e2e.ts` 会把它们加载到真实的 Chromium 中；请把 `DSH_BROWSER_BRIDGE_CHROMIUM` 设为完整的 Chromium 构建，因为扩展无法在 headless shell 中加载。

</details>
