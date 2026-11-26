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

## Use only your own model server

The release also offers `dsh-<version>-linux-x64-local.tar.gz`, which never contacts DeepSeek-operated services; use it in place of the standard archive in the steps above. Its launcher adds the overlay in `libexec/local-only/` for the profile it starts, which disables the DeepSeek model routes and their model listing, DeepSeek account sign-in, DeepSeek web search and fetch, the request extensions that only official DeepSeek requests carry, and the feedback upload to DeepSeek's OpenTelemetry collector. Models then come only from providers you add, and `web_search` reports that no search provider is available.

Add your server in **Settings → Models → Add model provider → Custom model API**, or in `~/.dsh/profiles/web/cordis.patch.yml`. `apiKeyEnv` names the environment variable that holds the key, never the key itself:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-server:
        apiKeyEnv: MY_SERVER_API_KEY
        api: openai-completions
        baseURL: http://model-host:8080/v1
        models:
          - id: my-model
            contextWindow: 32768
```

Start the Web UI with that variable set, for example `MY_SERVER_API_KEY=... dsh web --no-open`, then choose the model in the composer's model picker. [Configure models](./providers.md) covers the protocol, reasoning, and request-compatibility settings that self-hosted servers often need.

## Connect to your wiki, Oracle, and Kibana

Three experimental plugins give the agent read-only access to systems on your network. Each is off by default. Add its settings to `~/.dsh/profiles/web/cordis.patch.yml`, then switch it on in **Plugins**:

| Plugin | Tools | Settings |
|---|---|---|
| **Local wiki (MediaWiki)** | `wiki_search`, `wiki_read` | `apiUrl` of the wiki's `api.php` |
| **Oracle database (read-only)** | `oracle_schema`, `oracle_query` | `connectString`, `user`, and `passwordEnv`, the variable that holds the password |
| **Kibana logs and dashboards** | `kibana_data_views`, `kibana_fields`, `kibana_search`, `kibana_saved_objects`, `kibana_saved_object` | `url`, plus `username` and `passwordEnv`, or `apiKeyEnv` |

```yaml
- id: mediawiki
  config:
    apiUrl: http://wiki.intranet/w/api.php
- id: oracle-db
  config:
    connectString: dbhost:1521/ORCLPDB1
    user: report_reader
    passwordEnv: ORACLE_PASSWORD
- id: kibana
  config:
    url: http://kibana.intranet:5601
    username: dsh_reader
    passwordEnv: KIBANA_PASSWORD
```

Start `dsh` with the password variables set, for example `ORACLE_PASSWORD=... KIBANA_PASSWORD=... dsh web --no-open`, and list the three hosts in `no_proxy` when the host uses an HTTP proxy. Use database and Kibana accounts that can only read. The [MediaWiki](../../../packages/experimental/mediawiki/README.md), [Oracle](../../../packages/experimental/oracle-db/README.md), and [Kibana](../../../packages/experimental/kibana/README.md) references describe every setting and limit.

## Browse with your own Chrome

The agent can open, read, and operate pages in the Chrome on your computer, with your signed-in sessions, through the bundled browser extension. The extension connects through the Web UI tab, so nothing listens on your computer.

1. In the Web UI, open **Plugins** and switch on **Browser use (your Chrome)**.
2. Copy the archive's `browser-extension` directory to the computer that opens the Web UI. In Chrome, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose that directory.
3. In the extension's options, add the Web UI address, then add each site the agent may use.

Keep the Web UI tab open while the agent browses; it works in a tab group named "DSH agent". The [browser bridge reference](../../../packages/experimental/browser-use-extension-bridge/README.md) describes the tools and their limits.

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
| `libexec/local-only/` | Local-only archive only: the overlay the launcher adds for each profile, and `default.yml` for custom profiles |
| `browser-extension/` | Chrome extension for browsing with your own Chrome |
| `licenses/` | Licenses of bundled components outside `THIRD_PARTY_NOTICES.md` |

Sessions, settings, and credentials live in `~/.dsh`, or in `$DSH_HOME` when it is set. The executable extracts its native modules to `~/.cache/pkg` on first use; set `PKG_NATIVE_CACHE_PATH` to another directory when the home directory is mounted `noexec`. To uninstall, delete the extracted directory, then delete `~/.dsh` and `~/.cache/pkg` if their data is no longer needed.

Requests to the official DeepSeek API include the session log by default, and explicit feedback uploads the session through OpenTelemetry. The [CLI reference](../../../apps/cli/reference/README.md) describes both uploads and how to turn them off; `DSH_TELEMETRY_DISABLED=1` turns off the OpenTelemetry upload. The local-only archive performs neither upload.

## Limitations

- Only x86_64 hosts are supported. The host needs glibc 2.28 and the libstdc++ of GCC 8 or newer.
- Installing plugins that the release does not bundle requires `pnpm` on `PATH`.
- Office conversion tools report LibreOffice Kit as unavailable; Office skills use the host's Python.
- Voice Input, an experimental plugin, requires glibc 2.32 and does not work on RHEL 8.
