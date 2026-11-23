import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { baselineExceptions, embeddedClosureFiles } from './build-portable-linux-release.ts'

const launcher = resolve(import.meta.dirname, 'portable-linux-release/dsh')

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
    // The launcher resolves symlinks, including one in the temporary directory's own path.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-portable-launcher-')))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const release = join(root, 'release')
    await mkdir(join(release, 'libexec'), { recursive: true })
    await copyFile(launcher, join(release, 'dsh'))
    await chmod(join(release, 'dsh'), 0o755)
    await writeFile(join(release, 'libexec', 'dsh'), '#!/bin/sh\nprintf "%s\\n" "$PATH" "$@"\n')
    await chmod(join(release, 'libexec', 'dsh'), 0o755)
    await mkdir(join(root, 'bin'))
    await symlink(join(release, 'dsh'), join(root, 'bin', 'dsh'))

    const output = execFileSync(join(root, 'bin', 'dsh'), ['web', '--port', '8080'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
    }).split('\n')
    expect(output.slice(0, 4)).toEqual([`/usr/bin:/bin:${release}/libexec/sandbox`, 'web', '--port', '8080'])
  })
})
