import { parseArgs } from 'node:util'
import {
  applyValidatedPublishArtifacts,
  runPublish,
  TRUSTED_VM_ALIAS,
} from './publish.mjs'

export function parsePublishArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'run-id': { type: 'string' },
      vm: { type: 'string' },
    },
  })
  const vmAlias = values.vm ?? TRUSTED_VM_ALIAS
  if (vmAlias !== TRUSTED_VM_ALIAS)
    throw new Error(
      `Translation publishing requires trusted VM alias ${TRUSTED_VM_ALIAS}.`,
    )
  return { runId: values['run-id'], vmAlias }
}

async function main() {
  const { runId, vmAlias } = parsePublishArgs()
  const result = await runPublish({ runId, vmAlias })
  const artifacts = await applyValidatedPublishArtifacts(result)
  console.log(
    `Applied ${artifacts.length} validated translation artifacts from ${result.outputRoot}`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
