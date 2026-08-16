import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import type { PdfReconstruction } from '../src/research/import-types'
import type {
  ModelConsultationClient,
  ModelConsultationGateOptions,
  ModelFallbackReceipt,
} from '../src/research/model-fallback'

const require = createRequire(import.meta.url)
const { validModelConsultationEvidence } =
  require('./model-consultation-evidence-receipt.cjs') as {
    validModelConsultationEvidence: (value: unknown) => boolean
  }

const FIXTURES = [
  'adjudication-required.pdf',
  'visual-adjudication-required.pdf',
] as const
const MODEL_IDENTITY = Object.freeze({
  providerId: 'recorded-stub',
  modelId: 'candidate-picker',
  modelVersion: '1.0.0',
  modelDigest: 'b'.repeat(64),
})

type FixtureName = (typeof FIXTURES)[number]
type EvidenceRecord = {
  documentIdSha256: string
  decisionClass: string
  decisionCount: number
  consultationCount: number
  consultationRate: number
  providerCallCount: number
  retired: boolean
}

function invariant(value: unknown): asserts value {
  if (!value) throw new Error('MODEL_CONSULTATION_EVIDENCE_INVARIANT')
}

function hashDocumentId(documentId: string) {
  return createHash('sha256').update(documentId).digest('hex')
}

function modelClient(
  providerCalls: Map<string, number>,
): ModelConsultationClient {
  return {
    identity: MODEL_IDENTITY,
    consult(request) {
      const candidateId = request.candidates[0]?.id
      invariant(candidateId)
      providerCalls.set(
        request.decisionClass,
        (providerCalls.get(request.decisionClass) ?? 0) + 1,
      )
      return { candidateId }
    },
  }
}

function aggregateReceipt(
  receipt: ModelFallbackReceipt,
  providerCalls: Map<string, number>,
  retired: boolean,
): EvidenceRecord[] {
  return Object.entries(receipt.metrics.byDecisionClass).map(
    ([decisionClass, metric]) => ({
      documentIdSha256: hashDocumentId(receipt.documentId),
      decisionClass,
      decisionCount: metric.decisionCount,
      consultationCount: metric.consultationCount,
      consultationRate: metric.consultationRate,
      providerCallCount: providerCalls.get(decisionClass) ?? 0,
      retired,
    }),
  )
}

async function main() {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, watch: null },
  })
  try {
    const [pdfModule, epubModule, fallbackModule, pipelineModule] =
      (await Promise.all([
        vite.ssrLoadModule('/src/research/pdf.ts'),
        vite.ssrLoadModule('/src/research/epub.ts'),
        vite.ssrLoadModule('/src/research/model-fallback.ts'),
        vite.ssrLoadModule('/src/research/model-fallback-pipeline.ts'),
      ])) as unknown as [
        typeof import('../src/research/pdf'),
        typeof import('../src/research/epub'),
        typeof import('../src/research/model-fallback'),
        typeof import('../src/research/model-fallback-pipeline'),
      ]

    const fixtureBytes = new Map<FixtureName, Uint8Array<ArrayBuffer>>(
      await Promise.all(
        FIXTURES.map(
          async (name): Promise<[FixtureName, Uint8Array<ArrayBuffer>]> => [
            name,
            Uint8Array.from(
              await readFile(
                new URL(`../tests/fixtures/pdf/${name}`, import.meta.url),
              ),
            ),
          ],
        ),
      ),
    )
    const reconstruct = (
      name: FixtureName,
      modelFallback?: ModelConsultationGateOptions,
    ) => {
      const bytes = fixtureBytes.get(name)
      invariant(bytes)
      return pdfModule.reconstructPdf(
        new File([bytes], name, {
          type: 'application/pdf',
          lastModified: 0,
        }),
        undefined,
        modelFallback === undefined ? {} : { modelFallback },
      )
    }
    const reopenReceipt = async (
      reconstruction: PdfReconstruction,
    ): Promise<ModelFallbackReceipt> => {
      const artifact = await epubModule.buildReadableEpub(
        reconstruction.paper,
        reconstruction,
      )
      const inspected = epubModule.inspectEpub(artifact.bytes, undefined, {
        canonicalPaper: reconstruction.paper,
        sourceCanonicalPaper: reconstruction.paper,
        sourcePdfSha256: reconstruction.source.sha256,
      })
      const serialized = new TextDecoder().decode(
        inspected.files['EPUB/export.json'],
      )
      const manifest = JSON.parse(serialized) as {
        modelConsultations?: unknown
      }
      const receipt = manifest.modelConsultations
      invariant(fallbackModule.validateModelConsultationReceipt(receipt))
      invariant(receipt.documentId === reconstruction.paper.id)
      invariant(receipt.sourceSha256 === reconstruction.source.sha256)
      invariant(
        JSON.stringify(receipt) ===
          JSON.stringify(inspected.manifest.modelConsultations),
      )
      invariant(
        JSON.stringify(receipt) ===
          JSON.stringify(reconstruction.modelConsultations),
      )
      return receipt
    }

    const records = []
    for (const name of FIXTURES) {
      const providerCalls = new Map()
      const reconstruction = await reconstruct(name, {
        enabled: true,
        ownerOptIn: true,
        distillation: new fallbackModule.DistillationLedger(),
        model: modelClient(providerCalls),
      })
      const receipt = await reopenReceipt(reconstruction)
      records.push(...aggregateReceipt(receipt, providerCalls, false))
    }

    const visualFixture = FIXTURES[1]
    const visualBase = await reconstruct(visualFixture)
    const captionClass =
      fallbackModule.MODEL_FALLBACK_DECISION_CLASSES.captionAssociation
    const captionPoints = pipelineModule
      .modelDecisionPointsForPdf(visualBase)
      .filter(({ decisionClass }) => decisionClass === captionClass)
    invariant(captionPoints.length === 1)
    const distillation = new fallbackModule.DistillationLedger()
    distillation.registerFixture(captionPoints[0])
    distillation.retireClass(
      captionClass,
      pipelineModule.resolveCaptionAssociationByUniqueBoundedDistance,
      pipelineModule.PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
    )
    const retiredProviderCalls = new Map()
    const retiredReconstruction = await reconstruct(visualFixture, {
      enabled: true,
      ownerOptIn: true,
      distillation,
      model: modelClient(retiredProviderCalls),
    })
    const retiredReceipt = await reopenReceipt(retiredReconstruction)
    const retiredEntry = distillation.entry(captionClass)
    invariant(retiredEntry.retired === true)
    invariant(retiredEntry.consultationCount === 0)
    invariant(retiredProviderCalls.size === 0)
    records.push(
      ...aggregateReceipt(retiredReceipt, retiredProviderCalls, true),
    )

    // The receipt validator checks records positionally, so this order is
    // load-bearing for a required gate. Order by code unit rather than by the
    // runner's ICU collation.
    const byCodeUnit = (left: string, right: string) =>
      left < right ? -1 : left > right ? 1 : 0
    records.sort(
      (left, right) =>
        byCodeUnit(left.documentIdSha256, right.documentIdSha256) ||
        byCodeUnit(left.decisionClass, right.decisionClass) ||
        Number(left.retired) - Number(right.retired),
    )
    const evidence = { records }
    invariant(validModelConsultationEvidence(evidence))
    return evidence
  } finally {
    await vite.close()
  }
}

main()
  .then((evidence) => {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  })
  .catch(() => {
    process.stderr.write('model-consultation evidence failed\n')
    process.exitCode = 1
  })
