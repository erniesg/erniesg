import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  validatePublicationSourceResult,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from '../source-adapter'
import { readStructPackagePin } from '../struct-package-pin'
import { structCutoverSourceBinding } from '../struct-source-binding'
import { adaptStructDocument } from '../struct-adapter'
import {
  buildAstroStructDocument,
  type AstroSourceLocator,
} from '../../struct-adapters/from-markdown'

export type { AstroSourceLocator }

/**
 * The Astro publication adapter.
 *
 * The adapter owns no parsing and no semantic model of its own any more: the
 * app-owned MDX ingress conversion produces one `StructDocument`, and the
 * one-way projection turns that document into the ephemeral renderer plan.
 * The source identity of the result is the Struct binding, computed from the
 * bytes this invocation produced.
 */
export async function adaptAstroBlogEntry(
  locator: AstroSourceLocator,
): Promise<PublicationSourceResult> {
  const conversion = await buildAstroStructDocument(locator)
  const projected = adaptStructDocument(conversion.document)
  const contentRoot = resolve(locator.contentRoot ?? 'src/content/blog')
  const entryDirectory = resolve(contentRoot, locator.entryId)
  const translations = (await readdir(entryDirectory))
    .filter((name) => /^(?:zh|ko|ja)\.mdx$/.test(name))
    .sort()
  const pin = await readStructPackagePin()
  const sourceBinding = await structCutoverSourceBinding(
    conversion.document,
    pin,
  )
  return validatePublicationSourceResult({
    ...projected,
    diagnostics: [
      ...translations.map((name) => ({
        severity: 'info' as const,
        code: 'translation-sibling',
        message: `Resolved local translation sibling ${name}`,
        sourceId: conversion.sourceId,
      })),
      ...conversion.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        sourceId: conversion.sourceId,
      })),
      ...projected.diagnostics,
    ],
    provenance: {
      adapterId: 'astro',
      adapterVersion: PUBLICATION_SOURCE_ADAPTER_VERSION,
      sourceType: 'astro',
      sourceId: conversion.sourceId,
      sourceRevision: conversion.sourceRevision,
    },
    structDocument: conversion.document,
    sourceBinding,
  })
}

export const astroPublicationAdapter: PublicationSourceAdapter<AstroSourceLocator> =
  {
    id: 'astro',
    version: PUBLICATION_SOURCE_ADAPTER_VERSION,
    adapt: adaptAstroBlogEntry,
  }
