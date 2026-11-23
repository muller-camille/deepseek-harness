# 运行便携式 Linux 发行版

[English](portable-linux.md) | 中文

便携式 Linux 发行版可在 glibc 2.28 或更新版本的 x86_64 Linux 主机上运行 DeepSeek Harness，包括 Red Hat Enterprise Linux 8.10，无需安装 Node.js 或任何系统软件包。一个归档包含 `dsh` 命令、Web UI、搜索与命令沙箱辅助程序，以及本指南。

## 1. 下载并解压

从发布页面下载 `dsh-<version>-linux-x64.tar.gz` 和 `dsh-<version>-linux-x64.tar.gz.sha256`，然后在你拥有的目录中校验并解压归档。整个过程不需要 root 权限。

```sh
sha256sum -c dsh-<version>-linux-x64.tar.gz.sha256
tar -xzf dsh-<version>-linux-x64.tar.gz
dsh-<version>-linux-x64/dsh --version
```

所有命令都通过解压目录顶层的 `dsh` 启动器运行。如需直接按名称运行，把它链接到 `PATH` 中的某个目录，例如 `ln -s "$PWD/dsh-<version>-linux-x64/dsh" ~/.local/bin/dsh`。

## 2. 启动 Web UI

切换到 Agent（智能体）应当工作的项目目录，然后启动 Web UI。如果没有创建链接，请使用启动器的完整路径运行。

```sh
cd ~/my-project
dsh web --no-open
```

命令会打印类似 `http://127.0.0.1:3080/?token=...` 的地址。请打开完整地址；其中的令牌用于认证浏览器。服务器只接受来自本机的连接。

如需从另一台计算机使用 Web UI，请在那台计算机上通过 SSH 转发端口，然后在那里打开打印出的地址：

```sh
ssh -L 3080:127.0.0.1:3080 user@rhel-host
```

[在反向代理之后发布 Web UI](./public-deployments.zh.md) 介绍如何绑定其他地址。

## 3. 配置模型和工作区

打开**设置 → 模型**并输入 DeepSeek API 密钥，或者在启动 `dsh` 前设置 `DEEPSEEK_API_KEY`。然后选择**选择工作区**并添加你的项目目录。在没有桌面工具 `xdg-user-dir` 的主机上，Web UI 会提示无法创建默认工作区；选择工作区即可解决。[Web UI 指南](./index.zh.md)从这里继续。

## 其他模式

启动器可以运行所有 CLI 模式。例如，下面的命令运行一个任务并打印最终回答：

```sh
dsh --profile headless "Summarize this repository"
```

[CLI 参考](../../../apps/cli/README.zh.md)列出了所有模式。

## 使用你自己的 Chrome 浏览

通过随附的浏览器扩展，Agent 可以在你计算机上的 Chrome 中使用你的已登录会话打开、读取和操作网页。扩展经由 Web UI 标签页连接，因此你的计算机上不会监听任何端口。

1. 在 Web UI 中打开**插件**，开启**浏览器操作（你的 Chrome）**。
2. 把归档中的 `browser-extension` 目录复制到打开 Web UI 的计算机上。在 Chrome 中打开 `chrome://extensions`，开启**开发者模式**，选择**加载已解压的扩展程序**，然后选择该目录。
3. 在扩展的选项中添加 Web UI 地址，然后添加 Agent 可以使用的每个站点。

Agent 浏览期间请保持 Web UI 标签页打开；它在名为 "DSH agent" 的标签页组中工作。[浏览器桥接参考](../../../packages/experimental/browser-use-extension-bridge/README.zh.md)介绍了这些工具及其限制。

## 命令沙箱

Agent 在沙箱中运行 shell 命令，沙箱把写入限制在工作区内。在 Linux 上，沙箱使用 bubblewrap 或 Landlock。RHEL 8 内核没有 Landlock，服务器安装通常也没有 bubblewrap，因此归档在 `libexec/sandbox/bwrap` 中附带了静态构建的 bubblewrap。启动器把该目录追加到 `PATH` 末尾，因此主机上已安装的 `bwrap` 优先。

bubblewrap 需要非特权用户命名空间，RHEL 8 默认启用该功能。如果加固后的主机把 `user.max_user_namespaces` 设为 `0`，shell 命令会因沙箱不可用而失败。请让管理员调高该限制，或者选择**完全权限**模式，在不受限制的情况下运行命令。

## 文件和数据

| 路径 | 内容 |
|---|---|
| `dsh` | 启动器 |
| `libexec/dsh` | 包含 Node.js 和应用程序的可执行文件 |
| `libexec/dsh-rg` | 供搜索工具使用的 ripgrep |
| `libexec/sandbox/bwrap` | 供命令沙箱使用的静态 bubblewrap |
| `libexec/linux-x64/downloads.json` | 可选运行时下载的锁定来源 |
| `browser-extension/` | 用于通过你自己的 Chrome 浏览的 Chrome 扩展 |
| `licenses/` | `THIRD_PARTY_NOTICES.md` 之外的附带组件许可证 |

会话、设置和凭据保存在 `~/.dsh` 中；设置了 `$DSH_HOME` 时保存在该目录中。可执行文件在首次使用原生模块时把它们解压到 `~/.cache/pkg`；当主目录以 `noexec` 方式挂载时，请把 `PKG_NATIVE_CACHE_PATH` 设为其他目录。卸载时删除解压目录；如果不再需要其中的数据，再删除 `~/.dsh` 和 `~/.cache/pkg`。

发往 DeepSeek 官方 API 的请求默认附带会话日志，显式反馈会通过 OpenTelemetry 上传会话。[CLI 参考](../../../apps/cli/reference/README.zh.md)说明了这两种上传以及关闭方式；`DSH_TELEMETRY_DISABLED=1` 会关闭 OpenTelemetry 上传。

## 限制

- 仅支持 x86_64 主机。主机需要 glibc 2.28 以及 GCC 8 或更新版本的 libstdc++。
- 安装发行版未附带的插件需要 `PATH` 中有 `pnpm`。
- Office 转换工具会报告 LibreOffice Kit 不可用；Office skill（技能）使用主机上的 Python。
- 实验性插件“语音输入”需要 glibc 2.32，无法在 RHEL 8 上运行。
