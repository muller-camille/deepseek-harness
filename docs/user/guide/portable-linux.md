# Run the portable Linux release

English | [中文](portable-linux.zh.md)

The portable Linux release runs DeepSeek Harness on x86_64 Linux hosts with glibc 2.28 or newer, including Red Hat Enterprise Linux 8.10, without installing Node.js or any system package. One archive carries the `dsh` command, the Web UI, the search and command-sandbox helpers, and this guide.

## 1. Download and extract

Download `dsh-<version>-linux-x64.tar.gz` and `dsh-<version>-linux-x64.tar.gz.sha256` from the release page, then verify and extract the archive in a directory you own. No root access is required.

```sh
sha256sum -c dsh-<version>-linux-x64.tar.gz.sha256
tar -xzf dsh-<version>-linux-x64.tar.gz
dsh-<version>-linux-x64/dsh --version
```

Start every command through the `dsh` launcher at the top of the extracted directory. To run it by name, link it into a directory on your `PATH`, for example `ln -s "$PWD/dsh-<version>-linux-x64/dsh" ~/.local/bin/dsh`.

## 2. Start the Web UI

Change to the project directory the agent should work in, then start the Web UI. Without the link, run the launcher by its full path.

```sh
cd ~/my-project
dsh web --no-open
```

The command prints a URL such as `http://127.0.0.1:3080/?token=...`. Open the complete URL; the token authenticates the browser. The server accepts connections from this host only.

To use the Web UI from another computer, forward the port over SSH from that computer, then open the printed URL there:

```sh
ssh -L 3080:127.0.0.1:3080 user@rhel-host
```

[Publish the Web UI behind a reverse proxy](./public-deployments.md) covers binding another address.

## 3. Configure a model and a workspace

Open **Settings → Models** and enter a DeepSeek API key, or set `DEEPSEEK_API_KEY` before starting `dsh`. Then select **Choose workspace** and add your project directory. On hosts without the desktop `xdg-user-dir` tool, the Web UI reports that it cannot create a default workspace; choosing a workspace resolves it. The [Web UI guide](./index.md) continues from here.

## Other modes

The launcher runs every CLI mode. For example, this command runs one task and prints the final answer:

```sh
dsh --profile headless "Summarize this repository"
```

The [CLI reference](../../../apps/cli/README.md) lists the modes.

## Command sandbox

The agent runs shell commands in a sandbox that limits writes to the workspace. On Linux the sandbox uses bubblewrap or Landlock. The RHEL 8 kernel has no Landlock and server installations usually lack bubblewrap, so the archive includes a static bubblewrap build at `libexec/sandbox/bwrap`. The launcher appends that directory to `PATH`, so a `bwrap` already installed on the host takes precedence.

bubblewrap requires unprivileged user namespaces, which RHEL 8 enables by default. A hardened host that sets `user.max_user_namespaces` to `0` makes shell commands fail with a sandbox-unavailable error. Ask an administrator to raise the limit, or select the **Full access** permission mode to run commands without confinement.

## Files and data

| Path | Contents |
|---|---|
| `dsh` | Launcher |
| `libexec/dsh` | Executable containing Node.js and the application |
| `libexec/dsh-rg` | ripgrep for the search tools |
| `libexec/sandbox/bwrap` | Static bubblewrap for the command sandbox |
| `libexec/linux-x64/downloads.json` | Locked sources of optional runtime downloads |
| `licenses/` | Licenses of bundled components outside `THIRD_PARTY_NOTICES.md` |

Sessions, settings, and credentials live in `~/.dsh`, or in `$DSH_HOME` when it is set. The executable extracts its native modules to `~/.cache/pkg` on first use; set `PKG_NATIVE_CACHE_PATH` to another directory when the home directory is mounted `noexec`. To uninstall, delete the extracted directory, then delete `~/.dsh` and `~/.cache/pkg` if their data is no longer needed.

Requests to the official DeepSeek API include the session log by default, and explicit feedback uploads the session through OpenTelemetry. The [CLI reference](../../../apps/cli/reference/README.md) describes both uploads and how to turn them off; `DSH_TELEMETRY_DISABLED=1` turns off the OpenTelemetry upload.

## Limitations

- Only x86_64 hosts are supported. The host needs glibc 2.28 and the libstdc++ of GCC 8 or newer.
- Installing plugins that the release does not bundle requires `pnpm` on `PATH`.
- Office conversion tools report LibreOffice Kit as unavailable; Office skills use the host's Python.
- Voice Input, an experimental plugin, requires glibc 2.32 and does not work on RHEL 8.
