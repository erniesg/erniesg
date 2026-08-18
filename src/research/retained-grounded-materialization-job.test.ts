import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GROUNDED_MATERIALIZATION_RETAINED_PACKETS } from './grounded-materialization-pilot'
import { loadRetainedGroundedMaterializationPacket } from './retained-grounded-materialization-job'

const issue198Root = '/private/tmp/erniesg-issue198-pilot-b3fcfc7.phEQk1'
const issue200Root = '/private/tmp/erniesg-issue200-mineru.DUt57C'
const retainedPackets = [
  {
    caseId: 'prose-hierarchy' as const,
    sourcePdfPath: `${issue198Root}/mineru-run-XhRh7f/sealed-execution/source.pdf`,
    artifactRoot: `${issue198Root}/mineru-run-XhRh7f`,
    packetDirectory: `${issue198Root}/packet/born-digital`,
  },
  {
    caseId: 'semantic-table-spans' as const,
    sourcePdfPath: `${issue198Root}/mineru-run-YMK65C/sealed-execution/source.pdf`,
    artifactRoot: `${issue198Root}/mineru-run-YMK65C`,
    packetDirectory: `${issue198Root}/packet/table-formula`,
  },
  {
    caseId: 'formula-text' as const,
    sourcePdfPath: `${issue200Root}/mineru-run-CRAwer/sealed-execution/source.pdf`,
    artifactRoot: `${issue200Root}/mineru-run-CRAwer`,
    packetDirectory: `${issue200Root}/assembled/distinct-table-formula`,
  },
  {
    caseId: 'source-backed-figure' as const,
    sourcePdfPath: `${issue198Root}/mineru-run-xrdafR/sealed-execution/source.pdf`,
    artifactRoot: `${issue198Root}/mineru-run-xrdafR`,
    packetDirectory: `${issue198Root}/packet/figure-heavy`,
  },
  {
    caseId: 'link-destinations' as const,
    sourcePdfPath: `${issue200Root}/mineru-run-ZKm3Qp/sealed-execution/source.pdf`,
    artifactRoot: `${issue200Root}/mineru-run-ZKm3Qp`,
    packetDirectory: `${issue200Root}/assembled/link-destinations`,
  },
]

describe('retained grounded materialization production job', () => {
  it.skipIf(!existsSync(issue198Root) || !existsSync(issue200Root))(
    'loads and replays all five exact retained packets without provider execution',
    async () => {
      for (const retainedPacket of retainedPackets) {
        const packet =
          await loadRetainedGroundedMaterializationPacket(retainedPacket)
        const expected =
          GROUNDED_MATERIALIZATION_RETAINED_PACKETS[retainedPacket.caseId]
        expect(packet.receipt).toMatchObject({
          caseId: retainedPacket.caseId,
          sourcePdfSha256: expected.source.sha256,
          sourceGraphSha256: expected.graph.sha256,
          retainedContractSha256: expected.contract.sha256,
          manifestSha256: expected.manifestSha256,
          producerReceiptSha256: expected.producerReceiptSha256,
          artifactSetSha256: expected.artifactSetSha256,
        })
        expect(packet.sourceExecution.expectedObservationPayloads).toHaveLength(
          19,
        )
      }
    },
    20_000,
  )
})
