import { fileURLToPath } from 'node:url'
import {
  getManifestTarget,
  loadManifest,
  nowIso,
  parseArgs,
  readMdxFile,
  saveManifest,
  sha256,
  updateFrontmatter,
} from './content.mjs'

async function finalize(files) {
  const manifest = await loadManifest()
  for (const filePath of files) {
    await updateFrontmatter(filePath, {
      translationStatus: 'final',
      translationSource: 'human',
    })
    const file = await readMdxFile(filePath)
    const target = getManifestTarget(manifest, filePath)
    if (target) {
      target.status = 'final'
      target.targetSha256 = sha256(file.raw)
      target.qualityStatus = 'human-final'
      target.reviewScore = 1
      target.unresolvedResearch = []
      target.humanFinalizedAt = nowIso()
    }
  }
  await saveManifest(manifest)
}

async function main() {
  const args = parseArgs()
  if (args._.length === 0) throw new Error('Usage: npm run translate:finalize -- <file...>')
  await finalize(args._)
  console.log(`Finalized ${args._.length} translation(s).`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
