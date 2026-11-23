import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { baselineExceptions, disabledDumpIds, embeddedClosureFiles, overlayDisabledIds } from './build-portable-linux-release.ts'

const launcher = resolve(import.meta.dirname, 'portable-linux-release/dsh')
const overlays = resolve(import.meta.dirname, 'portable-linux-release/local-only')

/** Install the launcher beside a stub libexec/dsh that prints PATH, DSH_TELEMETRY_DISABLED, and its arguments. */
async function stubRelease(localOnly: boolean): Promise<string> {
  // The launcher resolves symlinks, including one in the temporary directory's own path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-portable-launcher-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const release = join(root, 'release')
  await mkdir(join(release, 'libexec'), { recursive: true })
  await copyFile(launcher, join(release, 'dsh'))
  await chmod(join(release, 'dsh'), 0o755)
  await writeFile(join(release, 'libexec', 'dsh'), '#!/bin/sh\nprintf "%s\\n" "$PATH" "${DSH_TELEMETRY_DISABLED-unset}" "$@"\n')
  await chmod(join(release, 'libexec', 'dsh'), 0o755)
  if (localOnly) {
    await mkdir(join(release, 'libexec', 'local-only'))
    for (const profile of ['web', 'headless', 'default']) await writeFile(join(release, 'libexec', 'local-only', `${profile}.yml`), '[]\n')
  }
  return release
}

/** Run a stub release's launcher and return the arguments and telemetry switch libexec/dsh received. */
function launch(release: string, args: string[]): { telemetryDisabled: string; args: string[] } {
  const [, telemetryDisabled = '', ...received] = execFileSync(join(release, 'dsh'), args, {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  }).split('\n').slice(0, -1)
  return { telemetryDisabled, args: received }
}

describe('portable Linux release', () => {
  it('audits only the closure files that the executable embeds', () => {
    expect(embeddedClosureFiles([
      'node_modules/node-pty/build/Release/pty.node',
      'node_modules/@deepseek-ai/libreoffice-kit/frame-forwarding/prebuilds/darwin-arm64/frame-forwarding.node',
      'node_modules/@deepseek-ai/libreoffice-kit-linux-x64/program/libmergedlo.so',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
    ])).toEqual([
      'node_modules/node-pty/build/Release/pty.node',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
    ])
  })

  it('names baseline exceptions by target architecture', () => {
    expect(Object.keys(baselineExceptions('x64'))).toEqual(['node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node'])
    expect(Object.keys(baselineExceptions('arm64'))).toEqual(['node_modules/sherpa-onnx-linux-arm64/sherpa-onnx.node'])
  })

  it.skipIf(process.platform === 'win32')('launches libexec/dsh through a symlink with the bundled sandbox last on PATH', async () => {
    const release = await stubRelease(false)
    await mkdir(join(release, '..', 'bin'))
    await symlink(join(release, 'dsh'), join(release, '..', 'bin', 'dsh'))

    const output = execFileSync(join(release, '..', 'bin', 'dsh'), ['web', '--port', '8080'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
    }).split('\n')
    expect(output.slice(0, 5)).toEqual([`/usr/bin:/bin:${release}/libexec/sandbox`, 'unset', 'web', '--port', '8080'])
  })

  it.skipIf(process.platform === 'win32')('adds the booted profile\'s local-only overlay and disables telemetry', async () => {
    const release = await stubRelease(true)
    const overlay = (profile: string) => join(release, 'libexec', 'local-only', `${profile}.yml`)

    expect(launch(release, ['web', '--no-open'])).toEqual({ telemetryDisabled: '1', args: ['web', '--patch', overlay('web'), '--no-open'] })
    expect(launch(release, ['--profile', 'headless', 'Summarize this repository']).args)
      .toEqual(['--patch', overlay('headless'), '--profile', 'headless', 'Summarize this repository'])
    expect(launch(release, ['--profile=web']).args).toEqual(['--patch', overlay('web'), '--profile=web'])
    expect(launch(release, ['--patch', 'mine.yml', '--profile', 'mine', 'run']).args)
      .toEqual(['--patch', overlay('default'), '--patch', 'mine.yml', '--profile', 'mine', 'run'])
    expect(launch(release, ['custom', '--profile', 'web']).args).toEqual(['custom', '--patch', overlay('default'), '--profile', 'web'])
  })

  it.skipIf(process.platform === 'win32')('leaves local-only invocations that boot no profile unchanged', async () => {
    const release = await stubRelease(true)

    for (const args of [[], ['--version'], ['plugin', '--profile', 'web', 'add', 'x'], ['--profile', 'web', '--dump-default-config']]) {
      expect(launch(release, args)).toEqual({ telemetryDisabled: '1', args })
    }
  })

  it('reads the disabled ids of each shipped local-only overlay', async () => {
    const ids = async (name: string) => overlayDisabledIds(await readFile(join(overlays, `${name}.overlay.yml`), 'utf8'))

    expect(await ids('base')).toEqual([
      'llm-deepseek', 'llm-deepseek-account', 'deepseek-account', 'web-search-deepseek', 'web-deepseek-api',
      'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
    ])
    expect(await ids('web')).toEqual(['ui-settings-account', 'ui-account-notifications'])
    expect(await ids('sdk-minimal')).toEqual(['llm-deepseek', 'session-log-deepseek', 'plugin-package-inventory-deepseek'])
  })

  it('accepts only overlay entries that disable a row', () => {
    expect(() => overlayDisabledIds('id: llm-deepseek\n')).toThrow('must be a patch list')
    expect(() => overlayDisabledIds('- id: llm-deepseek\n')).toThrow('{ id, disabled: true }')
    expect(() => overlayDisabledIds('- id: llm-deepseek\n  disabled: false\n')).toThrow('{ id, disabled: true }')
    expect(() => overlayDisabledIds('- id: llm-deepseek\n  disabled: true\n  config: {}\n')).toThrow('{ id, disabled: true }')
  })

  it('collects the disabled top-level entries of a dumped profile tree', () => {
    const dump = [
      '# == @deepseek-ai/dsh-base',
      '- id: session-telemetry-otel',
      '  config:',
      '    disabled: true',
      '  disabled: true',
      '- id: llm-deepseek',
      '  name: \'@deepseek-ai/dsh-llm-deepseek-api-key\'',
      '- id: llm-pi-ai',
      '  config:',
      '    exporter:',
      '      url: !!js process.env.DSH_TELEMETRY_OTLP_URL',
    ].join('\n')

    expect([...disabledDumpIds(dump)]).toEqual(['session-telemetry-otel'])
  })
})
