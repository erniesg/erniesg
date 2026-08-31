import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'
import { reconstructPdf } from './pdf'
import {
  PRIVATE_PDF_EPUB_FILE_NAME,
  PRIVATE_PDF_EPUB_STRUCT_ARTIFACT,
  PrivatePdfEpubBridgeError,
  convertPrivatePdfToEpub,
  safePrivatePdfEpubProgress,
  safePrivatePdfEpubError,
  verifyBundledPrivatePdfEpubStructArtifact,
  verifyPrivatePdfEpubStructArtifact,
} from './private-pdf-epub-bridge'

const encryptedPdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 0 >>
stream

endstream
endobj
5 0 obj
<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>
endobj
trailer
<< /Root 1 0 R /Encrypt 5 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] /Size 6 >>
%%EOF`

const activePdf = (action = '/JavaScript') => `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 0 >>
stream

endstream
endobj
5 0 obj
<< /S ${action} /JS (synthetic-action) >>
endobj
trailer
<< /Root 1 0 R /Size 6 >>
%%EOF`

function pdfFile(value: string, name = 'synthetic-input.pdf') {
  return new File([value], name, {
    type: 'application/pdf',
    lastModified: 0,
  })
}

function closedStructDocumentStub() {
  return {
    metadata: { baseDirection: 'ltr' },
    receipt: {
      conservation: {
        sourceNodeCount: 1,
        sourceRegionCount: 0,
        sourceAnnotationCount: 0,
        sourceAssetCount: 0,
        sourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceNodeCount: 1,
        accountedSourceRegionCount: 0,
        accountedSourceAnnotationCount: 0,
        accountedSourceAssetCount: 0,
        accountedSourceRelationshipCount: 0,
        accountedSourceDiagnosticCount: 0,
      },
    },
  }
}

async function expectSafeRejection(
  promise: Promise<unknown>,
  code: PrivatePdfEpubBridgeError['code'],
  forbidden: string,
) {
  const error = await promise.catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(PrivatePdfEpubBridgeError)
  expect(error).toMatchObject({ code })
  const safe = safePrivatePdfEpubError(error)
  expect(Object.keys(safe).sort()).toEqual(['code', 'message'])
  expect(JSON.stringify(safe)).not.toContain(forbidden)
  expect(safe.message).toMatch(/(?:not|nothing was) (?:saved|uploaded)/iu)
}

describe('owner-private PDF to Struct EPUB bridge', () => {
  it('pins the accepted clean Struct pack without a checkout path dependency', async () => {
    const [tarball, packageJson] = await Promise.all([
      readFile(
        new URL('../../vendor/erniesg-struct-0.0.0.tgz', import.meta.url),
      ),
      readFile(new URL('../../package.json', import.meta.url), 'utf8').then(
        JSON.parse,
      ),
    ])

    expect(createHash('sha256').update(tarball).digest('hex')).toBe(
      PRIVATE_PDF_EPUB_STRUCT_ARTIFACT.packedArtifactSha256,
    )
    expect(() =>
      verifyPrivatePdfEpubStructArtifact(new Uint8Array(tarball)),
    ).not.toThrow()
    expect(() =>
      verifyPrivatePdfEpubStructArtifact(new Uint8Array([1, 2, 3])),
    ).toThrow(expect.objectContaining({ code: 'STRUCT_ARTIFACT_MISMATCH' }))
    expect(packageJson.dependencies['@erniesg/struct']).toBe(
      'file:vendor/erniesg-struct-0.0.0.tgz',
    )
    expect(JSON.stringify(packageJson)).not.toContain('/home/')
    expect(() => verifyBundledPrivatePdfEpubStructArtifact()).not.toThrow()
  })

  it('maps progress to closed, content-free browser messages', () => {
    const marker = 'PRIVATE-PROGRESS-DETAIL-MUST-NOT-ESCAPE'
    const progress = safePrivatePdfEpubProgress({
      phase: 'extracting',
      completed: 1,
      total: 2,
      message: marker,
      checkpoint: marker,
    })

    expect(progress).toBe('Reading document structure locally…')
    expect(progress).not.toContain(marker)
  })

  it('rejects malformed, encrypted, and active-content inputs with content-free errors', async () => {
    const marker = 'PRIVATE-NAME-MUST-NOT-ESCAPE'
    await expectSafeRejection(
      convertPrivatePdfToEpub(pdfFile('%PDF-1.7\ntruncated', `${marker}.pdf`), {
        dependencies: {
          reconstruct: (file, onProgress, signal) =>
            reconstructPdf(file, onProgress, { signal }),
        },
      }),
      'MALFORMED_PDF',
      marker,
    )
    await expectSafeRejection(
      convertPrivatePdfToEpub(pdfFile(encryptedPdf, `${marker}.pdf`)),
      'ENCRYPTED_PDF',
      marker,
    )
    await expectSafeRejection(
      convertPrivatePdfToEpub(
        pdfFile(activePdf('/Java#53cript'), `${marker}.pdf`),
      ),
      'UNSAFE_PDF',
      marker,
    )
  })

  it('rejects an oversized upload before reading its bytes', async () => {
    let read = false
    const file = {
      size: MAX_LOCAL_PDF_BYTES + 1,
      async arrayBuffer() {
        read = true
        return new ArrayBuffer(0)
      },
    } as File

    await expectSafeRejection(
      convertPrivatePdfToEpub(file),
      'OVERSIZED_PDF',
      'unreachable-private-detail',
    )
    expect(read).toBe(false)
  })

  it('does not let parser diagnostics for private malformed input reach a logger', async () => {
    const spies = [
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
    ]
    try {
      await convertPrivatePdfToEpub(
        pdfFile('%PDF-1.7\nprivate-malformed-sentinel'),
        {
          dependencies: {
            reconstruct: (file, onProgress, signal) =>
              reconstructPdf(file, onProgress, { signal }),
          },
        },
      ).catch(() => undefined)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('allows a benign initial page destination to reach reconstruction', async () => {
    const reconstruct = vi.fn(async () => {
      throw new PdfImportError(
        'OCR_REQUIRED',
        'arbitrary source-specific detail must be discarded',
      )
    })
    const benignDestination = `%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R /OpenAction [3 0 R /Fit] >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>
