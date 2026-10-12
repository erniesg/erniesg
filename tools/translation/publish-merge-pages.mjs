import fs from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

export function mergePageLocaleCatalogs(base, catalogs) {
  const result = structuredClone(base)
  result.translations ??= {}
  for (const locale of ['zh', 'ja', 'ko']) {
    const generated = catalogs[locale]
    if (!generated) throw new Error(`Missing ${locale} catalog`)
    const memory = generated.translations?.[locale] ?? {}
    for (const [key, entry] of Object.entries(
      base.translations?.[locale] ?? {},
    )) {
      if (
        entry.status !== 'machine' &&
        JSON.stringify(memory[key]) !== JSON.stringify(entry)
      ) {
        throw new Error(
          `Protected ${locale} translation memory changed: ${key}`,
        )
      }
    }
    result.translations[locale] = memory
    for (const [route, page] of Object.entries(result.pages)) {
      const incoming = generated.pages?.[route]
      if (incoming?.sourceHash !== page.sourceHash)
        throw new Error(`Changed ${locale} source: ${route}`)
      const entry = incoming.locales?.[locale]
      if (!entry) throw new Error(`Missing ${locale} page: ${route}`)
      const previous = base.pages[route].locales?.[locale]
      if (
        previous &&
        previous.status !== 'machine' &&
        JSON.stringify(previous) !== JSON.stringify(entry)
      ) {
        throw new Error(`Protected ${locale} page changed: ${route}`)
      }
      page.locales ??= {}
      page.locales[locale] = entry
    }
  }
  return result
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      'locale-catalogs': { type: 'string' },
    },
  })
  const paths = values['locale-catalogs']?.split(',')
  if (!values.base || paths?.length !== 3)
    throw new Error('Provide a base and zh,ja,ko locale catalogs')
  const base = JSON.parse(await fs.readFile(values.base, 'utf8'))
  const catalogs = Object.fromEntries(
    await Promise.all(
      ['zh', 'ja', 'ko'].map(async (locale, index) => [
        locale,
        JSON.parse(await fs.readFile(paths[index], 'utf8')),
      ]),
    ),
  )
  const output = mergePageLocaleCatalogs(base, catalogs)
  await fs.writeFile(
    `${values.base}.tmp`,
    `${JSON.stringify(output, null, 2)}\n`,
  )
  await fs.rename(`${values.base}.tmp`, values.base)
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
