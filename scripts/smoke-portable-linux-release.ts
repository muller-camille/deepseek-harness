/**
 * Smoke-test a portable Linux release archive as an unprivileged user in a RHEL 8.10 (UBI 8) container
 * that has no Node.js. A host-side mock model drives one headless turn whose bash tool call must run
 * under the bundled bubblewrap, and the Web UI must serve its authenticated page.
 *
 * Usage: pnpm exec tsx scripts/smoke-portable-linux-release.ts --archive=<dsh-...-linux-x64.tar.gz>
 * Requires docker on a Linux host whose architecture matches the archive.
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { startMockLlmServer } from '../packages/test-support/llm-mock-server/src/index.ts'

/** Red Hat Universal Base Image 8.10, which carries the RHEL 8.10 userland. */
const IMAGE = 'registry.access.redhat.com/ubi8/ubi:8.10@sha256:31854d90b8a474b0253a2d4a1f71659097654d5992d6d8b811a679f4ff0084bc'
const ANSWER = 'portable smoke complete'
const PROBE = 'cat /etc/redhat-release; touch /etc/dsh-sandbox-probe'

/** Commands run inside the container; results land in /out for host-side assertions. */
const CONTAINER_SCRIPT = String.raw`
set -euo pipefail
if command -v node >/dev/null; then echo "node must be absent from the image" >&2; exit 1; fi
useradd -m -u "$SMOKE_UID" -o smoke
cat > /tmp/run.sh <<'EOF'
set -euo pipefail
tar -xzf "/release/$ARCHIVE" -C "$HOME"
test -f "$HOME/$NAME/browser-extension/manifest.json"
dsh="$HOME/$NAME/dsh"
"$dsh" --version > /out/version.txt
mkdir -p "$HOME/work" && cd "$HOME/work"
timeout 180 "$dsh" --profile headless "Report the host release" > /out/headless.txt
"$dsh" web --no-open --port "$WEB_PORT" > /out/web.log 2>&1 &
for _ in $(seq 1 90); do grep -q '?token=' /out/web.log && break; sleep 1; done
url="$(grep -oE "http://127\.0\.0\.1:$WEB_PORT/\?token=[A-Za-z0-9_-]+" /out/web.log | head -1)"
curl -sS -c /tmp/jar -b /tmp/jar -L -o /out/web.html -w '%{http_code}' "$url" > /out/web-status.txt
kill %1
EOF
runuser -u smoke -- env HOME=/home/smoke bash /tmp/run.sh
`

/** Reserve an unused loopback TCP port for the containerized Web server. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  await new Promise<void>((done) => { server.close(() => { done() }) })
  if (address === null || typeof address === 'string') throw new Error('smoke-portable-linux-release: no TCP port was assigned')
  return address.port
}

/** Run one command with inherited output; a non-zero exit rejects. */
async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code) => {
      if (code === 0) done()
      else fail(new Error(`${command} exited with ${code}`))
    })
  })
}

/** Decompress every Session log under a Harness home. */
async function sessionLogs(home: string): Promise<string> {
  const logs: string[] = []
  for (const entry of await readdir(join(home, 'sessions'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) {
      logs.push(zstdDecompressSync(await readFile(join(entry.parentPath, entry.name))).toString('utf8'))
    }
  }
  return logs.join('\n')
}

function expectIncludes(label: string, text: string, expected: string): void {
  if (!text.includes(expected)) throw new Error(`smoke-portable-linux-release: ${label} lacks ${JSON.stringify(expected)}:\n${text.slice(0, 2000)}`)
  console.log(`smoke-portable-linux-release: ${label} contains ${JSON.stringify(expected)}`)
}

/**
 * Run the smoke test against one archive.
 * @param argv - command-line arguments, excluding the interpreter and script.
 */
export async function smokePortableLinuxRelease(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { archive: { type: 'string' } } })
  if (values.archive === undefined) throw new Error('smoke-portable-linux-release: --archive=<path> is required.')
  const archive = resolve(values.archive)
  const name = basename(archive, '.tar.gz')
  const version = /^dsh-(.+)-linux-(?:x64|arm64)$/.exec(name)?.[1]
  if (version === undefined) throw new Error(`smoke-portable-linux-release: ${archive} is not a dsh-<version>-linux-<arch>.tar.gz archive.`)
  const model = await startMockLlmServer({
    apiKey: 'mock-key',
    // The concurrent title request may take either scripted tool call; the turn still receives one.
    sequence: ['tool_call_success', 'tool_call_success', 'success'],
    repeatLast: true,
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: PROBE, description: 'Report the host release' }),
    successText: ANSWER,
  })
  const work = await mkdtemp(join(tmpdir(), 'dsh-portable-smoke-'))
  try {
    const home = join(work, 'home')
    const out = join(work, 'out')
    for (const directory of [home, out]) {
      await mkdir(directory)
      await chmod(directory, 0o777)
    }
    const uid = process.getuid?.() ?? 0
    await run('docker', [
      'run', '--rm', '--network', 'host',
      // Docker's default seccomp profile and /proc masking block the user namespace and procfs mount
      // that bubblewrap creates on a RHEL host.
      '--security-opt', 'seccomp=unconfined', '--security-opt', 'systempaths=unconfined',
      '-v', `${dirname(archive)}:/release:ro`, '-v', `${home}:/dsh-home`, '-v', `${out}:/out`,
      '-e', `SMOKE_UID=${uid === 0 ? 1000 : uid}`, '-e', `ARCHIVE=${basename(archive)}`, '-e', `NAME=${name}`,
      '-e', `WEB_PORT=${await freePort()}`, '-e', 'DSH_HOME=/dsh-home', '-e', 'DSH_TELEMETRY_DISABLED=1',
      '-e', 'DEEPSEEK_API_KEY=mock-key', '-e', `DEEPSEEK_BASE_URL=${model.baseURL}/v1`,
      IMAGE, 'bash', '-c', CONTAINER_SCRIPT,
    ])
    const read = async (file: string) => (await readFile(join(out, file), 'utf8')).trim()
    if (await read('version.txt') !== version) throw new Error(`smoke-portable-linux-release: dsh --version reported ${await read('version.txt')}, expected ${version}`)
    console.log(`smoke-portable-linux-release: dsh --version reports ${version}`)
    expectIncludes('headless answer', await read('headless.txt'), ANSWER)
    const log = await sessionLogs(home)
    expectIncludes('bash tool result', log, 'Red Hat Enterprise Linux release 8.10')
    // bubblewrap mounts the host root read-only outside the workspace.
    expectIncludes('bash tool result', log, "cannot touch '/etc/dsh-sandbox-probe': Read-only file system")
    if (await read('web-status.txt') !== '200') throw new Error(`smoke-portable-linux-release: Web UI returned HTTP ${await read('web-status.txt')}`)
    expectIncludes('Web UI page', await read('web.html'), '<title>DeepSeek Harness</title>')
  } finally {
    await model.close()
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) await smokePortableLinuxRelease(process.argv.slice(2))
