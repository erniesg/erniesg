import { fileURLToPath } from 'node:url'
import { createPdfPipeline } from '../../tools/pdf-corpus-audit-lib.mjs'
import {
  createPdfCorpusReportValidator,
  installPdfExportSignalHandlers,
  processExportDocuments,
  runIsolatedPdfExportJob,
} from '../../tools/pdf-export.mjs'

const removeSignalHandlers = installPdfExportSignalHandlers()
const workerModule = fileURLToPath(
  new URL('./pdf-export-scratch-worker.mjs', import.meta.url),
)

process.once('message', async (message) => {
  try {
    const pipeline = await createPdfPipeline()
    const exportModules = await pipeline.loadExportModules()
    const policy = pipeline.policy
    const targetProfile = exportModules.getEpubProfileMetadata(
      exportModules.getTargetProfile('paperPro'),
    )
    await pipeline.close()
    await processExportDocuments({
      paths: [message.inputPath],
      corpusContract: null,
      policy,
      reportValidator: await createPdfCorpusReportValidator(),
      targetProfiles: [targetProfile],
      readableFallback: false,
      validator: { kind: 'skipped', reason: 'java-unavailable' },
      outputDirectory: message.outputDirectory,
      timeoutMs: 60_000,
      runWorker: (job, options) =>
        runIsolatedPdfExportJob(
          { ...job, observationPath: message.observationPath },
          { ...options, workerModule },
        ),
    })
    process.exitCode = 3
  } catch {
    process.exitCode = 4
  } finally {
    removeSignalHandlers()
  }
})
