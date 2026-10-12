import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import fg from 'fast-glob'
import matter from 'gray-matter'
import { getManifestTarget, isProtectedPath, sha256 } from './content.mjs'

export const TRUSTED_VM_ALIAS = 'erniesg-ai-vm'
export const VM_RUNNER_VERSION = 'v1'
export const VM_RUNNER_ROOT = `/opt/erniesg-translation-publisher/${VM_RUNNER_VERSION}/tools/translation`
const INPUT_PATTERNS = [
  '.translation/*.json',
  '.translation/reports/**/*.json',
  'docs/translation/**/*.{md,txt}',
  'src/content/blog/**/*.mdx',
  'public/**/*.{avif,gif,jpeg,jpg,png,svg,webp}',
  'dist/**/*.html',
]
const MACHINE = new Set([
  'codex',
  'codex-cli',
  'openai',
  'anthropic',
  'google',
  'gemini',
])
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
const sidecar = (file) =>
  /^src\/content\/blog\/.+\/(?:zh|ja|ko)\.mdx$/u.test(file)
const artifact = (file) =>
  file === '.translation/manifest.json' ||
  file === '.translation/pages.json' ||
  /^\.translation\/reports\/.+\.json$/u.test(file) ||
  sidecar(file)
const safe = (file) =>
  Boolean(file) &&
  !file.startsWith('/') &&
  !file.includes('\\') &&
  file.split('/').every((part) => part && part !== '.' && part !== '..')
const relative = (file) => file.replace(/^\.\//u, '')

async function files(root, patterns = ['**/*']) {
  const candidates = await fg(patterns, {
    cwd: root,
    onlyFiles: false,
    onlyDirectories: false,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
  })
  const result = []
  for (const candidate of candidates) {
    const file = candidate.split(path.sep).join('/')
    const stat = await fs.lstat(path.join(root, file))
    if (stat.isSymbolicLink())
      throw new Error(`Symbolic links are not allowed: ${file}`)
    if (stat.isFile()) result.push(file)
  }
  return result.sort()
}
async function regularFile(root, file) {
  if (!safe(file)) throw new Error(`Unsafe path: ${file}`)
  let current = root
  for (const part of file.split('/')) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink())
      throw new Error(`Symbolic links are not allowed: ${file}`)
  }
  if (!(await fs.lstat(current)).isFile())
    throw new Error(`Regular files only: ${file}`)
  return fs.readFile(current)
}
async function hashes(root, list) {
  return Object.fromEntries(
    await Promise.all(
      list.map(async (file) => [file, hash(await regularFile(root, file))]),
    ),
  )
}
async function json(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}
async function noLinks(root) {
  const stat = await fs.lstat(root)
  if (stat.isSymbolicLink()) throw new Error(`Unsafe archive entry: ${root}`)
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name)
    if (entry.isSymbolicLink())
      throw new Error(`Unsafe archive entry: ${entry.name}`)
    if (entry.isDirectory()) await noLinks(child)
    else if (!entry.isFile())
      throw new Error(`Unsafe archive entry: ${entry.name}`)
  }
}
async function assertTree(root, expected, label) {
  const actual = await files(root)
  if (
    actual.length !== Object.keys(expected).length ||
    actual.some((file) => expected[file] === undefined)
  )
    throw new Error(`${label} inventory changed`)
  for (const file of actual)
    if (hash(await regularFile(root, file)) !== expected[file])
      throw new Error(`${label} changed: ${file}`)
}
async function assertKnown(root, expected, label) {
  for (const [file, expectedHash] of Object.entries(expected)) {
    const actual = await regularFile(root, file)
      .then(hash)
      .catch((error) => (error.code === 'ENOENT' ? null : null))
    if (actual !== expectedHash) throw new Error(label + ' changed: ' + file)
  }
}
function field(value, parts) {
  return parts.reduce((result, part) => result?.[part], value)
}
function protectedRecords(value, parts = []) {
  if (Array.isArray(value)) return [[parts, value]]
  if (!value || typeof value !== 'object') return [[parts, value]]
  if (Object.hasOwn(value, 'status'))
    return value.status === 'machine' ? [] : [[parts, value]]
  return Object.entries(value).flatMap(([key, child]) =>
    protectedRecords(child, [...parts, key]),
  )
}
function assertProtected(input, output) {
  for (const [parts, value] of protectedRecords(input))
    if (JSON.stringify(field(output, parts)) !== JSON.stringify(value))
      throw new Error(
        `protected translation entry changed: ${parts.join('.') || '<root>'}`,
      )
}

