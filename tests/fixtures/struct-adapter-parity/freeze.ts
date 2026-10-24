import { mkdir, writeFile } from 'node:fs/promises'
import { adapterCases, reconstructAdapterCase } from './cases'
import { encodeReconstruction, observeAdapterCase } from './observe'

export async function freezeAdapterFixtures() {
  const expected: Record<string, unknown> = {}
  await mkdir(new URL('./reconstructions/', import.meta.url), {
    recursive: true,
  })

  for (const name of adapterCases) {
    const reconstruction = await reconstructAdapterCase(name)
    await writeFile(
      new URL(`./reconstructions/${name}.json`, import.meta.url),
      `${encodeReconstruction(reconstruction)}\n`,
    )
    expected[name] = await observeAdapterCase(reconstruction)
    console.log(`froze ${name}`)
  }

  await writeFile(
    new URL('./expected.json', import.meta.url),
    `${JSON.stringify(expected, null, 2)}\n`,
  )
}
