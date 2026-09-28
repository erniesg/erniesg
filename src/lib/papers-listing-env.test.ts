import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { papersListingEnv } from './papers-listing-env'

describe('the papers listing env the Astro config reads', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('reads an override that lives only in a .env file, as pages do', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'papers-env-'))
    await writeFile(path.join(root, '.env'), 'PUBLIC_PAPERS_LISTING=unlisted\n')

    expect(papersListingEnv('production', root, {})).toMatchObject({
      PUBLIC_PAPERS_LISTING: 'unlisted',
    })
  })

  it('lets the invoking shell win over a .env file, as Vite does', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'papers-env-'))
    await writeFile(path.join(root, '.env'), 'PUBLIC_PAPERS_LISTING=unlisted\n')

    expect(
      papersListingEnv('production', root, { PUBLIC_PAPERS_LISTING: 'listed' }),
    ).toMatchObject({ PUBLIC_PAPERS_LISTING: 'listed' })
  })

  it('marks a dev server as DEV, so the default matches the nav', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'papers-env-'))

    expect(papersListingEnv('development', root, {}).DEV).toBe(true)
    expect(papersListingEnv('production', root, {}).DEV).toBe(false)
  })
})
