import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * The trusted publisher's own manifest check, run as it runs in the publisher
 * workflow: `scripts/publish-agent-evidence` is loaded as a module and its
 * `_validate_manifest` reads the raw manifest bytes. Nothing is re-implemented.
 * Returns `{ accepted, reason }`; `reason` is the publisher's refusal message.
 */
const PUBLISHER_SCRIPT = resolve(import.meta.dirname, '../scripts/publish-agent-evidence')

const HARNESS = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("publish_agent_evidence", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
request = json.loads(sys.stdin.read())
try:
    module._validate_manifest(request["raw"].encode("utf-8"), request["identity"])
except ValueError as error:
    print(json.dumps({"accepted": False, "reason": str(error)}))
else:
    print(json.dumps({"accepted": True, "reason": ""}))
`

export function publisherVerdict(manifest, { repository, branch, head }) {
  const run = spawnSync('python3', ['-I', '-B', '-c', HARNESS, PUBLISHER_SCRIPT], {
    encoding: 'utf8',
    input: JSON.stringify({
      raw: typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest)}\n`,
      identity: { repository, branch, head },
    }),
    env: { PATH: process.env.PATH },
  })
  if (run.status !== 0) {
    throw new Error(`publisher harness crashed (${run.status}): ${run.stderr}`)
  }
  return JSON.parse(run.stdout)
}
