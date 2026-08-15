import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const upstream = {
  head: 'be285c8e49bcdbba2364a83e0e02dae4f32b000b',
  publisherSha256:
    'a4b84823ed1aa1af3c8b7c0e8a032108bf1fa1e0c031d15e59052c6d6e6c9935',
  producerSha256:
    '0f28fc6041180f3c0989384b42de8305f3b146f161fada67dc21dfed53881fca',
}

const files = {
  sourceWorkflow: '.github/workflows/agent-evidence.yml',
  publisherWorkflow: '.github/workflows/agent-evidence-publisher.yml',
  publisherProducer: 'scripts/publish-agent-evidence',
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readYaml(file) {
  return parse(await readFile(file, 'utf8'))
}

function namedStep(workflow, job, name) {
  const step = workflow.jobs[job].steps.find(
    (candidate) => candidate.name === name,
  )
  if (!step) throw new Error(`missing ${job} step: ${name}`)
  return step
}

function schemaContract(script, location) {
  const keys = script.match(
    /exactKeys\(\s*manifest,\s*\[([\s\S]*?)\],\s*\[([\s\S]*?)\],\s*["']manifest["'],?\s*\);/,
  )
  if (!keys)
    throw new Error(`${location} does not expose the manifest key contract`)

  const quotedKeys = (value) =>
    [...value.matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1])
  const version = script.match(/manifest\.schema_version !== ["']([^"']+)["']/)
  if (!version) throw new Error(`${location} does not enforce a schema version`)

  return {
    required: quotedKeys(keys[1]),
    optional: quotedKeys(keys[2]),
    version: version[1],
  }
}

function loadProducerContract() {
  const output = execFileSync(
    'python3',
    [
      '-c',
      `
import json
import runpy

scope = runpy.run_path("scripts/publish-agent-evidence", run_name="publisher_contract")
identity = {"run_id": 123, "run_attempt": 4, "head": "a" * 40}
artifact_name = "agent-evidence-manifest-123-attempt-4-validated-by-567-attempt-2"
artifact = {
    "id": 9,
    "name": artifact_name,
    "expired": False,
    "size_in_bytes": 1,
    "digest": "sha256:" + "c" * 64,
    "workflow_run": {"id": 567, "head_sha": "b" * 40},
}
selected = scope["select_manifest_artifact"](
    [{"artifacts": [artifact]}],
    identity,
    validation_run_id=567,
    validation_run_attempt=2,
    validation_run_head="b" * 40,
)
print(json.dumps({
    "workflow_name": scope["CANONICAL_WORKFLOW_NAME"],
    "workflow_path": scope["CANONICAL_WORKFLOW_PATH"],
    "required": sorted(scope["TOP_LEVEL_REQUIRED"]),
    "optional": sorted(scope["TOP_LEVEL_OPTIONAL"]),
    "selected_artifact_name": selected["name"],
}))
`,
    ],
    { encoding: 'utf8' },
  )
  return JSON.parse(output)
}

function renderArtifactName(template) {
  return template
    .replace('${{ github.event.workflow_run.id }}', '123')
    .replace('${{ github.event.workflow_run.run_attempt }}', '4')
    .replace('${{ github.run_id }}', '567')
    .replace('${{ github.run_attempt }}', '2')
}

describe('trusted agent-evidence publisher rollout', () => {
  it(`pins the reviewed publisher boundary from Rucksack ${upstream.head}`, async () => {
    const [publisher, producer] = await Promise.all([
      readFile(files.publisherWorkflow),
      readFile(files.publisherProducer),
    ])

    expect(sha256(publisher)).toBe(upstream.publisherSha256)
    expect(sha256(producer)).toBe(upstream.producerSha256)
  })

  it('keeps the retained source workflow connected to the trusted publisher', async () => {
    const [source, publisher] = await Promise.all([
      readYaml(files.sourceWorkflow),
      readYaml(files.publisherWorkflow),
    ])
    const producer = loadProducerContract()

    expect(source.name).toBe(producer.workflow_name)
    expect(producer.workflow_path).toBe(files.sourceWorkflow)
    expect(Object.hasOwn(source.on, 'pull_request')).toBe(true)
    expect(publisher.on.workflow_run).toEqual({
      workflows: [source.name],
      types: ['completed'],
    })
  })

  it('keeps schema and validation artifacts consumable by the publisher producer', async () => {
    const [source, publisher] = await Promise.all([
      readYaml(files.sourceWorkflow),
      readYaml(files.publisherWorkflow),
    ])
    const producer = loadProducerContract()
    const sourceSchema = schemaContract(
      namedStep(source, 'evidence', 'Run and validate agent evidence').run,
      'source workflow validator',
    )
    const publisherSchema = schemaContract(
      namedStep(publisher, 'validate', 'Validate revalidation manifest').run,
      'publisher workflow validator',
    )
    const producerKeys = [...producer.required, ...producer.optional].sort()

    expect(
      [...new Set([...sourceSchema.required, ...sourceSchema.optional])].sort(),
    ).toEqual(producerKeys)
    expect(
      [
        ...new Set([...publisherSchema.required, ...publisherSchema.optional]),
      ].sort(),
    ).toEqual(producerKeys)
    expect(sourceSchema.version).toBe('1')
    expect(publisherSchema.version).toBe('1')

    const upload = namedStep(
      publisher,
      'validate',
      'Upload trusted validation manifest',
    )
    expect(upload.uses).toBe('actions/upload-artifact@v4')
    expect(renderArtifactName(upload.with.name)).toBe(
      producer.selected_artifact_name,
    )
    expect(upload.with.path).toBe(
      '${{ runner.temp }}/rucksack-agent-evidence-manifest.json',
    )
  })
})
