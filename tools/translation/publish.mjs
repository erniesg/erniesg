import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import fg from 'fast-glob'
import matter from 'gray-matter'
import {
  assertCanWriteExistingTarget,
  getManifestTarget,
  isProtectedPath,
  sha256,
} from './content.mjs'

export const TRUSTED_VM_ALIAS = 'erniesg-ai-vm'
export const PUBLISH_LOCALES = ['zh', 'ja', 'ko']

const INPUT_PATTERNS = [
  'package.json',
  '.translation/config.json',
  '.translation/manifest.json',
  '.translation/pages.json',
  '.translation/reports/**',
  'docs/translation/**',
  'tools/translation/**',
  'src/content/blog/**',
  'public/data/**',
  'dist/**/*.html',
]

function safeRunId(runId) {
  if (!/^[a-zA-Z0-9-]+$/u.test(runId))
    throw new Error(
      'Publish run id must contain only letters, numbers, and hyphens.',
    )
  return runId
}

function relativePath(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join('/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative))
    throw new Error(`Unsafe publish path: ${filePath}`)
  return relative
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function listRegularFiles(root, patterns = ['**/*']) {
  const files = await fg(patterns, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
  })
  const result = []
  for (const relative of files.sort()) {
    const absolute = path.join(root, relative)
    const stat = await fs.lstat(absolute)
    if (!stat.isFile()) continue
    result.push(relative.split(path.sep).join('/'))
  }
  return result
}

async function copyFile(root, stagePath, relative) {
  const source = path.join(root, relative)
  const target = path.join(stagePath, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
}

/**
 * Creates a deterministic, credential-free input bundle for the trusted VM.
 * The returned stage remains local; callers may archive it but must never copy
 * publisher credentials or arbitrary repository files into it.
 */
export async function createPublishStage({
  repoRoot = process.cwd(),
  runId = crypto.randomUUID(),
  stageRoot = path.join(repoRoot, 'generated', 'tmp'),
} = {}) {
  const stagePath = path.join(
    stageRoot,
    `erniesg-localization-${safeRunId(runId)}`,
  )
  await fs.access(stagePath).then(
    () => {
      throw new Error(`Publish stage already exists: ${stagePath}`)
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
  const files = await listRegularFiles(repoRoot, INPUT_PATTERNS)
  await fs.mkdir(stagePath, { recursive: true })
  for (const file of files) await copyFile(repoRoot, stagePath, file)
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        digest(await fs.readFile(path.join(stagePath, file))),
      ]),
    ),
  )
  return { path: stagePath, files, hashes }
}

function isGeneratedArtifact(relative) {
  return (
    relative === '.translation/manifest.json' ||
    relative === '.translation/pages.json' ||
    /^\.translation\/reports\/.+\.json$/u.test(relative) ||
    /^src\/content\/blog\/.+\/(?:zh|ja|ko)\.mdx$/u.test(relative)
  )
}

