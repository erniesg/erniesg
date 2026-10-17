import { rm } from 'node:fs/promises'
import path from 'node:path'

if (process.env.PUBLIC_RESEARCH_RELEASE !== 'production') {
  throw new Error(
    'The production release gate requires PUBLIC_RESEARCH_RELEASE=production',
  )
}

await rm(path.resolve('dist/research'), { recursive: true, force: true })

// This staged experiment must remain unavailable in production.
await rm(path.resolve('dist/study/experiments/pdf-to-epub'), {
  recursive: true,
  force: true,
})
