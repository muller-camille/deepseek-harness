---
description: "Operate pages in the user's own Chrome, with its signed-in sessions, through the DeepSeek Harness browser extension and the Web UI connection."
kind: "package-bundle"
---

# @deepseek-ai/dsh-browser-use-extension-bridge

English | [中文](README.zh.md)

## Summary

Let the agent open, read, click, and type in the user's own Chrome. Pages load with the user's signed-in sessions and run their JavaScript, while the agent runs on the DeepSeek Harness server. The bundled Chrome extension connects from the Web UI tab to this plugin over the Web UI's own address and sign-in, so the user's computer opens no port and needs no SSH tunnel. The extension acts only on sites the user allows. This published experimental package activates only when explicitly mounted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh` installation ships this package as an optional bundle that shipped profiles leave off. Switch on **Browser use (your Chrome)** on the Web UI's Plugins page; its [`cordis.patch.yml`](cordis.patch.yml) inserts the browser-use service and this provider. Then set up Chrome on the computer that opens the Web UI:

1. Open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose this package's `extension` directory.
2. Open the extension's options, add the Web UI address under **DeepSeek Harness server**, and accept Chrome's access prompt.
3. Under **Allowed sites**, add each site the agent may use, such as `intranet.example.com` or `*.example.com`.
4. Open the Web UI in that Chrome. The options page reports **Connected** while a Web UI tab is open.

The agent works in a tab group named "DSH agent". Closing that tab, or turning on **Pause agent** in the options, stops browser control.

| Field | Default | Meaning |
|---|---|---|
| `commandTimeoutMs` | `30000` | Budget for one browser command, including page loads and `wait_for` |
| `maxContentChars` | `50000` | Cap on the Markdown one `browser_read` returns |
| `maxHtmlChars` | `2000000` | Cap on the sanitized HTML the extension sends for one read |
| `heartbeatIntervalMs` | `30000` | Interval between pings to each connected Web UI tab |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider registers the `/browser-bridge` WebSocket upgrade route on `ctx.webServer` with required authentication. The extension's relay content script runs only in Web UI tabs whose origin the user configured. Its WebSocket carries that page's origin and sign-in cookie, so the Web server's Host and Origin checks and its authentication admit it exactly as they admit the Web UI; the socket closes when that sign-in ends. The relay forwards frames to the extension's service worker, which runs each command in the agent tab group.

The most recent Web UI tab that completed its hello serves commands, and an older tab takes over when it closes. Commands run one at a time because every Agent shares the one agent tab. A command that outlives its budget is canceled in the extension and fails with `BROWSER_TIMEOUT`.

The service worker checks every target and every page an action lands on against Chrome's granted host permissions, and it refuses the configured server hosts so the agent cannot operate the Web UI, including its approval controls. A read removes scripts, styles, and hidden elements, marks visible links, buttons, and form fields with `[ref=N]`, and returns HTML that the provider converts to Markdown with turndown. The extension flattens subtrees deeper than 300 elements to their text, and the provider refuses markup nested deeper than 512 elements, because turndown's synchronous conversion slows sharply with depth.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser-use service](../../browser-use/browser-use/README.md) — exclusive provider registration.
- [Web server](../../host/webserver/README.md) — upgrade routes and request admission.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools

#### What the model sees

Four tools: `browser_open` (URL and optional `wait_for` selector), `browser_read` (optional `selector` and `wait_for`), `browser_click`, and `browser_type` (a `ref` from the latest read or a CSS `selector`, plus `text` and `submit` for typing). Actions return the agent tab's title and URL. A read returns the page title and URL, the untrusted-content notice, and Markdown with `[ref=N]` markers on links, buttons, and form fields; refs are reassigned on every read. One system-prompt section explains the user's browser, signed-in sessions, allowed sites, refs, and that page content is data. When no Web UI tab with the extension is connected, the tools stay listed and fail with `BROWSER_NOT_CONNECTED`; a refused site lists the allowed sites.

#### Token effect

Four tool definitions and the prompt section are constant. Each read adds up to `maxContentChars` of Markdown to Session history.

#### KV Cache effect

The tool definitions and prompt section do not change with the connection state, so the prefix stays reusable. Results append to history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Chrome and other Chromium browsers with Manifest V3 extensions only; the extension is loaded unpacked and is not published to the Chrome Web Store.
- One agent tab is shared by every Session on the server, and commands run one at a time.
- The agent acts with the user's signed-in sessions on allowed sites. Cancellation does not undo navigation, clicks, or typing already delivered.
- Reads see the top document only; content inside frames is not returned. Screenshots, file uploads, and downloads are not available.
- Anyone who controls the server, or holds the user's Web UI sign-in, can drive the browser on the allowed sites while a Web UI tab is open.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The extension sources are plain JavaScript loaded by Chrome without a build step. `tests/extension.e2e.ts` loads them into real Chromium when `DSH_BROWSER_BRIDGE_E2E=1`; set `DSH_BROWSER_BRIDGE_CHROMIUM` to a full Chromium build, because extensions do not load in the headless shell.

</details>
