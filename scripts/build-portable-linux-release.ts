/**
 * Package the Linux dsh executable as a portable archive that runs without installing Node.js.
 * Inputs are the `dist-exe/` products of scripts/build-exe-for-python-sdk.ts for the same target and
 * the static bubblewrap from scripts/portable-linux-release/build-bubblewrap.sh. Every native file
 * the archive carries or the executable embeds must fit the manylinux_2_28 (RHEL 8) baseline, except
 * the listed {@link baselineExceptions}. docs/user/guide/portable-linux.md owns the user-facing layout
 * and ships as the archive's README.md.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, matchesGlob, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { create as createTar } from 'tar'
import { OFFICE_ASSET_IGNORES } from './build-exe-for-python-sdk-office.ts'
import { fileDigest, payloadFiles } from './ssh-helper/artifact.ts'
import { verifyNativeFiles, verifyNativePayload } from './ssh-helper/native.ts'

const root = resolve(import.meta.dirname, '..')
/** Deployed executable closure staged by build-exe-for-python-sdk.ts. */
const CLOSURE = join(root, 'python/sdk-runtime/src/deepseek_harness_runtime/runtime/node')
const TARGETS = ['node24-linux-x64', 'node24-linux-arm64'] as const
type Target = typeof TARGETS[number]

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value)
}

/**
 * Embedded native files allowed to exceed the baseline, with the reason each cannot break startup.
 * @param arch - target architecture naming the platform package.
 * @returns closure-relative paths mapped to their justification.
 */
export function baselineExceptions(arch: 'x64' | 'arm64'): Readonly<Record<string, string>> {
  return {
    [`node_modules/sherpa-onnx-linux-${arch}/sherpa-onnx.node`]:
      'the experimental Voice Input recognizer loads it only in its transcription worker, and shipped profiles leave that bundle disabled',
  }
}

/**
 * Select the closure files that pkg embeds: everything outside its configured ignore globs.
 * @param paths - closure-relative POSIX paths.
 * @returns the embedded subset in input order.
 */
export function embeddedClosureFiles(paths: readonly string[]): string[] {
  return paths.filter(path => !OFFICE_ASSET_IGNORES.some(pattern => matchesGlob(path, pattern)))
}

/**
 * Require each embedded native file to fit the baseline; each exception must still exist and still violate it.
 * @param closure - deployed closure directory.
 * @param target - Linux target.
 */
async function auditEmbeddedNativeFiles(closure: string, target: Target): Promise<void> {
  const exceptions = baselineExceptions(target.endsWith('-arm64') ? 'arm64' : 'x64')
  const embedded = embeddedClosureFiles(await payloadFiles(closure))
  for (const [path, reason] of Object.entries(exceptions)) {
    if (!embedded.includes(path)) throw new Error(`build-portable-linux-release: baseline exception ${path} is not embedded; remove it.`)
    const passes = await verifyNativeFiles(closure, [path], target).then(() => true, () => false)
    if (passes) throw new Error(`build-portable-linux-release: ${path} now fits the baseline; remove its exception.`)
    console.log(`build-portable-linux-release: baseline exception ${path}: ${reason}`)
  }
  const inspected = await verifyNativeFiles(closure, embedded.filter(path => !(path in exceptions)), target)
  console.log(`build-portable-linux-release: ${inspected.length} embedded native files fit manylinux_2_28`)
}

/** Copy one file and set its mode. */
async function place(source: string, destination: string, mode: number): Promise<void> {
  await copyFile(source, destination)
  await chmod(destination, mode)
}

/**
 * Build `dsh-<version>-linux-<arch>.tar.gz` and its `.sha256` file.
 * @param argv - command-line arguments, excluding the interpreter and script.
 * @returns the archive path.
 */