export async function createPublishStage({
  repoRoot = process.cwd(),
  runId = crypto.randomUUID(),
  stageRoot = path.join(repoRoot, 'generated', 'tmp'),
} = {}) {
  if (!/^[a-zA-Z0-9-]+$/u.test(runId))
    throw new Error(
      'Publish run id must contain only letters, numbers, and hyphens.',
    )
  const stagePath = path.join(stageRoot, `erniesg-localization-${runId}`)
  await fs.access(stagePath).then(
    () => {
      throw new Error(`Publish stage already exists: ${stagePath}`)
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
  const list = await files(repoRoot, INPUT_PATTERNS)
  const sourceHashes = await hashes(repoRoot, list)
  await fs.mkdir(stagePath, { recursive: true })
  for (const file of list) {
    const target = path.join(stagePath, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(repoRoot, file), target)
  }
  const stage = {
    path: stagePath,
    files: list,
    hashes: await hashes(stagePath, list),
  }
  if (JSON.stringify(sourceHashes) !== JSON.stringify(stage.hashes))
    throw new Error('Publish stage copy changed')
  return stage
}
async function checkSidecar(
  stage,
  outputRoot,
  file,
  config,
  inputManifest,
  outputManifest,
) {
  const raw = (await regularFile(outputRoot, file)).toString('utf8')
  const data = matter(raw).data ?? {}
  const target = getManifestTarget(outputManifest, file)
  const source = `${path.dirname(file)}/index.mdx`
  const sourceRaw = await fs
    .readFile(path.join(stage.path, source), 'utf8')
    .catch(() => null)
  if (
    data.lang !== path.basename(file, '.mdx') ||
    data.translationStatus !== 'machine' ||
    !MACHINE.has(data.translationSource) ||
    target?.status !== 'machine' ||
    target.path !== file ||
    target.targetSha256 !== sha256(raw) ||
    target.sourcePath !== source ||
    !sourceRaw ||
    target.sourceSha256 !== sha256(sourceRaw)
  )
    throw new Error(`Invalid returned machine sidecar: ${file}`)
  const old = await fs
    .readFile(path.join(stage.path, file), 'utf8')
    .catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
  if (old === null) {
    if (isProtectedPath(file, config))
      throw new Error(`Refusing protected new target: ${file}`)
    return
  }
  if (sha256(old) === sha256(raw))
    throw new Error(`Returned sidecar is unchanged: ${file}`)
  const oldData = matter(old).data ?? {}
  const oldTarget = getManifestTarget(inputManifest, file)
  if (
    isProtectedPath(file, config) ||
    oldData.translationStatus !== 'machine' ||
    !MACHINE.has(oldData.translationSource) ||
    oldTarget?.status !== 'machine' ||
    oldTarget.targetSha256 !== sha256(old)
  )
    throw new Error(`Refusing unsafe existing target: ${file}`)
}
export async function validateReturnedPublishArtifacts({ stage, outputRoot }) {
  await noLinks(outputRoot)
  const list = await files(outputRoot)
  for (const file of list) {
    if (!safe(file) || !artifact(file)) {
      const before = stage.hashes[file]
      if (before && before !== hash(await regularFile(outputRoot, file)))
        throw new Error('protected input changed: ' + file)
      throw new Error(`Unexpected publish artifact: ${file}`)
    }
  }
  const config = await json(
    path.join(stage.path, '.translation/config.json'),
    {},
  )
  const inputManifest = await json(
    path.join(stage.path, '.translation/manifest.json'),
    { families: {} },
  )
  const inputPages = await json(
    path.join(stage.path, '.translation/pages.json'),
    { pages: {} },
  )
  const manifest = await json(
    path.join(outputRoot, '.translation/manifest.json'),
  )
  const pages = await json(path.join(outputRoot, '.translation/pages.json'))
  assertProtected(inputManifest, manifest ?? {})
  assertProtected(inputPages, pages ?? {})
  if (!manifest || !pages)
    throw new Error('Returned translation metadata is incomplete')
  for (const file of list.filter(sidecar))
    await checkSidecar(stage, outputRoot, file, config, inputManifest, manifest)
  return { files: list, hashes: await hashes(outputRoot, list) }
}
export function createTrustedVmPublishScript() {
  const runner = VM_RUNNER_ROOT
  return `set -euo pipefail
runner="${runner}"
workdir="$(mktemp -d /tmp/erniesg-localization-XXXXXX)"; trap 'rm -rf "$workdir"' EXIT
mkdir -p "$workdir/input" "$workdir/output"; tar -xzf - -C "$workdir/input"; cd "$workdir/input"
node "$runner/publish-output.mjs" snapshot --root "$workdir/input" --snapshot "$workdir/snapshot.json" >&2
export TRANSLATION_PROVIDER=codex-cli CODEX_TRANSLATION_SEARCH=0 CODEX_TRANSLATION_REVIEW_CONCURRENCY=1 CODEX_TRANSLATION_REVISION_CONCURRENCY=1
node "$runner/sync.mjs" --write >&2
node "$runner/check-quality.mjs" --refresh-review >&2
node "$runner/revise.mjs" --write >&2
node "$runner/check-quality.mjs" --refresh-review >&2
node "$runner/revise.mjs" --write >&2
node "$runner/check-quality.mjs" --strict-publish >&2
node "$runner/pages.mjs" extract --dist dist --catalog .translation/pages.json >&2
pids=(); for locale in zh ja ko; do cp .translation/pages.json ".translation/pages.$locale.json"; (node "$runner/pages.mjs" generate --dist dist --catalog ".translation/pages.$locale.json" --locale "$locale" --batch-limit 100000 >&2) & pids+=("$!"); done
for pid in "\${pids[@]}"; do wait "$pid"; done
node "$runner/publish-merge-pages.mjs" --base .translation/pages.json --locale-catalogs .translation/pages.zh.json,.translation/pages.ja.json,.translation/pages.ko.json >&2
node "$runner/pages.mjs" check --dist dist --catalog .translation/pages.json >&2
node "$runner/publish-output.mjs" export --root "$workdir/input" --snapshot "$workdir/snapshot.json" --output "$workdir/output" >&2
tar -czf - -C "$workdir/output" .`
}
export function trustedVmSshInvocation() {
  const code = Buffer.from(createTrustedVmPublishScript()).toString('base64')
  return [TRUSTED_VM_ALIAS, `bash -c "$(printf %s ${code} | base64 --decode)"`]
}
function run(command, args, options) {
  const process = spawn(command, args, options)
  const done = new Promise((resolve, reject) => {
    process.on('error', reject)
    process.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`)),
    )
  })
  return { process, done }
}
export async function runTrustedVmPublish({
  stage,
  vmAlias = TRUSTED_VM_ALIAS,
  archivePath,
}) {
  if (vmAlias !== TRUSTED_VM_ALIAS)
    throw new Error(
      `Translation publishing requires trusted VM alias ${TRUSTED_VM_ALIAS}.`,
    )
  await assertTree(stage.path, stage.hashes, 'Publish stage')
  const list = `${archivePath}.files`
  await fs.writeFile(list, `${stage.files.join('\n')}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  const tar = run(
    'tar',
    ['-czf', '-', '-C', stage.path, '--files-from', list],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const ssh = run('ssh', trustedVmSshInvocation(), {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
  try {
    await Promise.all([
      pipeline(tar.process.stdout, ssh.process.stdin),
      pipeline(ssh.process.stdout, output),
      tar.done,
      ssh.done,
    ])
  } finally {
    await fs.rm(list, { force: true })
  }
}
async function preflightTargets(repoRoot, paths, fileOps = fs) {
  for (const file of paths) {
    if (!safe(file)) throw new Error(`Unsafe target path: ${file}`)
    const target = path.join(repoRoot, file)
    const stat = await fileOps
      .lstat(target)
      .catch((error) =>
        error.code === 'ENOENT' ? null : Promise.reject(error),
      )
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error(`Target must be a regular file: ${file}`)
    for (
      let parent = path.dirname(target);
      parent.startsWith(repoRoot);
      parent = path.dirname(parent)
    ) {
      const parentStat = await fileOps
        .lstat(parent)
        .catch((error) =>
          error.code === 'ENOENT' ? null : Promise.reject(error),
        )
      if (parentStat?.isSymbolicLink())
        throw new Error(`Target parent must not be a symbolic link: ${file}`)
      if (parent === repoRoot) break
    }
  }
}
export async function applyValidatedPublishArtifacts({
  stage,
  outputRoot,
  repoRoot = process.cwd(),
  validatedResult,
  fileOps = fs,
} = {}) {
  const result =
    validatedResult ??
    (await validateReturnedPublishArtifacts({ stage, outputRoot }))
  const expected = { ...stage.hashes }
  for (const file of result.files)
    if (!(file in expected)) expected[file] = null
  const output = new Map()
  for (const file of result.files) {
    const bytes = await regularFile(outputRoot, file)
    if (hash(bytes) !== result.hashes[file])
      throw new Error(`Returned artifact changed while preparing: ${file}`)
    output.set(file, bytes)
  }
  await assertKnown(repoRoot, expected, 'Checkout inputs')
  await preflightTargets(repoRoot, [...output.keys()], fileOps)
  const prepared = []
  const committed = []
  try {
    for (const [file, bytes] of output) {
      const target = path.join(repoRoot, file)
      const before = await fileOps
        .readFile(target)
        .catch((error) =>
          error.code === 'ENOENT' ? null : Promise.reject(error),
        )
      if (before && hash(before) === hash(bytes)) continue
      await fileOps.mkdir(path.dirname(target), { recursive: true })
      const temp = `${target}.translation-publish-${crypto.randomUUID()}`
      await fileOps.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      prepared.push({ temp, target, before })
    }
    await assertKnown(repoRoot, expected, 'Checkout inputs')
    for (const entry of prepared) {
      await fileOps.rename(entry.temp, entry.target)
      committed.push(entry)
    }
  } catch (error) {
    for (const entry of committed.reverse())
      entry.before === null
        ? await fileOps.rm(entry.target, { force: true })
        : await fileOps.writeFile(entry.target, entry.before)
    await Promise.all(
      prepared.map(({ temp }) => fileOps.rm(temp, { force: true })),
    )
    throw error
  }
  return result.files
}
export async function acquirePublishLock({
  repoRoot = process.cwd(),
  lockPath = path.join(
    repoRoot,
    'generated',
    'tmp',
    '.translation-publisher.lock',
  ),
} = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  await fs.mkdir(lockPath).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error('Translation publish already running locally.')
    throw error
  })
  let released = false
  return async () => {
    if (!released) {
      released = true
      await fs.rm(lockPath, { recursive: true, force: true })
    }
  }
}
async function archiveNames(archivePath, verbose = false) {
  return new Promise((resolve, reject) => {
    const task = spawn('tar', [verbose ? '-tvzf' : '-tzf', archivePath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let text = ''
    task.stdout.on('data', (chunk) => {
      text += chunk
    })
    task.on('close', (code) =>
      code === 0
        ? resolve(text.split('\n').filter(Boolean))
        : reject(new Error('Returned archive is invalid')),
    )
  })
}
export async function runPublish({
  repoRoot = process.cwd(),
  runId,
  vmAlias = TRUSTED_VM_ALIAS,
} = {}) {
  const release = await acquirePublishLock({ repoRoot })
  try {
    const stage = await createPublishStage({ repoRoot, runId })
    const archivePath = `${stage.path}.returned.tar.gz`
    await runTrustedVmPublish({ stage, vmAlias, archivePath })
    const outputRoot = `${stage.path}.returned`
    await fs.mkdir(outputRoot)
    const rawNames = await archiveNames(archivePath)
    const rawTypes = await archiveNames(archivePath, true)
    if (rawNames.length !== rawTypes.length)
      throw new Error('Returned archive contains an unsafe entry')
    const entries = rawNames
      .map((name, index) => ({
        name: relative(name),
        type: rawTypes[index]?.[0],
      }))
      .filter(({ name }) => name !== '.')
    const names = entries.map(({ name }) => name)
    const types = entries.map(({ type }) => type)
    if (
      names.some((file) => !safe(file)) ||
      types.some((type) => type !== '-' && type !== 'd')
    )
      throw new Error('Returned archive contains an unsafe entry')
    await run('tar', ['-xzf', archivePath, '-C', outputRoot], {
      stdio: 'inherit',
    }).done
    const validatedResult = await validateReturnedPublishArtifacts({
      stage,
      outputRoot,
    })
    return {
      stage,
      outputRoot,
      artifacts: validatedResult.files,
      validatedResult,
      release,
    }
  } catch (error) {
    await release()
    throw error
  }
}