endobj
trailer
<< /Root 1 0 R /Size 4 >>
%%EOF`

    await expectSafeRejection(
      convertPrivatePdfToEpub(pdfFile(benignDestination), {
        dependencies: { reconstruct },
      }),
      'OCR_REQUIRED',
      'arbitrary source-specific detail',
    )
    expect(reconstruct).toHaveBeenCalledTimes(1)
  })

  it('maps an unexpected reconstruction exception to one generic internal failure', async () => {
    const marker = 'PRIVATE-UNEXPECTED-RECONSTRUCTION-DETAIL'
    await expectSafeRejection(
      convertPrivatePdfToEpub(pdfFile('%PDF-1.7\n%%EOF'), {
        dependencies: {
          reconstruct: async () => {
            throw new Error(marker, { cause: { marker } })
          },
        },
      }),
      'INTERNAL_FAILURE',
      marker,
    )
  })

  it('anonymizes the browser File before reconstruction and never returns source identity', async () => {
    const source = await fixtureFile('born-digital.pdf')
    const marker = 'PRIVATE-BROWSER-FILENAME-9f3c2'
    const selected = new File([await source.arrayBuffer()], `${marker}.pdf`, {
      type: 'application/pdf',
      lastModified: Date.UTC(2042, 2, 4),
    })
    const observedNames: string[] = []

    const result = await convertPrivatePdfToEpub(selected, {
      dependencies: {
        reconstruct: async (file, onProgress, signal) => {
          observedNames.push(file.name)
          return reconstructPdf(file, onProgress, { signal })
        },
      },
    })

    expect(observedNames).toEqual(['local-document.pdf'])
    expect(result.fileName).toBe(PRIVATE_PDF_EPUB_FILE_NAME)
    expect(result.mediaType).toBe('application/epub+zip')
    expect(result.bytes.byteLength).toBeGreaterThan(0)
    expect(JSON.stringify({ ...result, bytes: undefined })).not.toContain(
      marker,
    )
    for (const bytes of Object.values(unzipSync(result.bytes))) {
      expect(strFromU8(bytes)).not.toContain(marker)
    }
  }, 120_000)

  it('returns a deterministic, independently reopenable EPUB package from accepted synthetic input', async () => {
    const source = await fixtureFile('born-digital.pdf')
    const bytes = await source.arrayBuffer()
    const directReconstruction = {
      reconstruct: (
        file: File,
        onProgress?: Parameters<typeof reconstructPdf>[1],
        signal?: AbortSignal,
      ) => reconstructPdf(file, onProgress, { signal }),
    }
    const first = await convertPrivatePdfToEpub(
      new File([bytes], 'first-private-name.pdf', {
        type: 'application/pdf',
        lastModified: 1,
      }),
      { dependencies: directReconstruction },
    )
    const second = await convertPrivatePdfToEpub(
      new File([bytes], 'different-private-name.pdf', {
        type: 'application/pdf',
        lastModified: 9_999,
      }),
      { dependencies: directReconstruction },
    )

    expect(second.bytes).toEqual(first.bytes)
    expect(second.sha256).toBe(first.sha256)
    expect(first.structArtifact).toEqual(PRIVATE_PDF_EPUB_STRUCT_ARTIFACT)

    const files = unzipSync(first.bytes)
    expect(strFromU8(files.mimetype!)).toBe('application/epub+zip')
    for (const name of [
      'META-INF/container.xml',
      'EPUB/package.opf',
      'EPUB/nav.xhtml',
      'EPUB/content.xhtml',
      'EPUB/styles.css',
    ]) {
      expect(files[name]).toBeInstanceOf(Uint8Array)
    }
    expect(strFromU8(files['META-INF/container.xml']!)).toContain(
      'EPUB/package.opf',
    )
    expect(strFromU8(files['EPUB/package.opf']!)).toMatch(/<spine\b/u)
    expect(strFromU8(files['EPUB/nav.xhtml']!)).toMatch(/<nav\b/u)
    expect(strFromU8(files['EPUB/content.xhtml']!)).toMatch(/<body\b/u)
  }, 120_000)

  it('fails closed when the sealed two-run transaction differs without exposing either output', async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce({
        bytes: new Uint8Array([1]),
        fileName: PRIVATE_PDF_EPUB_FILE_NAME,
        mediaType: 'application/epub+zip',
        sha256: 'a'.repeat(64),
        identifier: 'urn:synthetic:first',
        entries: [],
        mode: 'publication',
      })
      .mockResolvedValueOnce({
        bytes: new Uint8Array([2]),
        fileName: PRIVATE_PDF_EPUB_FILE_NAME,
        mediaType: 'application/epub+zip',
        sha256: 'b'.repeat(64),
        identifier: 'urn:synthetic:second',
        entries: [],
        mode: 'publication',
      })
    const marker = 'PRIVATE-RENDERED-CONTENT'
    const document = closedStructDocumentStub()

    await expectSafeRejection(
      convertPrivatePdfToEpub(pdfFile('%PDF-1.7\n%%EOF'), {
        dependencies: {
          reconstruct: async () => ({ readiness: { ready: true } }) as never,
          adapt: () => ({ ...document, marker }),
          decode: (value) => value as never,
          render: () => '<html />',
          build,
          inspectEpub: () => undefined,
        },
      }),
      'NONDETERMINISTIC_OUTPUT',
      marker,
    )
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('retains exact closed XHTML-versus-EPUB mismatch facts in memory only', async () => {
    const document = closedStructDocumentStub()
    const epub = {
      bytes: new Uint8Array([1]),
      fileName: PRIVATE_PDF_EPUB_FILE_NAME,
      mediaType: 'application/epub+zip' as const,
      sha256: 'a'.repeat(64),
      identifier: 'urn:synthetic:stable',
      entries: [] as string[],
      mode: 'publication' as const,
    }
    const render = vi
      .fn()
      .mockReturnValueOnce('<html>first</html>')
      .mockReturnValueOnce('<html>second</html>')

    const error = await convertPrivatePdfToEpub(pdfFile('%PDF-1.7\n%%EOF'), {
      dependencies: {
        reconstruct: async () => ({ readiness: { ready: true } }) as never,
        adapt: () => document,
        decode: (value) => value as never,
        render,
        build: async () => ({ ...epub, bytes: epub.bytes.slice() }),
        inspectEpub: () => undefined,
      },
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(PrivatePdfEpubBridgeError)
    expect(error).toMatchObject({
      code: 'NONDETERMINISTIC_OUTPUT',
      evaluation: {
        stage: 'reproducibility',
        sourceToStruct: {
          status: 'measured',
          neutralObligations: 1,
          conservedNeutralObligations: 1,
        },
        checkedAssertions: ['xhtmlByteMismatchCount', 'epubByteMismatchCount'],
        failedAssertions: ['xhtmlByteMismatchCount'],
      },
    })
  })

  it('does not label an unclassified EPUB exception as a manifest failure', async () => {
    const marker = 'PRIVATE-UNCLASSIFIED-EPUB-DETAIL'
    const document = closedStructDocumentStub()
    const epub = {
      bytes: new Uint8Array([1]),
      fileName: PRIVATE_PDF_EPUB_FILE_NAME,
      mediaType: 'application/epub+zip' as const,
      sha256: 'a'.repeat(64),
      identifier: 'urn:synthetic:stable',
      entries: [] as string[],
      mode: 'publication' as const,
    }
    const error = await convertPrivatePdfToEpub(pdfFile('%PDF-1.7\n%%EOF'), {
      dependencies: {
        reconstruct: async () => ({ readiness: { ready: true } }) as never,
        adapt: () => document,
        decode: (value) => value as never,
        render: () => '<html />',
        build: async () => ({ ...epub, bytes: epub.bytes.slice() }),
        inspectEpub: () => {
          throw new Error(marker)
        },
      },
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(PrivatePdfEpubBridgeError)
    expect(error).toMatchObject({
      code: 'EPUB_CONFORMANCE_FAILED',
      evaluation: {
        stage: 'epub-conformance',
        checkedAssertions: ['xhtmlByteMismatchCount', 'epubByteMismatchCount'],
        failedAssertions: [],
      },
    })
    expect(JSON.stringify(safePrivatePdfEpubError(error))).not.toContain(marker)
  })
})
