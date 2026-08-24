import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function privateCommandResult(command, arguments_, timeout = 10_000) {
  return spawnSync(command, arguments_, {
    stdio: 'ignore',
    timeout,
    windowsHide: true,
  })
}

export async function requiredPrivateEpubCheckValidator() {
  const direct = privateCommandResult('epubcheck', ['--version'])
  if (!direct.error && direct.status === 0) {
    return { command: 'epubcheck', arguments: ['--failonwarnings'] }
  }

  const java = privateCommandResult('java', ['-version'])
  if (java.error || java.status !== 0) throw new Error('EPUBCHECK_REQUIRED')
  const jarCandidates = [
    process.env.EPUBCHECK_JAR,
    resolve('tools/epubcheck/epubcheck.jar'),
    '/usr/share/java/epubcheck.jar',
    '/usr/local/share/java/epubcheck.jar',
  ].filter(Boolean)
  for (const jar of jarCandidates) {
    try {
      await access(jar)
      return { command: 'java', arguments: ['-jar', jar, '--failonwarnings'] }
    } catch {
      // Validator paths remain local and never enter the sanitized receipt.
    }
  }
  throw new Error('EPUBCHECK_REQUIRED')
}

/** @returns {Promise<{ status: 'passed' }>} */
export async function validatePrivateEpubWithEpubCheck(bytes, validator) {
  const directory = await mkdtemp(join(tmpdir(), 'srt-private-epubcheck-'))
  const path = join(directory, 'publication.epub')
  try {
    await writeFile(path, bytes, { mode: 0o600 })
    const result = privateCommandResult(
      validator.command,
      [...validator.arguments, path],
      120_000,
    )
    if (result.error || result.status !== 0) throw new Error('EPUBCHECK_FAILED')
    return { status: 'passed' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