export async function buildPortableLinuxRelease(argv: string[]): Promise<string> {
  const { values } = parseArgs({ args: argv, options: {
    target: { type: 'string', default: 'node24-linux-x64' },
    bubblewrap: { type: 'string' },
    output: { type: 'string', default: 'dist-portable' },
  } })
  const target = values.target
  if (!isTarget(target)) throw new Error(`build-portable-linux-release: --target must be one of ${TARGETS.join(', ')}.`)
  if (values.bubblewrap === undefined) throw new Error('build-portable-linux-release: --bubblewrap=<directory> is required.')
  const arch = target.endsWith('-arm64') ? 'arm64' : 'x64'
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new Error(`build-portable-linux-release: run on linux-${arch} so the packaged executable can be started.`)
  }
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }
  const executable = join(root, 'dist-exe', `deepseek-harness-sdk-runtime-linux-${arch}`)
  const bubblewrap = resolve(root, values.bubblewrap)
  const inputs = {
    executable,
    ripgrep: `${executable}-rg`,
    downloads: join(root, 'dist-exe', `linux-${arch}`, 'downloads.json'),
    bwrap: join(bubblewrap, 'bwrap'),
    bwrapLicense: join(bubblewrap, 'COPYING'),
    bwrapSource: join(bubblewrap, 'SOURCE'),
  }
  const missing = Object.values(inputs).filter(path => !existsSync(path))
  if (missing.length > 0) throw new Error(`build-portable-linux-release: missing inputs: ${missing.join(', ')}`)
  if (execFileSync('readelf', ['--program-headers', inputs.bwrap], { encoding: 'utf8' }).includes('INTERP')) {
    throw new Error(`build-portable-linux-release: ${inputs.bwrap} must be statically linked.`)
  }
  await auditEmbeddedNativeFiles(CLOSURE, target)

  const name = `dsh-${version}-linux-${arch}`
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-portable-'))
  try {
    const product = join(temporary, name)
    const libexec = join(product, 'libexec')
    await mkdir(join(libexec, 'sandbox'), { recursive: true })
    await mkdir(join(libexec, `linux-${arch}`))
    await mkdir(join(product, 'licenses', 'bubblewrap'), { recursive: true })
    await place(join(root, 'scripts/portable-linux-release/dsh'), join(product, 'dsh'), 0o755)
    await place(inputs.executable, join(libexec, 'dsh'), 0o755)
    await place(inputs.ripgrep, join(libexec, 'dsh-rg'), 0o755)
    await place(inputs.downloads, join(libexec, `linux-${arch}`, 'downloads.json'), 0o644)
    await place(inputs.bwrap, join(libexec, 'sandbox', 'bwrap'), 0o755)
    await place(inputs.bwrapLicense, join(product, 'licenses', 'bubblewrap', 'COPYING'), 0o644)
    await place(inputs.bwrapSource, join(product, 'licenses', 'bubblewrap', 'SOURCE'), 0o644)
    await place(join(root, 'docs/user/guide/portable-linux.md'), join(product, 'README.md'), 0o644)
    await place(join(root, 'LICENSE'), join(product, 'LICENSE'), 0o644)
    await place(join(root, 'THIRD_PARTY_NOTICES.md'), join(product, 'THIRD_PARTY_NOTICES.md'), 0o644)
    // The browser bridge bundle's Chrome extension, loaded unpacked on the computer that opens the Web UI.
    await cp(join(root, 'packages/experimental/browser-use-extension-bridge/extension'), join(product, 'browser-extension'), { recursive: true })
    const native = await verifyNativePayload(product, target)
    console.log(`build-portable-linux-release: archive native files fit manylinux_2_28: ${native.join(', ')}`)
    const reported = execFileSync(join(product, 'dsh'), ['--version'], {
      encoding: 'utf8', env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
    }).trim()
    if (reported !== version) throw new Error(`build-portable-linux-release: launcher reported ${JSON.stringify(reported)}, expected ${version}.`)

    const output = resolve(root, values.output)
    await mkdir(output, { recursive: true })
    const archive = join(output, `${name}.tar.gz`)
    await createTar({ cwd: temporary, file: archive, gzip: true, portable: true }, [name])
    await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  ${basename(archive)}\n`)
    console.log(`build-portable-linux-release: wrote ${archive}`)
    return archive
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildPortableLinuxRelease(process.argv.slice(2))
