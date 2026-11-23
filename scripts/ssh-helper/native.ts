/** Inspect every native payload, including modules embedded in the executable. */
import { execFileSync } from 'node:child_process'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { payloadFiles, type SshHelperTarget } from './artifact.ts'

function newer(version: string, ceiling: readonly number[]): boolean {
  const components = version.split('.').map(Number)
  for (let index = 0; index < Math.max(components.length, ceiling.length); index += 1) {
    const difference = (components[index] ?? 0) - (ceiling[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

/** manylinux_2_28 symbol-version ceilings, which RHEL 8's glibc 2.28, libstdc++ 6.0.25, and libgcc_s provide. */
const LINUX_SYMBOL_VERSION_CEILINGS: Readonly<Record<string, readonly number[]>> = {
  GLIBC: [2, 28],
  GLIBCXX: [3, 4, 25],
  CXXABI: [1, 3, 11],
  GCC: [7, 0, 0],
}

/**
 * List required symbol versions that exceed the Linux deployment baseline.
 * @param output - `readelf --version-info` text for one ELF file.
 * @returns each required `<family>_<version>` above its ceiling; version definitions and symbol tables are ignored.
 */
export function linuxSymbolVersionViolations(output: string): string[] {
  const violations: string[] = []
  let needs = false
  for (const line of output.split('\n')) {
    const section = /^Version (\w+) section '/.exec(line.trim())
    if (section !== null) {
      needs = section[1] === 'needs'
      continue
    }
    const match = needs ? /\bName: (GLIBCXX|GLIBC|CXXABI|GCC)_(\d+(?:\.\d+)*)(?=\s|$)/.exec(line) : null
    if (match === null) continue
    const family = match[1] as string
    const version = match[2] as string
    if (newer(version, LINUX_SYMBOL_VERSION_CEILINGS[family] as readonly number[])) violations.push(`${family}_${version}`)
  }
  return violations
}

/**
 * Read deployment versions without confusing linked-library versions with OS requirements.
 * @param output - otool load-command text, possibly containing multiple architecture slices.
 * @returns every minimum macOS version declared by the binary.
 */
export function macosDeploymentVersions(output: string): string[] {
  let command: string | undefined
  const versions: string[] = []
  for (const line of output.split('\n')) {
    const text = line.trim()
    if (/^Load command \d+$/.test(text)) command = undefined
    else if (text.startsWith('cmd ')) command = text.slice(4)
    else {
      const match = /^(minos|version)\s+(\d+(?:\.\d+)+)$/.exec(text)
      if (match !== null && ((command === 'LC_BUILD_VERSION' && match[1] === 'minos') || (command === 'LC_VERSION_MIN_MACOSX' && match[1] === 'version'))) versions.push(match[2] as string)
    }
  }
  return versions
}

/**
 * Inspect all ELF or Mach-O files for the requested architecture and deployment baseline.
 * @param directory - symlink-free staging or payload directory.
 * @param target - build target whose ABI must match every native file.
 * @returns relative paths of inspected native files.
 */
export async function verifyNativePayload(directory: string, target: SshHelperTarget): Promise<string[]> {
  return verifyNativeFiles(directory, await payloadFiles(directory), target)
}

/**
 * Inspect the selected files of a directory; non-native files are skipped.
 * @param directory - root that the relative paths name files under.
 * @param paths - POSIX relative paths of regular files to inspect.
 * @param target - build target whose ABI must match every native file.
 * @returns relative paths of inspected native files; the first violation rejects.
 */
export async function verifyNativeFiles(directory: string, paths: readonly string[], target: SshHelperTarget): Promise<string[]> {
  const inspected: string[] = []
  const linux = target.includes('-linux-')
  const arch = target.endsWith('-arm64') ? 'arm64' : 'x64'
  for (const path of paths) {
    const filename = join(directory, path)
    const file = await open(filename, 'r')
    const header = Buffer.alloc(4)
    try { await file.read(header, 0, 4, 0) } finally { await file.close() }
    const magic = header.readUInt32BE()
    const elf = magic === 0x7f454c46
    const macho = [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xbebafeca, 0xcafebabf].includes(magic)
    if (!elf && !macho) continue
    if (linux !== elf) throw new Error(`Native file does not belong to ${target}: ${path}`)
    if (elf) {
      const elfHeader = execFileSync('readelf', ['--file-header', filename], { encoding: 'utf8' })
      const expected = arch === 'arm64' ? /Machine:\s+AArch64/ : /Machine:\s+Advanced Micro Devices X86-64/
      if (!expected.test(elfHeader)) throw new Error(`ELF architecture differs from ${target}: ${path}`)
      const violations = linuxSymbolVersionViolations(execFileSync('readelf', ['--version-info', filename], { encoding: 'utf8' }))
      if (violations.length > 0) throw new Error(`${path} requires ${violations.join(', ')}, exceeding the manylinux_2_28 baseline`)
    } else {
      execFileSync('lipo', [filename, '-verify_arch', arch === 'arm64' ? 'arm64' : 'x86_64'], { stdio: 'pipe' })
      const loads = execFileSync('otool', ['-l', filename], { encoding: 'utf8' })
      const versions = macosDeploymentVersions(loads)
      if (versions.length === 0) throw new Error(`Mach-O has no deployment version: ${path}`)
      if (versions.some(version => newer(version, [14, 0]))) throw new Error(`${path} requires macOS newer than 14.0`)
    }
    inspected.push(path)
  }
  return inspected
}
