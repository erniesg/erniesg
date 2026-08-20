import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { publicationBrowserInstallInvocation } from './publication-install-browser.mjs'

const execFileAsync = promisify(execFile)

async function runPostinstall({ buildExitCode }) {
  const fixture = await mkdtemp(join(tmpdir(), 'publication-postinstall-'))
  const eventsFile = join(fixture, 'events.txt')
  await mkdir(join(fixture, 'tools'))
  const recordEventSource = `import { appendFile } from 'node:fs/promises'
await appendFile(process.env.PUBLICATION_EVENTS, process.argv[2] + '\\n')
if (process.argv[2] === 'build') process.exit(Number(process.argv[3]))
`
  await writeFile(join(fixture, 'record-event.mjs'), recordEventSource)

  const packageManifest = JSON.parse(
    await readFile(resolve(process.cwd(), 'package.json'), 'utf8'),
  )
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: {
        postinstall: packageManifest.scripts.postinstall,
        'struct:build': `node record-event.mjs build ${buildExitCode}`,
      },
    }),
  )
  await writeFile(
    join(fixture, 'tools/publication-install-browser.mjs'),
    `import { appendFile } from 'node:fs/promises'
await appendFile(process.env.PUBLICATION_EVENTS, 'browser\\n')
`,
  )

  try {
    const result = await execFileAsync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'postinstall'],
      {
        cwd: fixture,
        env: { ...process.env, PUBLICATION_EVENTS: eventsFile },
      },
    )
    return {
      exitCode: 0,
      ...result,
      events: await readFile(eventsFile, 'utf8'),
    }
  } catch (error) {
    return {
      exitCode: error.code,
      ...error,
      events: await readFile(eventsFile, 'utf8'),
    }
  }
}

describe('publication browser installer', () => {
  it('invokes JavaScript entrypoints through the current Node runtime', () => {
    const invocation = publicationBrowserInstallInvocation('linux', 'arm64')
    expect(invocation.playwright.command).toBe(process.execPath)
    expect(invocation.playwright.args[0]).toMatch(
      /node_modules[\\/]playwright[\\/]cli\.js$/,
    )
    expect(invocation.playwright.args[0]).not.toMatch(/@playwright[\\/]test/)
    expect(invocation.puppeteer.command).toBe(process.execPath)
    expect(invocation.puppeteer.args[0]).toMatch(
      /node_modules[\\/]@puppeteer[\\/]browsers[\\/]lib[\\/]main-cli\.js$/,
    )
  })

  it('fails before installation on unsupported OS and architecture pairs', () => {
    expect(() => publicationBrowserInstallInvocation('win32', 'x64')).toThrow(
      /Unsupported publication operating system/,
    )
    expect(() =>
      publicationBrowserInstallInvocation('linux', 'riscv64'),
    ).toThrow(/Unsupported publication architecture/)
  })

  it('stops before browser setup when the STRUCT build fails', async () => {
    const result = await runPostinstall({ buildExitCode: 17 })

    expect(result.exitCode).toBe(17)
    expect(result.events).toBe('build\n')
  })

  it('runs browser setup after a successful STRUCT build', async () => {
    const result = await runPostinstall({ buildExitCode: 0 })

    expect(result.exitCode).toBe(0)
    expect(result.events).toBe('build\nbrowser\n')
  })
})
