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

async function mark(files, status) {
  const manifest = await loadManifest()
  for (const filePath of files) {
    await updateFrontmatter(filePath, {
      translationStatus: status,
      translationSource: 'human',
    })
    const file = await readMdxFile(filePath)
    const target = getManifestTarget(manifest, filePath)
    if (target) {
      target.status = status
      target.targetSha256 = sha256(file.raw)
      target.qualityStatus = status === 'final' ? 'human-final' : 'human-edited'
      target.reviewScore = status === 'final' ? 1 : target.reviewScore
      target.unresolvedResearch = status === 'final' ? [] : target.unresolvedResearch
      target.humanUpdatedAt = nowIso()
    }
  }
  await saveManifest(manifest)
}

async function main() {
  const args = parseArgs()
  if (args._.length === 0) throw new Error('Usage: npm run translate:mark-edited -- <file...>')
  await mark(args._, 'edited')
  console.log(`Marked ${args._.length} translation(s) edited.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
