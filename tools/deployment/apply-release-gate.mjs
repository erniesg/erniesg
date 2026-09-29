import path from 'node:path'
import { applyReleaseGate } from './release-gate.mjs'

if (process.env.PUBLIC_RESEARCH_RELEASE !== 'production') {
  throw new Error('The production release gate requires PUBLIC_RESEARCH_RELEASE=production')
}

const problems = await applyReleaseGate(path.resolve('dist'))
if (problems.length > 0) {
  throw new Error(
    `The post-gate artifact is not deployable:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  )
}
