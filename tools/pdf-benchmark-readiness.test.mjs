import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { canonicalJson } from './pdf-fidelity-eval.mjs'
import * as pdfBenchmarkReadiness from './pdf-benchmark-readiness.mjs'
import {
  assessPdfBenchmarkReadiness,
  createPdfBenchmarkSplitIdentitySha256,
  createPdfBenchmarkReadinessReceipt,
  readJsonArtifact,
  validateCandidateCommitment,
  validateIndependentIsolationEvidence,
  validateNativeReaderEvidence,
  validateObservationBinding,
  validateSourcePdfDocumentIdentities,
  verifyRepositoryFileBinding,
} from './pdf-benchmark-readiness.mjs'

const registryPath = 'benchmarks/pdf/benchmark-readiness-registry-v1.json'
const readinessToolPath = fileURLToPath(
  new URL('./pdf-benchmark-readiness.mjs', import.meta.url),
)
const evidenceDirectories = []

afterEach(async () => {
  await Promise.all(
    evidenceDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function readRegistry() {
  return JSON.parse(await readFile(registryPath, 'utf8'))
}

async function writeRegistry(registry) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-benchmark-readiness-'))
  evidenceDirectories.push(directory)
  const path = join(directory, 'registry.json')
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`)
  return path
}

async function fileBinding(path) {
  return {
    path,
    fileSha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  }
}

async function createEvidenceWriter() {
  const directory = await mkdtemp(
    join(process.cwd(), 'benchmarks/pdf/.readiness-evidence-'),
  )
  evidenceDirectories.push(directory)
  return async (name, value) => {
    const absolutePath = join(directory, name)
    await writeFile(
      absolutePath,
      value instanceof Uint8Array
        ? value
        : `${JSON.stringify(value, null, 2)}\n`,
    )
    return fileBinding(relative(process.cwd(), absolutePath))
  }
}

function patchZipCentralDirectoryEntry(bytes, entryName, changes) {
  const patched = new Uint8Array(bytes)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  for (let offset = 0; offset <= patched.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = Buffer.from(
      patched.subarray(offset + 46, offset + 46 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      if (changes.compressedSize !== undefined) {
        view.setUint32(offset + 20, changes.compressedSize, true)
      }
      if (changes.originalSize !== undefined) {
        view.setUint32(offset + 24, changes.originalSize, true)
      }
      return patched
    }
    offset += nameLength + extraLength + commentLength
  }
  throw new Error(`missing ZIP central-directory entry: ${entryName}`)
}

function patchZipLocalHeaderEntry(bytes, entryName, changes) {
  const patched = new Uint8Array(bytes)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  for (let offset = 0; offset <= patched.byteLength - 30;) {
    if (view.getUint32(offset, true) !== 0x04034b50) break
    const compressedSize = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = Buffer.from(
      patched.subarray(offset + 30, offset + 30 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      if (changes.compressedSize !== undefined) {
        view.setUint32(offset + 18, changes.compressedSize, true)
      }
      if (changes.originalSize !== undefined) {
        view.setUint32(offset + 22, changes.originalSize, true)
      }
      return patched
    }
    offset += 30 + nameLength + extraLength + compressedSize
  }
  throw new Error(`missing ZIP local entry: ${entryName}`)
}

function patchZipEntrySizes(bytes, entryName, changes) {
  return patchZipCentralDirectoryEntry(
    patchZipLocalHeaderEntry(bytes, entryName, changes),
    entryName,
    changes,
  )
}

function corruptZipLocalEntryPayload(bytes, entryName) {
  const patched = new Uint8Array(bytes)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  for (let offset = 0; offset <= patched.byteLength - 30;) {
    if (view.getUint32(offset, true) !== 0x04034b50) break
    const compressedSize = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const payloadOffset = offset + 30 + nameLength + extraLength
    const name = Buffer.from(
      patched.subarray(offset + 30, offset + 30 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      if (compressedSize === 0) throw new Error(`empty ZIP entry: ${entryName}`)
      patched[payloadOffset + Math.floor(compressedSize / 2)] ^= 0xff
      return patched
    }
    offset = payloadOffset + compressedSize
  }
  throw new Error(`missing ZIP local entry: ${entryName}`)
}

function appendZipCompressedPayloadByte(bytes, entryName, byte) {
  const original = new Uint8Array(bytes)
  const originalView = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  )
  const endOffset = zipEndRecordOffset(original)
  const centralOffset = originalView.getUint32(endOffset + 16, true)
  let localOffset = null
  let compressedSize = null
  for (let cursor = centralOffset; cursor < endOffset;) {
    const nameLength = originalView.getUint16(cursor + 28, true)
    const extraLength = originalView.getUint16(cursor + 30, true)
    const commentLength = originalView.getUint16(cursor + 32, true)
    const name = Buffer.from(
      original.subarray(cursor + 46, cursor + 46 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      localOffset = originalView.getUint32(cursor + 42, true)
      compressedSize = originalView.getUint32(cursor + 20, true)
      break
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (localOffset === null || compressedSize === null) {
    throw new Error(`missing ZIP entry: ${entryName}`)
  }
  const nameLength = originalView.getUint16(localOffset + 26, true)
  const extraLength = originalView.getUint16(localOffset + 28, true)
  const payloadEnd =
    localOffset + 30 + nameLength + extraLength + compressedSize
  const patched = new Uint8Array(original.byteLength + 1)
  patched.set(original.subarray(0, payloadEnd))
  patched[payloadEnd] = byte
  patched.set(original.subarray(payloadEnd), payloadEnd + 1)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  const shiftedCentralOffset = centralOffset + 1
  const shiftedEndOffset = endOffset + 1
  view.setUint32(localOffset + 18, compressedSize + 1, true)
  for (let cursor = shiftedCentralOffset; cursor < shiftedEndOffset;) {
    const centralNameLength = view.getUint16(cursor + 28, true)
    const centralExtraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const name = Buffer.from(
      patched.subarray(cursor + 46, cursor + 46 + centralNameLength),
    ).toString('utf8')
    if (name === entryName) {
      view.setUint32(cursor + 20, compressedSize + 1, true)
    }
    if (view.getUint32(cursor + 42, true) > localOffset) {
      view.setUint32(cursor + 42, view.getUint32(cursor + 42, true) + 1, true)
    }
    cursor += 46 + centralNameLength + centralExtraLength + commentLength
  }
  view.setUint32(shiftedEndOffset + 16, shiftedCentralOffset, true)
  return patched
}

function appendZipDescriptorPayloadByte(bytes, entryName, byte) {
  const original = new Uint8Array(bytes)
  const originalView = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  )
  const endOffset = zipEndRecordOffset(original)
  const centralOffset = originalView.getUint32(endOffset + 16, true)
  let localOffset = null
  let compressedSize = null
  for (let cursor = centralOffset; cursor < endOffset;) {
    const nameLength = originalView.getUint16(cursor + 28, true)
    const extraLength = originalView.getUint16(cursor + 30, true)
    const commentLength = originalView.getUint16(cursor + 32, true)
    const name = Buffer.from(
      original.subarray(cursor + 46, cursor + 46 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      localOffset = originalView.getUint32(cursor + 42, true)
      compressedSize = originalView.getUint32(cursor + 20, true)
      break
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (localOffset === null || compressedSize === null) {
    throw new Error(`missing ZIP entry: ${entryName}`)
  }
  const nextLocalOffset = (() => {
    let next = centralOffset
    for (let cursor = centralOffset; cursor < endOffset;) {
      const candidate = originalView.getUint32(cursor + 42, true)
      if (candidate > localOffset && candidate < next) next = candidate
      cursor +=
        46 +
        originalView.getUint16(cursor + 28, true) +
        originalView.getUint16(cursor + 30, true) +
        originalView.getUint16(cursor + 32, true)
    }
    return next
  })()
  const nameLength = originalView.getUint16(localOffset + 26, true)
  const extraLength = originalView.getUint16(localOffset + 28, true)
  const descriptorOffset =
    localOffset + 30 + nameLength + extraLength + compressedSize
  const descriptorSize = nextLocalOffset - descriptorOffset
  if (descriptorSize !== 12 && descriptorSize !== 16) {
    throw new Error(`missing ZIP data descriptor: ${entryName}`)
  }
  const patched = new Uint8Array(original.byteLength + 1)
  patched.set(original.subarray(0, descriptorOffset))
  patched[descriptorOffset] = byte
  patched.set(original.subarray(descriptorOffset), descriptorOffset + 1)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  const shiftedCentralOffset = centralOffset + 1
  const shiftedEndOffset = endOffset + 1
  const descriptorFieldsOffset =
    descriptorOffset + 1 + (descriptorSize === 16 ? 4 : 0)
  view.setUint32(descriptorFieldsOffset + 4, compressedSize + 1, true)
  for (let cursor = shiftedCentralOffset; cursor < shiftedEndOffset;) {
    const centralNameLength = view.getUint16(cursor + 28, true)
    const centralExtraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const name = Buffer.from(
      patched.subarray(cursor + 46, cursor + 46 + centralNameLength),
    ).toString('utf8')
    if (name === entryName) {
      view.setUint32(cursor + 20, compressedSize + 1, true)
    }
    if (view.getUint32(cursor + 42, true) > localOffset) {
      view.setUint32(cursor + 42, view.getUint32(cursor + 42, true) + 1, true)
    }
    cursor += 46 + centralNameLength + centralExtraLength + commentLength
  }
  view.setUint32(shiftedEndOffset + 16, shiftedCentralOffset, true)
  return patched
}

function zipEndRecordOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  throw new Error('missing ZIP end record')
}

function prependUnindexedLocalEntry(bytes, entryName, value) {
  const hiddenArchive = zipSync({ [entryName]: value })
  const hiddenView = new DataView(
    hiddenArchive.buffer,
    hiddenArchive.byteOffset,
    hiddenArchive.byteLength,
  )
  const hiddenLocalBytes = hiddenArchive.subarray(
    0,
    hiddenView.getUint32(zipEndRecordOffset(hiddenArchive) + 16, true),
  )
  const patched = new Uint8Array(hiddenLocalBytes.byteLength + bytes.byteLength)
  patched.set(hiddenLocalBytes)
  patched.set(bytes, hiddenLocalBytes.byteLength)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  const endOffset = zipEndRecordOffset(patched)
  const entryCount = view.getUint16(endOffset + 10, true)
  const centralOffset = view.getUint32(endOffset + 16, true)
  const shiftedCentralOffset = centralOffset + hiddenLocalBytes.byteLength
  view.setUint32(endOffset + 16, shiftedCentralOffset, true)
  let cursor = shiftedCentralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('invalid ZIP central record')
    }
    view.setUint32(
      cursor + 42,
      view.getUint32(cursor + 42, true) + hiddenLocalBytes.byteLength,
      true,
    )
    cursor +=
      46 +
      view.getUint16(cursor + 28, true) +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true)
  }
  return patched
}

function patchZipMismatchedInvalidNameBytes(bytes, entryName) {
  const patched = new Uint8Array(bytes)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  let localPatched = false
  for (let offset = 0; offset <= patched.byteLength - 30;) {
    if (view.getUint32(offset, true) !== 0x04034b50) break
    const compressedSize = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = Buffer.from(
      patched.subarray(offset + 30, offset + 30 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      patched[offset + 30 + nameLength - 1] = 0xff
      localPatched = true
      break
    }
    offset += 30 + nameLength + extraLength + compressedSize
  }
  let centralPatched = false
  for (let offset = 0; offset <= patched.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const name = Buffer.from(
      patched.subarray(offset + 46, offset + 46 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      patched[offset + 46 + nameLength - 1] = 0xfe
      centralPatched = true
      break
    }
  }
  if (!localPatched || !centralPatched) throw new Error('missing ZIP entry')
  return patched
}

function createValidEpub(extraEntries = {}) {
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
    ),
    'EPUB/package.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata><identifier id="pub-id">urn:fixture</identifier></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="content"/></spine></package>',
    ),
    ...extraEntries,
  })
}

function addZipDataDescriptor(bytes, entryName, { signature = true } = {}) {
  const original = new Uint8Array(bytes)
  const originalView = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  )
  const endOffset = zipEndRecordOffset(original)
  const centralOffset = originalView.getUint32(endOffset + 16, true)
  let centralEntryOffset = centralOffset
  let localOffset = null
  let checksum = null
  let compressedSize = null
  let originalSize = null
  for (; centralEntryOffset < endOffset;) {
    const nameLength = originalView.getUint16(centralEntryOffset + 28, true)
    const extraLength = originalView.getUint16(centralEntryOffset + 30, true)
    const commentLength = originalView.getUint16(centralEntryOffset + 32, true)
    const name = Buffer.from(
      original.subarray(
        centralEntryOffset + 46,
        centralEntryOffset + 46 + nameLength,
      ),
    ).toString('utf8')
    if (name === entryName) {
      checksum = originalView.getUint32(centralEntryOffset + 16, true)
      compressedSize = originalView.getUint32(centralEntryOffset + 20, true)
      originalSize = originalView.getUint32(centralEntryOffset + 24, true)
      localOffset = originalView.getUint32(centralEntryOffset + 42, true)
      break
    }
    centralEntryOffset += 46 + nameLength + extraLength + commentLength
  }
  if (localOffset === null) throw new Error(`missing ZIP entry: ${entryName}`)

  const localNameLength = originalView.getUint16(localOffset + 26, true)
  const localExtraLength = originalView.getUint16(localOffset + 28, true)
  const descriptorOffset =
    localOffset + 30 + localNameLength + localExtraLength + compressedSize
  const descriptor = new Uint8Array(signature ? 16 : 12)
  const descriptorView = new DataView(descriptor.buffer)
  const fieldsOffset = signature ? 4 : 0
  if (signature) descriptorView.setUint32(0, 0x08074b50, true)
  descriptorView.setUint32(fieldsOffset, checksum, true)
  descriptorView.setUint32(fieldsOffset + 4, compressedSize, true)
  descriptorView.setUint32(fieldsOffset + 8, originalSize, true)
  const patched = new Uint8Array(original.byteLength + descriptor.byteLength)
  patched.set(original.subarray(0, descriptorOffset))
  patched.set(descriptor, descriptorOffset)
  patched.set(
    original.subarray(descriptorOffset),
    descriptorOffset + descriptor.byteLength,
  )
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  const shiftedCentralOffset = centralOffset + descriptor.byteLength
  const shiftedEndOffset = endOffset + descriptor.byteLength
  view.setUint16(
    localOffset + 6,
    view.getUint16(localOffset + 6, true) | 0x0008,
    true,
  )
  view.setUint32(localOffset + 14, 0, true)
  view.setUint32(localOffset + 18, 0, true)
  view.setUint32(localOffset + 22, 0, true)
  let cursor = shiftedCentralOffset
  while (cursor < shiftedEndOffset) {
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const name = Buffer.from(
      patched.subarray(cursor + 46, cursor + 46 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      view.setUint16(
        cursor + 8,
        view.getUint16(cursor + 8, true) | 0x0008,
        true,
      )
    }
    if (view.getUint32(cursor + 42, true) > localOffset) {
      view.setUint32(
        cursor + 42,
        view.getUint32(cursor + 42, true) + descriptor.byteLength,
        true,
      )
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  view.setUint32(shiftedEndOffset + 16, shiftedCentralOffset, true)
  return patched
}

function corruptZipDataDescriptor(bytes, entryName) {
  const patched = new Uint8Array(bytes)
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  const endOffset = zipEndRecordOffset(patched)
  const centralOffset = view.getUint32(endOffset + 16, true)
  for (let cursor = centralOffset; cursor < endOffset;) {
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const name = Buffer.from(
      patched.subarray(cursor + 46, cursor + 46 + nameLength),
    ).toString('utf8')
    if (name === entryName) {
      const localOffset = view.getUint32(cursor + 42, true)
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const descriptorOffset =
        localOffset +
        30 +
        localNameLength +
        localExtraLength +
        view.getUint32(cursor + 20, true)
      view.setUint32(descriptorOffset + 4, 0, true)
      return patched
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`missing ZIP entry: ${entryName}`)
}

function addZipMimetypeExtraFields(bytes) {
  const original = new Uint8Array(bytes)
  const originalView = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  )
  const endOffset = zipEndRecordOffset(original)
  const centralOffset = originalView.getUint32(endOffset + 16, true)
  const localNameLength = originalView.getUint16(26, true)
  const localExtraLength = originalView.getUint16(28, true)
  if (
    Buffer.from(original.subarray(30, 30 + localNameLength)).toString(
      'ascii',
    ) !== 'mimetype'
  ) {
    throw new Error('expected mimetype local entry first')
  }
  const extra = Uint8Array.from([0xca, 0xfe])
  const localExtraOffset = 30 + localNameLength + localExtraLength
  const withLocalExtra = new Uint8Array(original.byteLength + extra.byteLength)
  withLocalExtra.set(original.subarray(0, localExtraOffset))
  withLocalExtra.set(extra, localExtraOffset)
  withLocalExtra.set(
    original.subarray(localExtraOffset),
    localExtraOffset + extra.byteLength,
  )
  const localView = new DataView(
    withLocalExtra.buffer,
    withLocalExtra.byteOffset,
    withLocalExtra.byteLength,
  )
  localView.setUint16(28, localExtraLength + extra.byteLength, true)
  const shiftedCentralOffset = centralOffset + extra.byteLength
  const shiftedEndOffset = endOffset + extra.byteLength
  localView.setUint32(shiftedEndOffset + 16, shiftedCentralOffset, true)

  let mimetypeCentralOffset = shiftedCentralOffset
  const centralNameLength = localView.getUint16(
    mimetypeCentralOffset + 28,
    true,
  )
  const centralExtraLength = localView.getUint16(
    mimetypeCentralOffset + 30,
    true,
  )
  const centralExtraOffset =
    mimetypeCentralOffset + 46 + centralNameLength + centralExtraLength
  const patched = new Uint8Array(withLocalExtra.byteLength + extra.byteLength)
  patched.set(withLocalExtra.subarray(0, centralExtraOffset))
  patched.set(extra, centralExtraOffset)
  patched.set(
    withLocalExtra.subarray(centralExtraOffset),
    centralExtraOffset + extra.byteLength,
  )
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  view.setUint16(
    mimetypeCentralOffset + 30,
    centralExtraLength + extra.byteLength,
    true,
  )
  const finalEndOffset = shiftedEndOffset + extra.byteLength
  view.setUint32(
    finalEndOffset + 12,
    view.getUint32(finalEndOffset + 12, true) + extra.byteLength,
    true,
  )
  for (let cursor = shiftedCentralOffset; cursor < finalEndOffset;) {
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    if (view.getUint32(cursor + 42, true) !== 0) {
      view.setUint32(
        cursor + 42,
        view.getUint32(cursor + 42, true) + extra.byteLength,
        true,
      )
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return patched
}

function addZipMimetypeLocalExtraField(bytes) {
  const original = new Uint8Array(bytes)
  const originalView = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  )
  const endOffset = zipEndRecordOffset(original)
  const centralOffset = originalView.getUint32(endOffset + 16, true)
  const nameLength = originalView.getUint16(26, true)
  const extraLength = originalView.getUint16(28, true)
  const insertionOffset = 30 + nameLength + extraLength
  const extra = Uint8Array.from([0xca, 0xfe])
  const patched = new Uint8Array(original.byteLength + extra.byteLength)
  patched.set(original.subarray(0, insertionOffset))
  patched.set(extra, insertionOffset)
  patched.set(
    original.subarray(insertionOffset),
    insertionOffset + extra.byteLength,
  )
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  view.setUint16(28, extraLength + extra.byteLength, true)
  const shiftedCentralOffset = centralOffset + extra.byteLength
  const shiftedEndOffset = endOffset + extra.byteLength
  view.setUint32(shiftedEndOffset + 16, shiftedCentralOffset, true)
  for (let cursor = shiftedCentralOffset; cursor < shiftedEndOffset;) {
    const centralNameLength = view.getUint16(cursor + 28, true)
    const centralExtraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    if (view.getUint32(cursor + 42, true) !== 0) {
      view.setUint32(
        cursor + 42,
        view.getUint32(cursor + 42, true) + extra.byteLength,
        true,
      )
    }
    cursor += 46 + centralNameLength + centralExtraLength + commentLength
  }
  return patched
}

function addZipMimetypeCentralExtraField(bytes) {
  const original = new Uint8Array(bytes)
  const originalView = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  )
  const endOffset = zipEndRecordOffset(original)
  const centralOffset = originalView.getUint32(endOffset + 16, true)
  const nameLength = originalView.getUint16(centralOffset + 28, true)
  const extraLength = originalView.getUint16(centralOffset + 30, true)
  const insertionOffset = centralOffset + 46 + nameLength + extraLength
  const extra = Uint8Array.from([0xca, 0xfe])
  const patched = new Uint8Array(original.byteLength + extra.byteLength)
  patched.set(original.subarray(0, insertionOffset))
  patched.set(extra, insertionOffset)
  patched.set(
    original.subarray(insertionOffset),
    insertionOffset + extra.byteLength,
  )
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )
  view.setUint16(centralOffset + 30, extraLength + extra.byteLength, true)
  const shiftedEndOffset = endOffset + extra.byteLength
  view.setUint32(
    shiftedEndOffset + 12,
    view.getUint32(shiftedEndOffset + 12, true) + extra.byteLength,
    true,
  )
  return patched
}

function reviewerIdentityEvidence(reviewerId, subjectIdentitySha256) {
  return {
    schemaVersion: '1.0.0',
    kind: 'pdf-benchmark-reviewer-identity-evidence',
    reviewerId,
    identityAuthority: 'verified-benchmark-reviewer-roster',
    subjectIdentitySha256,
  }
}

describe('PDF benchmark readiness registry', () => {
  it('binds the current package-integrity source and rejects a one-byte fixture mutation', async () => {
    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath }),
    ).resolves.toMatchObject({
      criteria: expect.arrayContaining([
        expect.objectContaining({ id: 'metric-coverage' }),
      ]),
    })

    const writeEvidence = await createEvidenceWriter()
    const implementation = await writeEvidence('package-integrity.json', {
      kind: 'package-integrity-fixture',
    })
    const fixtureRegistry = await readRegistry()
    const packageIntegrity = fixtureRegistry.metricImplementations.find(
      (metric) => metric.id === 'package-integrity',
    )
    packageIntegrity.implementation = implementation.path
    packageIntegrity.implementationSha256 = implementation.fileSha256
    const fixtureRegistryPath = await writeRegistry(fixtureRegistry)

    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath: fixtureRegistryPath }),
    ).resolves.toMatchObject({
      criteria: expect.arrayContaining([
        expect.objectContaining({ id: 'metric-coverage' }),
      ]),
    })

    await writeFile(
      implementation.path,
      `${await readFile(implementation.path)}\n`,
    )
    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath: fixtureRegistryPath }),
    ).rejects.toThrow('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  })

  it('binds every extracted package-integrity test dependency', async () => {
    for (const mutate of [
      (metric) => delete metric.testDependencies,
      (metric) => {
        metric.testDependencies = []
      },
      (metric) => {
        metric.testDependencies = metric.testDependencies.slice(1)
      },
      (metric) => {
        metric.testDependencies[0].path = 'tools/unexpected-test-dependency.mjs'
      },
      (metric) => {
        metric.testDependencies[1] = {
          ...metric.testDependencies[0],
          path: metric.testDependencies[0].path,
          fileSha256: '0'.repeat(64),
        }
      },
    ]) {
      const invalidRegistry = await readRegistry()
      mutate(
        invalidRegistry.metricImplementations.find(
          (metric) => metric.id === 'package-integrity',
        ),
      )
      const invalidRegistryPath = await writeRegistry(invalidRegistry)
      await expect(
        createPdfBenchmarkReadinessReceipt({
          registryPath: invalidRegistryPath,
        }),
      ).rejects.toThrow(
        /PDF_BENCHMARK_METRIC_BINDING_MISMATCH|INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA|INVALID_PDF_BENCHMARK_REGISTRY/,
      )
    }

    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath }),
    ).resolves.toMatchObject({
      criteria: expect.arrayContaining([
        expect.objectContaining({ id: 'metric-coverage' }),
      ]),
    })

    for (const index of [0, 1, 2, 3]) {
      const invalidRegistry = await readRegistry()
      const dependency = invalidRegistry.metricImplementations.find(
        (metric) => metric.id === 'package-integrity',
      ).testDependencies[index]
      dependency.fileSha256 = '0'.repeat(64)
      const invalidRegistryPath = await writeRegistry(invalidRegistry)
      await expect(
        createPdfBenchmarkReadinessReceipt({
          registryPath: invalidRegistryPath,
        }),
      ).rejects.toThrow('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    }
  })

  it('reports the exposed 32-case calibration honestly as not ready', async () => {
    const receipt = await createPdfBenchmarkReadinessReceipt({ registryPath })

    expect(receipt).toMatchObject({
      schemaVersion: '1.0.0',
      inventory: {
        caseCount: 32,
        documentCount: 4,
        failureClassCount: 13,
        finalNoNewClassWindow: 0,
        documentDisjoint: true,
        templateFamilyDisjoint: true,
        verifiedSourceTemplateBindingCount: 0,
      },
      ready: false,
    })
    expect(receipt.gaps).toEqual([
      'trace-count',
      'distinct-document-count',
      'discovery-order-recorded',
      'final-no-new-class-window',
      'independent-review-coverage',
      'source-template-binding-coverage',
      'train-development-splits-frozen',
      'blind-split-frozen',
      'candidate-commitment-frozen-before-label-reveal',
      'target-free-end-to-end-track',
      'metric-coverage',
      'native-reader-exact-artifact-coverage',
      'promotion-protocol-implementation',
    ])
    expect(receipt.sources).toHaveLength(2)
    expect(receipt.sources.every((source) => source.oracleLocalized)).toBe(true)
    expect(receipt.inventory.failureClassCounts).toMatchObject({
      privateRedactedObservationCount: 0,
    })
    expect(
      receipt.criteria.find(
        (criterion) => criterion.id === 'target-free-end-to-end-track',
      ).observed,
    ).toMatchObject({
      promotionAuthority: false,
      networkIsolation: 'cooperative-offline-flags',
      filesystemIsolation: 'minimized-environment-not-sandboxed',
    })
    expect(receipt.registry.fileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.registry.canonicalSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('preserves the privacy-safe native reader validation summary in the hash-bound receipt', async () => {
    const receipt = await createPdfBenchmarkReadinessReceipt({ registryPath })

    expect(receipt.nativeReaderEvidence).toEqual({
      exactArtifactSha256: null,
      structurallyValidatedReaderIds: [],
      trustedAttestationVerified: false,
      trustedAttestationReason: 'trusted-attestation-verifier-not-implemented',
      verifiedReaderIds: [],
    })
    const { receiptSha256, ...unsignedReceipt } = receipt
    expect(receiptSha256).toBe(
      createHash('sha256').update(canonicalJson(unsignedReceipt)).digest('hex'),
    )
  })

  it('accepts legacy v1 registries without native-reader evidence as canonical blockers', async () => {
    const legacyRegistry = await readRegistry()
    delete legacyRegistry.nativeReaderEvidence

    const receipt = await createPdfBenchmarkReadinessReceipt({
      registryPath: await writeRegistry(legacyRegistry),
    })
    expect(receipt.ready).toBe(false)
    expect(receipt.gaps).toContain('native-reader-exact-artifact-coverage')
    expect(receipt.nativeReaderEvidence).toEqual({
      exactArtifactSha256: null,
      structurallyValidatedReaderIds: [],
      trustedAttestationVerified: false,
      trustedAttestationReason: 'trusted-attestation-verifier-not-implemented',
      verifiedReaderIds: [],
    })

    const malformedPresentRegistry = await readRegistry()
    malformedPresentRegistry.nativeReaderEvidence = { malformed: true }
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(malformedPresentRegistry),
      }),
    ).rejects.toThrow(/INVALID_PDF_BENCHMARK_REGISTRY/)
  })

  it('bounds EPUB archive metadata before inflation', () => {
    expect(typeof pdfBenchmarkReadiness.validEpubPackage).toBe('function')
    const { validEpubPackage } = pdfBenchmarkReadiness
    const validFixture = createValidEpub({
      'EPUB/payload.bin': [strToU8('fixture'), { level: 0 }],
    })
    expect(validEpubPackage(validFixture)).toBe(true)

    const descriptorPackage = addZipDataDescriptor(
      validFixture,
      'EPUB/package.opf',
    )
    expect(validEpubPackage(descriptorPackage)).toBe(true)
    expect(
      validEpubPackage(
        appendZipDescriptorPayloadByte(
          descriptorPackage,
          'EPUB/package.opf',
          0xaa,
        ),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        appendZipCompressedPayloadByte(validFixture, 'EPUB/package.opf', 0xaa),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        addZipDataDescriptor(validFixture, 'EPUB/package.opf', {
          signature: false,
        }),
      ),
    ).toBe(true)
    expect(
      validEpubPackage(
        corruptZipDataDescriptor(descriptorPackage, 'EPUB/package.opf'),
      ),
    ).toBe(false)

    const unsignedDescriptorCrcAmbiguity = addZipDataDescriptor(
      createValidEpub({
        'EPUB/payload.bin': [
          Uint8Array.from([
            ...strToU8('zip-descriptor-ambiguity'),
            0x56,
            0x42,
            0x90,
            0x7e,
          ]),
          { level: 0 },
        ],
      }),
      'EPUB/payload.bin',
      { signature: false },
    )
    expect(validEpubPackage(unsignedDescriptorCrcAmbiguity)).toBe(true)

    expect(validEpubPackage(addZipMimetypeExtraFields(validFixture))).toBe(
      false,
    )
    expect(validEpubPackage(addZipMimetypeLocalExtraField(validFixture))).toBe(
      false,
    )
    expect(
      validEpubPackage(addZipMimetypeCentralExtraField(validFixture)),
    ).toBe(false)

    const oversizedCompressed = patchZipCentralDirectoryEntry(
      validFixture,
      'EPUB/payload.bin',
      { compressedSize: 256 * 1024 * 1024 + 1 },
    )
    expect(validEpubPackage(oversizedCompressed)).toBe(false)

    const oversizedInflated = patchZipCentralDirectoryEntry(
      validFixture,
      'EPUB/payload.bin',
      { originalSize: 512 * 1024 * 1024 + 1 },
    )
    expect(validEpubPackage(oversizedInflated)).toBe(false)

    const tooManyEntries = createValidEpub(
      Object.fromEntries(
        Array.from({ length: 542 }, (_, index) => [
          `EPUB/extra-${index}.txt`,
          [strToU8('x'), { level: 0 }],
        ]),
      ),
    )
    expect(validEpubPackage(tooManyEntries)).toBe(false)

    const oversizedContainer = createValidEpub({
      'META-INF/container.xml': strToU8('<rootfile'.repeat(64 * 1024)),
    })
    expect(oversizedContainer.byteLength).toBeLessThan(16 * 1024)
    expect(validEpubPackage(oversizedContainer)).toBe(false)

    const oversizedRootfile = patchZipCentralDirectoryEntry(
      validFixture,
      'EPUB/package.opf',
      { originalSize: 4 * 1024 * 1024 + 1 },
    )
    expect(validEpubPackage(oversizedRootfile)).toBe(false)

    const compressedMimetype = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
      ),
      'EPUB/package.opf': strToU8(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata><identifier id="pub-id">urn:fixture</identifier></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="content"/></spine></package>',
      ),
    })
    expect(validEpubPackage(compressedMimetype)).toBe(false)

    const corruptPackagePayload = corruptZipLocalEntryPayload(
      createValidEpub({
        'EPUB/package.opf': strToU8(
          `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><meta>${'x'.repeat(64 * 1024)}</meta></metadata><manifest/><spine/></package>`,
        ),
      }),
      'EPUB/package.opf',
    )
    expect(validEpubPackage(corruptPackagePayload)).toBe(false)

    expect(
      validEpubPackage(
        createValidEpub({
          'EPUB/package.opf': strToU8('<package><metadata></package>'),
        }),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        createValidEpub({
          'META-INF/container.xml': strToU8(
            '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/decoy.opf" media-type="text/plain"/><rootfile xmlns="urn:evil" full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
          ),
        }),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        createValidEpub({
          'META-INF/container.xml': strToU8(
            '<c:container xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><c:rootfiles><c:rootfile full-path="EPUB/decoy.opf" media-type="text/plain"/><c:rootfile xmlns:c="urn:evil" full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></c:rootfiles></c:container>',
          ),
        }),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        createValidEpub({
          'EPUB/package.opf': strToU8(
            '<package xmlns="http://www.idpf.org/2007/opf" xmlns:evil="urn:evil" version="3.0" unique-identifier="pub-id"><evil:metadata><evil:identifier id="pub-id">urn:fixture</evil:identifier></evil:metadata><evil:manifest><evil:item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></evil:manifest><evil:spine><evil:itemref idref="content"/></evil:spine></package>',
          ),
        }),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        createValidEpub({
          'EPUB/package.opf': strToU8(
            '<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><opf:metadata><opf:identifier id="pub-id">urn:fixture</opf:identifier></opf:metadata><opf:manifest><opf:item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></opf:manifest><opf:spine><opf:itemref idref="content"/></opf:spine></opf:package>',
          ),
        }),
      ),
    ).toBe(true)
    expect(
      validEpubPackage(
        createValidEpub({
          'EPUB/package.opf': strToU8('<not-a-package />'),
        }),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        createValidEpub({
          'EPUB/package.opf': strToU8(
            '<x:package xmlns:x="urn:evil"><metadata/><manifest/><spine/></x:package>',
          ),
        }),
      ),
    ).toBe(false)

    const underdeclaredPackage = patchZipEntrySizes(
      createValidEpub({
        'EPUB/package.opf': strToU8(
          `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><meta>${'x'.repeat(8 * 1024 * 1024)}</meta></metadata><manifest/><spine/></package>`,
        ),
      }),
      'EPUB/package.opf',
      { originalSize: 25 },
    )
    expect(underdeclaredPackage.byteLength).toBeLessThan(64 * 1024)
    expect(validEpubPackage(underdeclaredPackage)).toBe(false)

    const underdeclaredContainer = patchZipEntrySizes(
      createValidEpub({
        'META-INF/container.xml': strToU8('<rootfile'.repeat(128 * 1024)),
      }),
      'META-INF/container.xml',
      { originalSize: 80 },
    )
    expect(underdeclaredContainer.byteLength).toBeLessThan(32 * 1024)
    expect(validEpubPackage(underdeclaredContainer)).toBe(false)

    const hiddenPackageRecord = prependUnindexedLocalEntry(
      createValidEpub(),
      'EPUB/package.opf',
      strToU8(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="hidden"><metadata><identifier id="hidden">urn:hidden</identifier></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="content"/></spine></package>',
      ),
    )
    expect(validEpubPackage(hiddenPackageRecord)).toBe(false)

    const corruptContentPayload = corruptZipLocalEntryPayload(
      createValidEpub({
        'EPUB/content.xhtml': strToU8(
          `<html xmlns="http://www.w3.org/1999/xhtml"><body>${'content'.repeat(4096)}</body></html>`,
        ),
      }),
      'EPUB/content.xhtml',
    )
    expect(validEpubPackage(corruptContentPayload)).toBe(false)

    const invalidNameBytes = patchZipMismatchedInvalidNameBytes(
      createValidEpub({ 'EPUB/extra.txt': strToU8('extra') }),
      'EPUB/extra.txt',
    )
    expect(validEpubPackage(invalidNameBytes)).toBe(false)

    expect(
      validEpubPackage(
        createValidEpub({
          'META-INF/container.xml': strToU8(
            '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles xmlns="urn:evil"><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
          ),
        }),
      ),
    ).toBe(false)
    expect(
      validEpubPackage(
        createValidEpub({
          'EPUB/package.opf': strToU8(
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns="urn:evil"><identifier id="pub-id">urn:fixture</identifier></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="content"/></spine></package>',
          ),
        }),
      ),
    ).toBe(false)
  })

  it('accepts the repository-published EPUB profile', async () => {
    const published = await readFile(
      'public/research/if-letters-home-could-sing/if-letters-home-could-sing.epub',
    )
    expect(pdfBenchmarkReadiness.validEpubPackage(published)).toBe(true)
  })

  it('accepts safe directory and empty resource entries', () => {
    const fixture = createValidEpub({
      'EPUB/': [new Uint8Array(), { level: 0 }],
      'EPUB/empty.css': [new Uint8Array(), { level: 0 }],
    })
    expect(pdfBenchmarkReadiness.validEpubPackage(fixture)).toBe(true)
  })

  it('rejects oversized EPUB and governance bindings from lstat metadata', async () => {
    const writeEvidence = await createEvidenceWriter()
    const oversizedEpub = await writeEvidence(
      'oversized-before-read.epub',
      createValidEpub(),
    )
    await truncate(oversizedEpub.path, 256 * 1024 * 1024 + 1)
    const exportEvidence = await writeEvidence(
      'oversized-export-evidence.json',
      {
        schemaVersion: '1.0.0',
        kind: 'pdf-benchmark-exact-epub-export-evidence',
        epubArtifact: oversizedEpub,
        exactArtifactSha256: oversizedEpub.fileSha256,
        exportReceipt: oversizedEpub,
        exportReceiptIdentitySha256: 'a'.repeat(64),
        toolchainManifest: oversizedEpub,
        epubCheckReceipt: oversizedEpub,
        epubCheckTranscript: oversizedEpub,
        status: 'passed',
      },
    )
    const unavailableReaders = {
      status: 'unavailable-blocker',
      readerIdentity: null,
      executionReceipt: null,
    }
    await expect(
      validateNativeReaderEvidence({
        exportEvidence,
        'apple-books': unavailableReaders,
        'independent-desktop-epub-reader': unavailableReaders,
        'target-eink-reader-device': unavailableReaders,
      }),
    ).rejects.toThrow('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')

    const oversizedJson = await writeEvidence('oversized-governance.json', {
      fixture: true,
    })
    await truncate(oversizedJson.path, 16 * 1024 * 1024 + 1)
    await expect(
      validateNativeReaderEvidence({
        exportEvidence: oversizedJson,
        'apple-books': unavailableReaders,
        'independent-desktop-epub-reader': unavailableReaders,
        'target-eink-reader-device': unavailableReaders,
      }),
    ).rejects.toThrow('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  })

  it('never accepts outside bytes while a repository binding is replaced', async () => {
    const writeEvidence = await createEvidenceWriter()
    const repositoryBinding = await writeEvidence(
      'descriptor-race.json',
      strToU8('inside'),
    )
    const outsideDirectory = await mkdtemp(
      join(tmpdir(), 'pdf-binding-outside-'),
    )
    evidenceDirectories.push(outsideDirectory)
    const outsidePath = join(outsideDirectory, 'outside.json')
    const outsideBytes = strToU8('outside')
    await writeFile(outsidePath, outsideBytes)
    const outsideHash = createHash('sha256').update(outsideBytes).digest('hex')

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const validation = verifyRepositoryFileBinding(
        repositoryBinding.path,
        outsideHash,
        'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
        64,
      ).then(
        () => ({ accepted: true, error: null }),
        (error) => ({ accepted: false, error }),
      )
      await rm(repositoryBinding.path, { force: true })
      await symlink(outsidePath, repositoryBinding.path)
      const outcome = await validation
      expect(outcome.accepted).toBe(false)
      expect(outcome.error).toMatchObject({
        message: 'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
      })
      await rm(repositoryBinding.path, { force: true })
      await writeFile(repositoryBinding.path, strToU8('inside'))
    }
  })

  it('reads registry JSON from one bounded descriptor during replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-registry-race-'))
    evidenceDirectories.push(directory)
    const registryArtifact = join(directory, 'registry.json')
    const outsideArtifact = join(directory, 'outside.json')
    await writeFile(outsideArtifact, JSON.stringify({ outside: true }))

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await writeFile(registryArtifact, JSON.stringify({ inside: true }))
      const validation = readJsonArtifact(
        registryArtifact,
        'INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA',
      ).then(
        (artifact) => ({ artifact, error: null }),
        (error) => ({ artifact: null, error }),
      )
      await rm(registryArtifact, { force: true })
      await symlink(outsideArtifact, registryArtifact)
      const outcome = await validation
      if (outcome.artifact !== null) {
        expect(outcome.artifact.value).toEqual({ inside: true })
      } else {
        expect(outcome.error).toMatchObject({
          message: 'INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA',
        })
      }
      await rm(registryArtifact, { force: true })
    }
  })

  it('fails closed when a bound artifact hash changes', async () => {
    const registry = await readRegistry()
    registry.sources[0].evalSet.fileSha256 = '0'.repeat(64)
    const path = await writeRegistry(registry)

    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath: path }),
    ).rejects.toThrow('PDF_BENCHMARK_SOURCE_HASH_MISMATCH')
  })

  it('binds the observation schema and rejects path-like failure labels', async () => {
    const wrongSchema = await readRegistry()
    wrongSchema.sources[0].observations.schema.fileSha256 = '0'.repeat(64)
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(wrongSchema),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_OBSERVATION_SCHEMA_MISMATCH')

    const [registry, evalSet, observations] = await Promise.all([
      readRegistry(),
      readFile('benchmarks/pdf/fidelity-eval-v1.json', 'utf8').then(JSON.parse),
      readFile(
        'benchmarks/pdf/fidelity-eval-observations-v1.json',
        'utf8',
      ).then(JSON.parse),
    ])

    const wrongEvalSetIdentity = structuredClone(observations)
    wrongEvalSetIdentity.evalSet.evalSetSha256 = '0'.repeat(64)
    expect(() =>
      validateObservationBinding(
        wrongEvalSetIdentity,
        evalSet,
        registry.sources[0],
        () => true,
      ),
    ).toThrow('PDF_BENCHMARK_OBSERVATION_EVAL_SET_MISMATCH')

    const pathLikeFailure = structuredClone(observations)
    pathLikeFailure.observations[0].firstFailureClass =
      '/Users/private-owner/source.pdf'
    expect(() =>
      validateObservationBinding(
        pathLikeFailure,
        evalSet,
        registry.sources[0],
        () => true,
      ),
    ).toThrow('INVALID_PDF_BENCHMARK_FAILURE_CLASS')
  })

  it('rejects document bindings that do not match source bytes', async () => {
    const registry = await readRegistry()
    registry.documentBindings[0].sourcePdfSha256 = '0'.repeat(64)

    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(registry),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_DOCUMENT_BINDING_MISMATCH')
  })

  it('rejects source-byte aliases and inconsistent metadata identities', () => {
    const document = {
      id: 'paper-a',
      sha256: 'a'.repeat(64),
      byteLength: 1024,
      pageCount: 10,
    }
    expect(() =>
      validateSourcePdfDocumentIdentities([
        document,
        { ...document, id: 'paper-alias' },
      ]),
    ).toThrow('PDF_BENCHMARK_SOURCE_PDF_ALIAS_COLLISION')
    expect(() =>
      validateSourcePdfDocumentIdentities([
        document,
        { ...document, pageCount: 11 },
      ]),
    ).toThrow('PDF_BENCHMARK_DOCUMENT_IDENTITY_COLLISION')
    expect(
      validateSourcePdfDocumentIdentities([document, { ...document }]).get(
        document.id,
      ),
    ).toBe(document.sha256)
  })

  it('requires two roster-bound source-only decisions for a template-family mapping', async () => {
    const registry = await readRegistry()
    const writeEvidence = await createEvidenceWriter()
    const binding = registry.documentBindings.find(
      (item) => item.documentId === '2210.06774v3',
    )
    const templateFamilyId = 'acl-two-column-v1'
    const reviewerA = 'template-reviewer-a'
    const reviewerB = 'template-reviewer-b'
    const identityA = await writeEvidence(
      'identity-a.json',
      reviewerIdentityEvidence(reviewerA, 'a'.repeat(64)),
    )
    const identityB = await writeEvidence(
      'identity-b.json',
      reviewerIdentityEvidence(reviewerB, 'b'.repeat(64)),
    )
    const decision = (reviewerId) => ({
      schemaVersion: '1.0.0',
      kind: 'pdf-template-family-assignment-review-evidence',
      documentId: binding.documentId,
      sourcePdfSha256: binding.sourcePdfSha256,
      templateFamilyId,
      reviewerId,
      method: 'source-template-structure-review',
      sourceOnly: true,
      decision: 'confirmed',
    })
    const decisionA = await writeEvidence(
      'decision-a.json',
      decision(reviewerA),
    )
    const decisionB = await writeEvidence(
      'decision-b.json',
      decision(reviewerB),
    )
    const assignment = (secondIdentity) => ({
      schemaVersion: '1.0.0',
      kind: 'pdf-template-family-assignment-evidence',
      documentId: binding.documentId,
      sourcePdfSha256: binding.sourcePdfSha256,
      templateFamilyId,
      method: 'source-template-structure-review',
      reviewers: [
        {
          reviewerId: reviewerA,
          identityEvidence: identityA,
          decisionEvidence: decisionA,
        },
        {
          reviewerId: reviewerB,
          identityEvidence: secondIdentity,
          decisionEvidence: decisionB,
        },
      ],
    })
    binding.templateFamilyId = templateFamilyId
    binding.templateFamilyEvidence = await writeEvidence(
      'assignment.json',
      assignment(identityB),
    )
    registry.splits.find(
      (split) => split.role === 'public-calibration',
    ).templateFamilyIds = [templateFamilyId]

    const receipt = await createPdfBenchmarkReadinessReceipt({
      registryPath: await writeRegistry(registry),
    })
    expect(receipt.inventory.verifiedSourceTemplateBindingCount).toBe(1)

    const duplicateSubjectIdentity = await writeEvidence(
      'identity-b-duplicate-subject.json',
      reviewerIdentityEvidence(reviewerB, 'a'.repeat(64)),
    )
    binding.templateFamilyEvidence = await writeEvidence(
      'assignment-duplicate-subject.json',
      assignment(duplicateSubjectIdentity),
    )
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(registry),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH')
  })

  it('rejects document leakage across public and blind splits', async () => {
    const registry = await readRegistry()
    const blind = registry.splits.find((split) => split.role === 'blind-test')
    blind.status = 'draft'
    blind.documentIds = ['2408.10903v5']
    const path = await writeRegistry(registry)

    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath: path }),
    ).rejects.toThrow('PDF_BENCHMARK_DOCUMENT_SPLIT_LEAKAGE')
  })

  it('rejects split documents that are not bound by a source', async () => {
    const registry = await readRegistry()
    const blind = registry.splits.find((split) => split.role === 'blind-test')
    blind.status = 'draft'
    blind.documentIds = ['phantom-private-document']
    const path = await writeRegistry(registry)

    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath: path }),
    ).rejects.toThrow('PDF_BENCHMARK_UNKNOWN_SPLIT_DOCUMENT')
  })

  it('binds frozen split identity to source bytes and verified template evidence', () => {
    const split = {
      id: 'blind-test',
      role: 'blind-test',
      status: 'frozen',
      labelVisibility: 'private',
      documentIds: ['blind-doc-1'],
      templateFamilyIds: ['blind-family-1'],
      frozenIdentitySha256: null,
    }
    const binding = {
      documentId: 'blind-doc-1',
      sourcePdfSha256: 'a'.repeat(64),
      templateFamilyId: 'blind-family-1',
      templateFamilyEvidenceSha256: 'b'.repeat(64),
    }
    const identity = createPdfBenchmarkSplitIdentitySha256(split, [binding])

    expect(identity).toMatch(/^[a-f0-9]{64}$/)
    expect(
      createPdfBenchmarkSplitIdentitySha256(split, [
        { ...binding, sourcePdfSha256: 'c'.repeat(64) },
      ]),
    ).not.toBe(identity)
    expect(
      createPdfBenchmarkSplitIdentitySha256(split, [
        { ...binding, templateFamilyEvidenceSha256: 'd'.repeat(64) },
      ]),
    ).not.toBe(identity)
  })

  it('rejects relabeling a public observation artifact as private', async () => {
    const registry = await readRegistry()
    registry.sources[0].labelVisibility = 'private'
    const path = await writeRegistry(registry)

    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: path,
      }),
    ).rejects.toThrow('PDF_BENCHMARK_OBSERVATION_POLICY_MISMATCH')
  })

  it('requires available metrics to have schema-valid, hash-bound files', async () => {
    const missingBinding = await readRegistry()
    const prose = missingBinding.metricImplementations.find(
      (metric) => metric.id === 'prose-transcript',
    )
    prose.status = 'available'
    const missingBindingPath = await writeRegistry(missingBinding)
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: missingBindingPath,
      }),
    ).rejects.toThrow('INVALID_PDF_BENCHMARK_REGISTRY')

    const wrongHash = await readRegistry()
    wrongHash.metricImplementations.find(
      (metric) => metric.id === 'package-integrity',
    ).implementationSha256 = '0'.repeat(64)
    const wrongHashPath = await writeRegistry(wrongHash)
    await expect(
      createPdfBenchmarkReadinessReceipt({ registryPath: wrongHashPath }),
    ).rejects.toThrow('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')

    const uncalibratedJudge = await readRegistry()
    const packageIntegrity = uncalibratedJudge.metricImplementations.find(
      (metric) => metric.id === 'package-integrity',
    )
    packageIntegrity.kind = 'calibrated-judge'
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(uncalibratedJudge),
      }),
    ).rejects.toThrow('INVALID_PDF_BENCHMARK_REGISTRY')

    const falseCalibration = await readRegistry()
    const falseJudge = falseCalibration.metricImplementations.find(
      (metric) => metric.id === 'package-integrity',
    )
    falseJudge.kind = 'calibrated-judge'
    falseJudge.calibration = {
      evidence: await fileBinding(
        'docs/schemas/pdf-benchmark-readiness-registry.schema.json',
      ),
      executionReceipt: await fileBinding(
        'benchmarks/pdf/reconstruction-eval-contract-v1.json',
      ),
    }
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(falseCalibration),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH')
  })

  it('binds judge calibration execution to a registered held-out split and confusion matrix', async () => {
    const registry = await readRegistry()
    const writeEvidence = await createEvidenceWriter()
    const documentBinding = registry.documentBindings.find(
      (item) => item.documentId === '2210.06774v3',
    )
    const templateFamilyId = 'held-out-family-v1'
    const reviewerA = 'held-out-template-reviewer-a'
    const reviewerB = 'held-out-template-reviewer-b'
    const identityA = await writeEvidence(
      'held-out-identity-a.json',
      reviewerIdentityEvidence(reviewerA, 'c'.repeat(64)),
    )
    const identityB = await writeEvidence(
      'held-out-identity-b.json',
      reviewerIdentityEvidence(reviewerB, 'd'.repeat(64)),
    )
    const templateDecision = (reviewerId) => ({
      schemaVersion: '1.0.0',
      kind: 'pdf-template-family-assignment-review-evidence',
      documentId: documentBinding.documentId,
      sourcePdfSha256: documentBinding.sourcePdfSha256,
      templateFamilyId,
      reviewerId,
      method: 'source-template-structure-review',
      sourceOnly: true,
      decision: 'confirmed',
    })
    const decisionA = await writeEvidence(
      'held-out-decision-a.json',
      templateDecision(reviewerA),
    )
    const decisionB = await writeEvidence(
      'held-out-decision-b.json',
      templateDecision(reviewerB),
    )
    const assignmentEvidence = await writeEvidence('held-out-assignment.json', {
      schemaVersion: '1.0.0',
      kind: 'pdf-template-family-assignment-evidence',
      documentId: documentBinding.documentId,
      sourcePdfSha256: documentBinding.sourcePdfSha256,
      templateFamilyId,
      method: 'source-template-structure-review',
      reviewers: [
        {
          reviewerId: reviewerA,
          identityEvidence: identityA,
          decisionEvidence: decisionA,
        },
        {
          reviewerId: reviewerB,
          identityEvidence: identityB,
          decisionEvidence: decisionB,
        },
      ],
    })
    documentBinding.templateFamilyId = templateFamilyId
    documentBinding.templateFamilyEvidence = assignmentEvidence

    const publicSplit = registry.splits.find(
      (split) => split.role === 'public-calibration',
    )
    publicSplit.documentIds = publicSplit.documentIds.filter(
      (documentId) => documentId !== documentBinding.documentId,
    )
    const developmentSplit = registry.splits.find(
      (split) => split.role === 'development',
    )
    developmentSplit.status = 'frozen'
    developmentSplit.documentIds = [documentBinding.documentId]
    developmentSplit.templateFamilyIds = [templateFamilyId]
    developmentSplit.frozenIdentitySha256 =
      createPdfBenchmarkSplitIdentitySha256(developmentSplit, [
        {
          documentId: documentBinding.documentId,
          sourcePdfSha256: documentBinding.sourcePdfSha256,
          templateFamilyId,
          templateFamilyEvidenceSha256: assignmentEvidence.fileSha256,
        },
      ])

    const metric = registry.metricImplementations.find(
      (item) => item.id === 'package-integrity',
    )
    metric.kind = 'calibrated-judge'
    const confusionMatrix = {
      truePositive: 45,
      falseNegative: 5,
      trueNegative: 42,
      falsePositive: 8,
    }
    const calibrationEvidenceValue = {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-judge-calibration-evidence',
      metricId: metric.id,
      implementationSha256: metric.implementationSha256,
      heldOutSplitIdentitySha256: developmentSplit.frozenIdentitySha256,
      confusionMatrix,
    }
    const calibrationEvidence = await writeEvidence(
      'judge-calibration.json',
      calibrationEvidenceValue,
    )
    const outputIdentitySha256 = createHash('sha256')
      .update(
        canonicalJson({
          kind: 'pdf-benchmark-judge-calibration-output-v1',
          metricId: metric.id,
          implementationSha256: metric.implementationSha256,
          heldOutSplitIdentitySha256: developmentSplit.frozenIdentitySha256,
          confusionMatrix,
        }),
      )
      .digest('hex')
    const executionReceiptValue = {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-judge-calibration-execution-receipt',
      metricId: metric.id,
      implementationSha256: metric.implementationSha256,
      calibrationEvidenceFileSha256: calibrationEvidence.fileSha256,
      inputIdentitySha256: developmentSplit.frozenIdentitySha256,
      outputIdentitySha256,
      status: 'passed',
    }
    metric.calibration = {
      evidence: calibrationEvidence,
      executionReceipt: await writeEvidence(
        'judge-execution.json',
        executionReceiptValue,
      ),
    }

    const receipt = await createPdfBenchmarkReadinessReceipt({
      registryPath: await writeRegistry(registry),
    })
    expect(
      receipt.criteria.find((criterion) => criterion.id === 'metric-coverage')
        .observed,
    ).toContain('package-integrity')

    metric.calibration.executionReceipt = await writeEvidence(
      'judge-execution-wrong-input.json',
      { ...executionReceiptValue, inputIdentitySha256: '0'.repeat(64) },
    )
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(registry),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH')
  })

  it('requires distinct reviewer identities and bound review evidence artifacts', async () => {
    const registry = await readRegistry()
    const bindings = await Promise.all([
      fileBinding('tools/pdf-private-fidelity.mjs'),
      fileBinding('tools/pdf-private-fidelity.test.mjs'),
      fileBinding('tools/pdf-fidelity-eval.mjs'),
      fileBinding('tools/pdf-fidelity-eval.test.mjs'),
    ])
    registry.reviewBundles = [
      {
        caseId: '2408.10903v5.p001.title-single-canonical-occurrence',
        protocolVersion: 'source-review-v1',
        sourceOnly: true,
        candidateOutputConsultedForLabel: false,
        reviewers: [
          {
            reviewerId: 'reviewer-a',
            identityEvidence: bindings[0],
            decisionEvidence: bindings[1],
          },
          {
            reviewerId: 'reviewer-a',
            identityEvidence: bindings[2],
            decisionEvidence: bindings[3],
          },
        ],
        disagreement: false,
        adjudication: null,
        uncertainty: 'none',
        selectionProvenance: {
          mode: 'random',
          motivatingCandidateIdentitySha256: null,
          selectedBeforeCandidateRun: true,
        },
      },
    ]
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(registry),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')

    registry.reviewBundles[0].reviewers[1].reviewerId = 'reviewer-b'
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(registry),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_REVIEW_EVIDENCE_MISMATCH')
  })

  it('keeps roster identities consistent across independently reviewed cases', async () => {
    const registry = await readRegistry()
    const writeEvidence = await createEvidenceWriter()
    const reviewerA = 'case-reviewer-a'
    const reviewerB = 'case-reviewer-b'
    const identityA = await writeEvidence(
      'case-identity-a.json',
      reviewerIdentityEvidence(reviewerA, 'e'.repeat(64)),
    )
    const identityB = await writeEvidence(
      'case-identity-b.json',
      reviewerIdentityEvidence(reviewerB, 'f'.repeat(64)),
    )
    const caseIds = [
      '2408.10903v5.p001.title-single-canonical-occurrence',
      '2412.13575v1.p001.figure-1-complete-boundary',
    ]
    const protocolVersion = 'source-review-v1'
    const makeDecision = (caseId, reviewerId) => ({
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-initial-review-decision-evidence',
      caseId,
      reviewerId,
      protocolVersion,
      sourceOnly: true,
      candidateOutputConsultedForLabel: false,
      decisionSha256: '1'.repeat(64),
    })
    registry.reviewBundles = []
    for (const [caseIndex, caseId] of caseIds.entries()) {
      const decisionA = await writeEvidence(
        `case-${caseIndex}-decision-a.json`,
        makeDecision(caseId, reviewerA),
      )
      const decisionB = await writeEvidence(
        `case-${caseIndex}-decision-b.json`,
        makeDecision(caseId, reviewerB),
      )
      registry.reviewBundles.push({
        caseId,
        protocolVersion,
        sourceOnly: true,
        candidateOutputConsultedForLabel: false,
        reviewers: [
          {
            reviewerId: reviewerA,
            identityEvidence: identityA,
            decisionEvidence: decisionA,
          },
          {
            reviewerId: reviewerB,
            identityEvidence: identityB,
            decisionEvidence: decisionB,
          },
        ],
        disagreement: false,
        adjudication: null,
        uncertainty: 'none',
        selectionProvenance: {
          mode: 'random',
          motivatingCandidateIdentitySha256: null,
          selectedBeforeCandidateRun: true,
        },
      })
    }

    const receipt = await createPdfBenchmarkReadinessReceipt({
      registryPath: await writeRegistry(registry),
    })
    expect(
      receipt.criteria.find(
        (criterion) => criterion.id === 'independent-review-coverage',
      ).observed,
    ).toBe(2)

    registry.reviewBundles[1].reviewers[0].identityEvidence =
      await writeEvidence(
        'case-identity-a-inconsistent.json',
        reviewerIdentityEvidence(reviewerA, '2'.repeat(64)),
      )
    await expect(
      createPdfBenchmarkReadinessReceipt({
        registryPath: await writeRegistry(registry),
      }),
    ).rejects.toThrow('PDF_BENCHMARK_REVIEW_IDENTITY_INCONSISTENCY')
  })

  it('requires all seven candidate artifacts, including runtime, and a receipt bound to the blind split', async () => {
    const writeEvidence = await createEvidenceWriter()
    const componentPaths = [
      'tools/pdf-private-fidelity.mjs',
      'tools/pdf-private-fidelity.test.mjs',
      'tools/pdf-fidelity-eval.mjs',
      'tools/pdf-fidelity-eval.test.mjs',
      'docs/schemas/pdf-benchmark-readiness-registry.schema.json',
      'benchmarks/pdf/reconstruction-eval-contract-v1.json',
      'docs/schemas/pdf-fidelity-eval-observations.schema.json',
    ]
    const componentKinds = [
      'provider',
      'model',
      'adapter',
      'prompt',
      'config',
      'seed',
      'runtime',
    ]
    const components = await Promise.all(
      componentPaths.map(async (path, index) => ({
        kind: componentKinds[index],
        id: `${componentKinds[index]}-fixture`,
        version: '1',
        artifact: await fileBinding(path),
      })),
    )
    const blindSplitIdentitySha256 = 'a'.repeat(64)
    const componentCommitmentSha256 = createHash('sha256')
      .update(
        canonicalJson({
          kind: 'pdf-benchmark-candidate-component-commitment-v1',
          components: components
            .map((component) => ({
              kind: component.kind,
              id: component.id,
              version: component.version,
              artifactFileSha256: component.artifact.fileSha256,
            }))
            .sort((left, right) => left.kind.localeCompare(right.kind)),
        }),
      )
      .digest('hex')
    const authorityId = 'independent-custodian-a'
    const authorityEvidence = await writeEvidence('custodian.json', {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-custodian-authority-evidence',
      authorityId,
      authorityRole: 'independent-benchmark-custodian',
      authorizationScope:
        'witness-candidate-freeze-before-private-label-reveal',
      subjectIdentitySha256: 'b'.repeat(64),
    })
    const commitmentReceipt = await writeEvidence('candidate-freeze.json', {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-candidate-freeze-receipt',
      candidateComponentCommitmentSha256: componentCommitmentSha256,
      blindSplitIdentitySha256,
      labelStateAtCommitment: 'private-labels-withheld',
      authorityId,
      authorityEvidenceFileSha256: authorityEvidence.fileSha256,
    })
    const registry = {
      candidateCommitment: {
        status: 'frozen',
        components,
        authorityEvidence,
        commitmentReceipt,
        blindSplitIdentitySha256,
        committedBeforePrivateLabelReveal: true,
      },
      splits: [
        {
          role: 'blind-test',
          status: 'frozen',
          frozenIdentitySha256: blindSplitIdentitySha256,
        },
      ],
    }

    await expect(validateCandidateCommitment(registry)).resolves.toEqual({
      verified: true,
      componentCommitmentSha256,
    })
    registry.candidateCommitment.components.pop()
    await expect(validateCandidateCommitment(registry)).rejects.toThrow(
      'PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH',
    )
  })

  it('requires an external isolation identity and execution receipt bound to the candidate and blind split', async () => {
    const writeEvidence = await createEvidenceWriter()
    const blindSplitIdentitySha256 = 'c'.repeat(64)
    const componentCommitmentSha256 = 'd'.repeat(64)
    const attestorId = 'independent-isolation-attestor-a'
    const attestorIdentity = await writeEvidence('isolation-attestor.json', {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-isolation-attestor-identity-evidence',
      attestorId,
      identityAuthority: 'verified-independent-isolation-attestor-roster',
      subjectIdentitySha256: 'e'.repeat(64),
    })
    const executionReceiptValue = {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-independent-isolation-execution-receipt',
      trackId: 'end-to-end-blind',
      attestorId,
      attestorIdentityEvidenceFileSha256: attestorIdentity.fileSha256,
      blindSplitIdentitySha256,
      candidateComponentCommitmentSha256: componentCommitmentSha256,
      networkIsolation: 'independently-enforced',
      filesystemIsolation: 'independently-enforced',
      runnerIdentitySha256: 'f'.repeat(64),
      executionIdentitySha256: '1'.repeat(64),
      status: 'passed',
    }
    const registry = {
      tracks: {
        endToEndBlind: {
          status: 'frozen',
          promotionAuthority: true,
          networkIsolation: 'independently-enforced',
          filesystemIsolation: 'independently-enforced',
          isolationEvidence: {
            attestorIdentity,
            executionReceipt: await writeEvidence(
              'isolation-execution.json',
              executionReceiptValue,
            ),
          },
        },
      },
      splits: [
        {
          role: 'blind-test',
          status: 'frozen',
          frozenIdentitySha256: blindSplitIdentitySha256,
        },
      ],
    }
    const candidateCommitment = {
      verified: true,
      componentCommitmentSha256,
    }

    await expect(
      validateIndependentIsolationEvidence(registry, candidateCommitment),
    ).resolves.toBe(true)

    registry.tracks.endToEndBlind.isolationEvidence.executionReceipt =
      await writeEvidence('isolation-execution-wrong-candidate.json', {
        ...executionReceiptValue,
        candidateComponentCommitmentSha256: '2'.repeat(64),
      })
    await expect(
      validateIndependentIsolationEvidence(registry, candidateCommitment),
    ).rejects.toThrow('PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH')

    registry.tracks.endToEndBlind.isolationEvidence = null
    await expect(
      validateIndependentIsolationEvidence(registry, candidateCommitment),
    ).resolves.toBe(false)
  })

  it('keeps promotion closed even when every represented v1 criterion is prevalidated', async () => {
    const registry = await readRegistry()
    const train = registry.splits.find((split) => split.role === 'train')
    train.status = 'frozen'
    train.documentIds = Array.from(
      { length: 6 },
      (_, index) => `train-doc-${index + 1}`,
    )
    train.templateFamilyIds = Array.from(
      { length: 6 },
      (_, index) => `train-family-${index + 1}`,
    )
    const development = registry.splits.find(
      (split) => split.role === 'development',
    )
    development.status = 'frozen'
    development.documentIds = Array.from(
      { length: 5 },
      (_, index) => `development-doc-${index + 1}`,
    )
    development.templateFamilyIds = Array.from(
      { length: 5 },
      (_, index) => `development-family-${index + 1}`,
    )
    const blind = registry.splits.find((split) => split.role === 'blind-test')
    blind.status = 'frozen'
    blind.labelVisibility = 'private'
    blind.documentIds = Array.from(
      { length: 10 },
      (_, index) => `blind-doc-${index + 1}`,
    )
    blind.templateFamilyIds = Array.from(
      { length: 10 },
      (_, index) => `blind-family-${index + 1}`,
    )
    const boundDocumentIds = registry.splits.flatMap(
      (split) => split.documentIds,
    )
    const verifiedBindings = boundDocumentIds.map((documentId, index) => ({
      documentId,
      sourcePdfSha256: index.toString(16).padStart(64, '0'),
      templateFamilyId:
        registry.splits
          .find((split) => split.documentIds.includes(documentId))
          ?.templateFamilyIds.at(
            registry.splits
              .find((split) => split.documentIds.includes(documentId))
              .documentIds.indexOf(documentId),
          ) ?? `public-family-${index + 1}`,
      templateFamilyEvidenceSha256: (index + 100)
        .toString(16)
        .padStart(64, '0'),
    }))
    blind.frozenIdentitySha256 = createPdfBenchmarkSplitIdentitySha256(
      blind,
      verifiedBindings,
    )
    train.frozenIdentitySha256 = createPdfBenchmarkSplitIdentitySha256(
      train,
      verifiedBindings,
    )
    development.frozenIdentitySha256 = createPdfBenchmarkSplitIdentitySha256(
      development,
      verifiedBindings,
    )
    registry.tracks.endToEndBlind.status = 'frozen'
    registry.tracks.endToEndBlind.promotionAuthority = true
    registry.tracks.endToEndBlind.networkIsolation = 'independently-enforced'
    registry.tracks.endToEndBlind.filesystemIsolation = 'independently-enforced'
    registry.discoveryOrder.status = 'recorded'
    registry.discoveryOrder.caseIds = Array.from(
      { length: 100 },
      (_, index) => `case-${index + 1}`,
    )
    registry.candidateCommitment.status = 'frozen'
    registry.candidateCommitment.committedBeforePrivateLabelReveal = true
    for (const metric of registry.metricImplementations) {
      metric.status = 'available'
    }

    const inventory = {
      caseCount: 100,
      documentCount: 25,
      failureClassCount: 13,
      failureClassCounts: {},
      finalNoNewClassWindow: 20,
      documentDisjoint: true,
      templateFamilyDisjoint: true,
      splitIdentitySha256s: {
        train: train.frozenIdentitySha256,
        development: development.frozenIdentitySha256,
        'blind-test': blind.frozenIdentitySha256,
      },
    }
    const evidence = {
      boundDocumentIds,
      verifiedMetricIds: registry.metricImplementations.map(
        (metric) => metric.id,
      ),
      validatedReviewCaseIds: registry.discoveryOrder.caseIds,
      verifiedSourceTemplateDocumentIds: boundDocumentIds,
      blindSourcePolicyVerified: true,
      candidateCommitmentVerified: true,
      independentIsolationEvidenceVerified: true,
    }
    const assessment = assessPdfBenchmarkReadiness(
      registry,
      inventory,
      evidence,
    )

    expect(assessment.ready).toBe(false)
    expect(assessment.gaps).toEqual([
      'native-reader-exact-artifact-coverage',
      'promotion-protocol-implementation',
    ])
    expect(
      assessment.criteria
        .filter(
          (item) =>
            item.id !== 'native-reader-exact-artifact-coverage' &&
            item.id !== 'promotion-protocol-implementation',
        )
        .every((item) => item.passed),
    ).toBe(true)

    const unverifiedMetrics = assessPdfBenchmarkReadiness(registry, inventory, {
      ...evidence,
      verifiedMetricIds: [],
    })
    expect(unverifiedMetrics.gaps).toEqual([
      'metric-coverage',
      'native-reader-exact-artifact-coverage',
      'promotion-protocol-implementation',
    ])

    expect(
      assessPdfBenchmarkReadiness(registry, inventory, {
        ...evidence,
        blindSourcePolicyVerified: false,
      }).gaps,
    ).toEqual([
      'blind-split-frozen',
      'native-reader-exact-artifact-coverage',
      'promotion-protocol-implementation',
    ])

    registry.tracks.endToEndBlind.promotionAuthority = false
    expect(
      assessPdfBenchmarkReadiness(registry, inventory, evidence).gaps,
    ).toEqual([
      'target-free-end-to-end-track',
      'native-reader-exact-artifact-coverage',
      'promotion-protocol-implementation',
    ])
    registry.tracks.endToEndBlind.promotionAuthority = true
    registry.tracks.endToEndBlind.networkIsolation = 'cooperative-offline-flags'
    expect(
      assessPdfBenchmarkReadiness(registry, inventory, evidence).gaps,
    ).toEqual([
      'target-free-end-to-end-track',
      'native-reader-exact-artifact-coverage',
      'promotion-protocol-implementation',
    ])
  })

  it('requires hash-bound exact-artifact receipts from all required native readers', async () => {
    const writeEvidence = await createEvidenceWriter()
    const exactEpubArtifact = await writeEvidence(
      'exact-artifact.epub',
      zipSync({
        mimetype: [strToU8('application/epub+zip'), { level: 0 }],
        'META-INF/container.xml': strToU8(
          '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
        ),
        'EPUB/package.opf': strToU8(
          '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:fixture</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="content"/></spine></package>',
        ),
        'EPUB/nav.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="content.xhtml">Fixture</a></li></ol></nav></body></html>',
        ),
        'EPUB/content.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body><p>Fixture</p></body></html>',
        ),
      }),
    )
    const exactArtifactSha256 = exactEpubArtifact.fileSha256
    const exportReceipt = {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-exact-epub-export-receipt',
      exactArtifactSha256,
      status: 'passed',
    }
    const exportReceiptIdentitySha256 = createHash('sha256')
      .update(canonicalJson(exportReceipt))
      .digest('hex')
    const exportReceiptEvidence = await writeEvidence(
      'export-receipt.json',
      exportReceipt,
    )
    const toolchainManifest = await fileBinding(
      'src/publication/toolchain-manifest.json',
    )
    const toolchain = JSON.parse(
      await readFile('src/publication/toolchain-manifest.json', 'utf8'),
    )
    const checkerIdentitySha256 = toolchain.epubcheck.sha256
    const checkerVersion = toolchain.epubcheck.version
    const epubCheckInputIdentitySha256 = createHash('sha256')
      .update(
        canonicalJson({
          kind: 'pdf-benchmark-epubcheck-input-v1',
          exactArtifactSha256,
          checkerIdentitySha256,
          checkerVersion,
        }),
      )
      .digest('hex')
    const epubCheckTranscript = {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-epubcheck-execution-transcript',
      command: 'epubcheck',
      exactArtifactSha256,
      checkerIdentitySha256,
      checkerVersion,
      exitCode: 0,
      epubCheckStatus: 'passed',
      stdoutSha256: 'b'.repeat(64),
      stderrSha256: 'c'.repeat(64),
    }
    const epubCheckOutputIdentitySha256 = createHash('sha256')
      .update(canonicalJson(epubCheckTranscript))
      .digest('hex')
    const epubCheckReceipt = {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-epubcheck-execution-receipt',
      exactArtifactSha256,
      toolchainManifestFileSha256: toolchainManifest.fileSha256,
      checkerIdentitySha256,
      checkerVersion,
      epubCheckTranscriptEvidenceFileSha256: null,
      inputIdentitySha256: epubCheckInputIdentitySha256,
      outputIdentitySha256: epubCheckOutputIdentitySha256,
      status: 'passed',
    }
    const epubCheckTranscriptEvidence = await writeEvidence(
      'epubcheck-transcript.json',
      epubCheckTranscript,
    )
    epubCheckReceipt.epubCheckTranscriptEvidenceFileSha256 =
      epubCheckTranscriptEvidence.fileSha256
    const epubCheckReceiptEvidence = await writeEvidence(
      'epubcheck-receipt.json',
      epubCheckReceipt,
    )
    const exportEvidence = await writeEvidence('export-evidence.json', {
      schemaVersion: '1.0.0',
      kind: 'pdf-benchmark-exact-epub-export-evidence',
      epubArtifact: exactEpubArtifact,
      exactArtifactSha256,
      exportReceipt: exportReceiptEvidence,
      exportReceiptIdentitySha256,
      toolchainManifest,
      epubCheckReceipt: epubCheckReceiptEvidence,
      epubCheckTranscript: epubCheckTranscriptEvidence,
      status: 'passed',
    })
    const writeCompleteExportEvidence = (name, overrides = {}) =>
      writeEvidence(name, {
        schemaVersion: '1.0.0',
        kind: 'pdf-benchmark-exact-epub-export-evidence',
        epubArtifact: exactEpubArtifact,
        exactArtifactSha256,
        exportReceipt: exportReceiptEvidence,
        exportReceiptIdentitySha256,
        toolchainManifest,
        epubCheckReceipt: epubCheckReceiptEvidence,
        epubCheckTranscript: epubCheckTranscriptEvidence,
        status: 'passed',
        ...overrides,
      })
    const readerReceipts = await Promise.all(
      [
        ['apple-books', 'apple-books'],
        ['independent-desktop-epub-reader', 'independent-desktop-epub-reader'],
        ['target-eink-reader-device', 'target-eink-reader-device'],
      ].map(async ([readerId, readerType], index) => {
        const readerIdentity = await writeEvidence(
          `${readerId}-identity.json`,
          {
            schemaVersion: '1.0.0',
            kind: 'pdf-benchmark-native-reader-identity-evidence',
            readerId,
            readerType,
            readerIdentitySha256: (index + 4).toString(16).repeat(64),
            status: 'passed',
          },
        )
        return {
          readerId,
          readerType,
          readerIdentity,
          executionReceipt: await writeEvidence(`${readerId}.json`, {
            schemaVersion: '1.0.0',
            kind: 'pdf-benchmark-native-reader-execution-receipt',
            readerId,
            readerType,
            readerIdentityEvidenceFileSha256: readerIdentity.fileSha256,
            exportEvidenceFileSha256: exportEvidence.fileSha256,
            exportReceiptEvidenceFileSha256: exportReceiptEvidence.fileSha256,
            exportReceiptIdentitySha256,
            epubCheckReceiptEvidenceFileSha256:
              epubCheckReceiptEvidence.fileSha256,
            toolchainManifestFileSha256: toolchainManifest.fileSha256,
            epubCheckTranscriptEvidenceFileSha256:
              epubCheckTranscriptEvidence.fileSha256,
            exactArtifactSha256,
            executionIdentitySha256: (index + 1).toString(16).repeat(64),
            status: 'passed',
          }),
        }
      }),
    )
    const nativeReaderEvidence = Object.fromEntries(
      readerReceipts.map(({ readerId, readerIdentity, executionReceipt }) => [
        readerId,
        {
          status: 'passed',
          readerIdentity,
          executionReceipt,
        },
      ]),
    )
    nativeReaderEvidence.exportEvidence = exportEvidence

    await expect(
      validateNativeReaderEvidence(nativeReaderEvidence),
    ).resolves.toEqual({
      exactArtifactSha256,
      structurallyValidatedReaderIds: [
        'apple-books',
        'independent-desktop-epub-reader',
        'target-eink-reader-device',
      ],
      trustedAttestationVerified: false,
      trustedAttestationReason: 'trusted-attestation-verifier-not-implemented',
      verifiedReaderIds: [],
    })

    const populatedRegistry = await readRegistry()
    populatedRegistry.nativeReaderEvidence = nativeReaderEvidence
    const populatedReceipt = await createPdfBenchmarkReadinessReceipt({
      registryPath: await writeRegistry(populatedRegistry),
    })
    const nativeReaderSummary = {
      exactArtifactSha256,
      structurallyValidatedReaderIds: [
        'apple-books',
        'independent-desktop-epub-reader',
        'target-eink-reader-device',
      ],
      trustedAttestationVerified: false,
      trustedAttestationReason: 'trusted-attestation-verifier-not-implemented',
      verifiedReaderIds: [],
    }
    expect(populatedReceipt.nativeReaderEvidence).toEqual(nativeReaderSummary)
    expect(
      populatedReceipt.criteria.find(
        ({ id }) => id === 'native-reader-exact-artifact-coverage',
      ).observed,
    ).toEqual(nativeReaderSummary)
    const serializedReceipt = JSON.stringify(populatedReceipt)
    expect(serializedReceipt).not.toContain(exportEvidence.path)
    for (const { readerIdentity, executionReceipt } of readerReceipts) {
      expect(serializedReceipt).not.toContain(readerIdentity.path)
      expect(serializedReceipt).not.toContain(executionReceipt.path)
    }

    const unavailable = structuredClone(nativeReaderEvidence)
    unavailable['apple-books'] = {
      status: 'unavailable-blocker',
      readerIdentity: null,
      executionReceipt: null,
    }
    await expect(validateNativeReaderEvidence(unavailable)).resolves.toEqual({
      exactArtifactSha256,
      structurallyValidatedReaderIds: [
        'independent-desktop-epub-reader',
        'target-eink-reader-device',
      ],
      trustedAttestationVerified: false,
      trustedAttestationReason: 'trusted-attestation-verifier-not-implemented',
      verifiedReaderIds: [],
    })

    const browserSubstitution = structuredClone(nativeReaderEvidence)
    const appleBooksExecutionReceipt = JSON.parse(
      await readFile(
        nativeReaderEvidence['apple-books'].executionReceipt.path,
        'utf8',
      ),
    )
    browserSubstitution['apple-books'].executionReceipt = await writeEvidence(
      'browser-substitution.json',
      {
        ...appleBooksExecutionReceipt,
        readerType: 'chromium',
      },
    )
    await expect(
      validateNativeReaderEvidence(browserSubstitution),
    ).rejects.toThrow('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')

    const arbitrarySharedClaim = structuredClone(nativeReaderEvidence)
    for (const readerId of [
      'apple-books',
      'independent-desktop-epub-reader',
      'target-eink-reader-device',
    ]) {
      const executionReceipt = JSON.parse(
        await readFile(
          nativeReaderEvidence[readerId].executionReceipt.path,
          'utf8',
        ),
      )
      arbitrarySharedClaim[readerId].executionReceipt = await writeEvidence(
        `${readerId}-arbitrary-claim.json`,
        {
          ...executionReceipt,
          exactArtifactSha256: 'e'.repeat(64),
        },
      )
    }
    await expect(
      validateNativeReaderEvidence(arbitrarySharedClaim),
    ).rejects.toThrow('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')

    const unboundIdentity = structuredClone(nativeReaderEvidence)
    const unboundIdentityReceipt = JSON.parse(
      await readFile(
        nativeReaderEvidence['apple-books'].executionReceipt.path,
        'utf8',
      ),
    )
    unboundIdentity['apple-books'].executionReceipt = await writeEvidence(
      'unbound-identity.json',
      {
        ...unboundIdentityReceipt,
        readerIdentityEvidenceFileSha256: '0'.repeat(64),
      },
    )
    await expect(validateNativeReaderEvidence(unboundIdentity)).rejects.toThrow(
      'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
    )

    const renamedJsonArtifact = await writeEvidence('renamed-json.epub', {
      not: 'an epub archive',
    })
    const malformedArtifactEvidence = await writeCompleteExportEvidence(
      'malformed-artifact-export-evidence.json',
      {
        epubArtifact: renamedJsonArtifact,
        exactArtifactSha256: renamedJsonArtifact.fileSha256,
      },
    )
    const malformedArtifact = structuredClone(nativeReaderEvidence)
    malformedArtifact.exportEvidence = malformedArtifactEvidence
    await expect(
      validateNativeReaderEvidence(malformedArtifact),
    ).rejects.toThrow('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')

    const missingEpubCheck = structuredClone(nativeReaderEvidence)
    missingEpubCheck.exportEvidence = await writeCompleteExportEvidence(
      'missing-epubcheck-export-evidence.json',
      {
        epubCheckReceipt: null,
      },
    )
    await expect(
      validateNativeReaderEvidence(missingEpubCheck),
    ).rejects.toThrow('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')

    for (const [name, value] of [
      ['forged', { ...epubCheckReceipt, outputIdentitySha256: '0'.repeat(64) }],
      [
        'mismatched',
        { ...epubCheckReceipt, exactArtifactSha256: 'b'.repeat(64) },
      ],
      ['failed', { ...epubCheckReceipt, status: 'failed' }],
    ]) {
      const receipt = await writeEvidence(`epubcheck-${name}.json`, value)
      const rejected = structuredClone(nativeReaderEvidence)
      rejected.exportEvidence = await writeCompleteExportEvidence(
        `epubcheck-${name}-export-evidence.json`,
        { epubCheckReceipt: receipt },
      )
      await expect(validateNativeReaderEvidence(rejected)).rejects.toThrow(
        'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
      )
    }
  }, 30_000)

  it('emits only a stable error code when CLI inputs fail', () => {
    const result = spawnSync(
      process.execPath,
      [
        readinessToolPath,
        '--registry',
        '/Users/private-user/secret-registry.json',
      ],
      { encoding: 'utf8' },
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('PDF_BENCHMARK_READINESS_FAILED\n')
    expect(result.stderr).not.toContain('private-user')
  })
})