async function readJsonIfPresent(filePath) {
  return fs
    .readFile(filePath, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
}

function nativePageEntries(catalog) {
  const entries = []
  for (const [route, page] of Object.entries(catalog?.pages ?? {})) {
    for (const [locale, entry] of Object.entries(page.locales ?? {})) {
      if (['native', 'edited', 'final'].includes(entry?.status))
        entries.push({ route, locale, entry })
    }
  }
  for (const [locale, translations] of Object.entries(
    catalog?.translations ?? {},
  )) {
    for (const [key, entry] of Object.entries(translations ?? {})) {
      if (['native', 'edited', 'final'].includes(entry?.status))
        entries.push({ route: `translation:${key}`, locale, entry })
    }
  }
  return entries
}

async function assertNativePageEntriesUnchanged(stagePath, outputRoot) {
  const input = await readJsonIfPresent(
    path.join(stagePath, '.translation/pages.json'),
  )
  const output = await readJsonIfPresent(
    path.join(outputRoot, '.translation/pages.json'),
  )
  if (!output) return
  for (const { route, locale, entry } of nativePageEntries(input)) {
    const returned = route.startsWith('translation:')
      ? output.translations?.[locale]?.[route.slice('translation:'.length)]
      : output.pages?.[route]?.locales?.[locale]
    if (JSON.stringify(returned) !== JSON.stringify(entry)) {
      throw new Error(`native page locale changed: ${route} ${locale}`)
    }
  }
}

async function assertBlogSidecarWritable({
  stage,
  outputRoot,
  relative,
  config,
  manifest,
}) {
  const currentPath = path.join(stage.path, relative)
  const nextPath = path.join(outputRoot, relative)
  const current = await fs
    .readFile(currentPath, 'utf8')
    .catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
  const next = await fs.readFile(nextPath, 'utf8')
  if (current === null) {
    if (isProtectedPath(relative, config))
      throw new Error(`Refusing to return protected translation: ${relative}`)
    const frontmatter = matter(next).data ?? {}
    if (
      frontmatter.translationStatus !== 'machine' ||
      typeof frontmatter.translationSource !== 'string'
    ) {
      throw new Error(
        `New translation sidecar is not a machine translation: ${relative}`,
      )
    }
    return
  }
  const parsed = matter(current)
  assertCanWriteExistingTarget({
    filePath: relative,
    config,
    frontmatter: parsed.data ?? {},
    manifestTarget: getManifestTarget(manifest, relative),
    currentText: current,
  })
}

/**
 * Validates the VM result without applying it. Only machine sidecars and
 * translation metadata may cross the publisher boundary.
 */
export async function validateReturnedPublishArtifacts({ stage, outputRoot }) {
  const files = await listRegularFiles(outputRoot)
  const config =
    (await readJsonIfPresent(
      path.join(stage.path, '.translation/config.json'),
    )) ?? {}
  const manifest = (await readJsonIfPresent(
    path.join(stage.path, '.translation/manifest.json'),
  )) ?? { families: {} }
  for (const relative of files) {
    if (!isGeneratedArtifact(relative)) {
      const before = stage.hashes[relative]
      const after = digest(await fs.readFile(path.join(outputRoot, relative)))
      if (before && before !== after)
        throw new Error(`protected input changed: ${relative}`)
      throw new Error(`Unexpected publish artifact: ${relative}`)
    }
    if (/^src\/content\/blog\//u.test(relative)) {
      if (
        stage.hashes[relative] ===
        digest(await fs.readFile(path.join(outputRoot, relative)))
      )
        continue
      await assertBlogSidecarWritable({
        stage,
        outputRoot,
        relative,
        config,
        manifest,
      })
    }
  }
  await assertNativePageEntriesUnchanged(stage.path, outputRoot)
  return files
}

export function createTrustedVmPublishScript() {
  return `set -euo pipefail
workdir="$(mktemp -d /tmp/erniesg-localization-XXXXXX)"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT
mkdir -p "$workdir/input" "$workdir/output"
tar -xzf - -C "$workdir/input"
cd "$workdir/input"
ln -s /home/ubuntu/code/erniesg/erniesg/node_modules node_modules
export TRANSLATION_PROVIDER=codex-cli
export CODEX_TRANSLATION_SEARCH=0
export CODEX_TRANSLATION_REVIEW_CONCURRENCY=1
export CODEX_TRANSLATION_REVISION_CONCURRENCY=1
node tools/translation/sync.mjs --write >&2
node tools/translation/check-quality.mjs --refresh-review >&2
node tools/translation/revise.mjs --write >&2
node tools/translation/check-quality.mjs --refresh-review >&2
node tools/translation/revise.mjs --write >&2
node tools/translation/check-quality.mjs --strict-publish >&2
node tools/translation/pages.mjs extract --dist dist --catalog .translation/pages.json >&2
pids=()
for locale in zh ja ko; do
  cp .translation/pages.json ".translation/pages.$locale.json"
  (node tools/translation/pages.mjs generate --dist dist --catalog ".translation/pages.$locale.json" --locale "$locale" --batch-limit 100000 >&2) &
  pids+=("$!")
done
for pid in "\${pids[@]}"; do wait "$pid"; done
node --input-type=module <<'NODE'
import fs from 'node:fs/promises'
const catalog = JSON.parse(await fs.readFile('.translation/pages.json', 'utf8'))
for (const locale of ['zh', 'ja', 'ko']) {
  const generated = JSON.parse(await fs.readFile(\`.translation/pages.\${locale}.json\`, 'utf8'))
  catalog.translations ??= {}
  catalog.translations[locale] = generated.translations?.[locale] ?? catalog.translations[locale] ?? {}
  for (const [route, page] of Object.entries(catalog.pages ?? {})) {
    const generatedPage = generated.pages?.[route]
    if (!generatedPage?.locales?.[locale]) continue
    page.locales ??= {}
    page.locales[locale] = generatedPage.locales[locale]
  }
}
await fs.writeFile('.translation/pages.json', \`\${JSON.stringify(catalog, null, 2)}\\n\`)
NODE
node tools/translation/pages.mjs check --dist dist --catalog .translation/pages.json >&2
mkdir -p "$workdir/output/.translation" "$workdir/output/src/content/blog"
cp .translation/manifest.json "$workdir/output/.translation/manifest.json"
cp .translation/pages.json "$workdir/output/.translation/pages.json"
if [ -d .translation/reports ]; then
  mkdir -p "$workdir/output/.translation/reports"
  find .translation/reports -type f -name '*.json' -exec cp --parents {} "$workdir/output" \\\;
fi
find src/content/blog -type f \\( -name zh.mdx -o -name ja.mdx -o -name ko.mdx \\) -exec cp --parents {} "$workdir/output" \\\;
tar -czf - -C "$workdir/output" .`
}

export function trustedVmSshInvocation() {
  const encodedScript = Buffer.from(createTrustedVmPublishScript()).toString(
    'base64',
  )
  return [
    TRUSTED_VM_ALIAS,
    `bash -c "$(printf %s ${encodedScript} | base64 --decode)"`,
  ]
}

function spawnChecked(command, args, options = {}) {
  const child = spawn(command, args, options)
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`)),
    )
  })
  return { child, completion }
}

/** Runs the provider pipeline exclusively through the named trusted VM alias. */
export async function runTrustedVmPublish({
  stage,
  vmAlias = TRUSTED_VM_ALIAS,
  archivePath,
}) {
  if (vmAlias !== TRUSTED_VM_ALIAS)
    throw new Error(
      `Translation publishing requires trusted VM alias ${TRUSTED_VM_ALIAS}.`,
    )
  if (!archivePath) throw new Error('A local output archive path is required.')
  await fs.mkdir(path.dirname(archivePath), { recursive: true })
  const tar = spawnChecked('tar', ['-czf', '-', '-C', stage.path, '.'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const ssh = spawnChecked('ssh', trustedVmSshInvocation(), {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const output = createWriteStream(archivePath, { flags: 'wx' })
  await Promise.all([
    pipeline(tar.child.stdout, ssh.child.stdin).catch(() => {}),
    pipeline(ssh.child.stdout, output),
    tar.completion,
    ssh.completion,
  ])
}

async function assertApplicationInputsStable({ stage, repoRoot, config }) {
  const configPath = path.join(repoRoot, '.translation/config.json')
  if (
    digest(await fs.readFile(configPath)) !==
    stage.hashes['.translation/config.json']
  ) {
    throw new Error(
      'Publish inputs changed after VM staging: .translation/config.json',
    )
  }
  for (const relative of stage.files.filter((file) =>
    /^src\/content\/blog\/.+\.mdx$/u.test(file),
  )) {
    const staged = await fs.readFile(path.join(stage.path, relative), 'utf8')
    const current = await fs
      .readFile(path.join(repoRoot, relative), 'utf8')
      .catch((error) =>
        error.code === 'ENOENT' ? null : Promise.reject(error),
      )
    const frontmatter = matter(staged).data ?? {}
    const mustStayUnchanged =
      relative.endsWith('/index.mdx') ||
      isProtectedPath(relative, config) ||
      frontmatter.translationStatus !== 'machine'
    if (mustStayUnchanged && current !== staged) {
      throw new Error(`Publish inputs changed after VM staging: ${relative}`)
    }
  }
}

async function assertApplicationTargetWritable({
  repoRoot,
  relative,
  config,
  manifest,
}) {
  const targetPath = path.join(repoRoot, relative)
  const current = await fs
    .readFile(targetPath, 'utf8')
    .catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
  if (current === null) {
    if (isProtectedPath(relative, config))
      throw new Error(`Refusing to apply protected translation: ${relative}`)
    return
  }
  const parsed = matter(current)
  assertCanWriteExistingTarget({
    filePath: relative,
    config,
    frontmatter: parsed.data ?? {},
    manifestTarget: getManifestTarget(manifest, relative),
    currentText: current,
  })
}

/** Applies a validated VM result only after rechecking the caller's current inputs. */
export async function applyValidatedPublishArtifacts({
  stage,
  outputRoot,
  repoRoot = process.cwd(),
}) {
  const artifacts = await validateReturnedPublishArtifacts({
    stage,
    outputRoot,
  })
  const config =
    (await readJsonIfPresent(
      path.join(repoRoot, '.translation/config.json'),
    )) ?? {}
  const manifest = (await readJsonIfPresent(
    path.join(repoRoot, '.translation/manifest.json'),
  )) ?? { families: {} }
  await assertApplicationInputsStable({ stage, repoRoot, config })
  for (const relative of artifacts.filter((file) =>
    /^src\/content\/blog\//u.test(file),
  )) {
    const output = await fs.readFile(path.join(outputRoot, relative))
    if (stage.hashes[relative] === digest(output)) continue
    await assertApplicationTargetWritable({
      repoRoot,
      relative,
      config,
      manifest,
    })
  }
  for (const relative of artifacts) {
    const source = path.join(outputRoot, relative)
    const target = path.join(repoRoot, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.translation-publish-${crypto.randomUUID()}`
    await fs.copyFile(source, temporary)
    await fs.rename(temporary, target)
  }
  return artifacts
}

export async function runPublish({
  repoRoot = process.cwd(),
  runId,
  vmAlias = TRUSTED_VM_ALIAS,
} = {}) {
  const stage = await createPublishStage({ repoRoot, runId })
  const archivePath = path.join(stage.path, 'returned-artifacts.tar.gz')
  await runTrustedVmPublish({ stage, vmAlias, archivePath })
  const outputRoot = path.join(stage.path, 'returned')
  await fs.mkdir(outputRoot)
  const unpack = spawnChecked('tar', ['-xzf', archivePath, '-C', outputRoot], {
    stdio: 'inherit',
  })
  await unpack.completion
  const artifacts = await validateReturnedPublishArtifacts({
    stage,
    outputRoot,
  })
  return { stage, outputRoot, artifacts }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPublish()
    .then(({ outputRoot, artifacts }) => {
      console.log(
        `Validated ${artifacts.length} translation artifacts in ${outputRoot}`,
      )
    })
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
