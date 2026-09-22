import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MARGIN_API_PREFIX, MARGIN_HEALTH_PATH } from './index'

/** Minimal JSONC reader: drops comments and trailing commas, string-aware. */
function readJsonc(file: string): Record<string, any> {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8')
  let output = ''
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (character === '"') {
      const start = index
      index += 1
      while (index < source.length && source[index] !== '"') {
        index += source[index] === '\\' ? 2 : 1
      }
      index += 1
      output += source.slice(start, index)
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2) + 2
      continue
    }
    output += character
    index += 1
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/gu, '$1'))
}

const configs = {
  preview: readJsonc('wrangler.jsonc'),
  production: readJsonc('wrangler.production.jsonc'),
}

describe('Wrangler configuration', () => {
  it.each(Object.entries(configs))(
    'points %s at the Worker entry',
    (_name, config) => {
      expect(config.main).toBe('./src/worker/index.ts')
    },
  )

  it.each(Object.entries(configs))(
    'leaves %s static asset serving unchanged',
    (_name, config) => {
      expect(config.assets.directory).toBe('./dist')
      expect(config.assets.not_found_handling).toBe('404-page')
      expect(config.assets.html_handling).toBe('auto-trailing-slash')
      expect(config.assets.binding).toBe('ASSETS')
    },
  )

  it.each(Object.entries(configs))(
    'scopes the %s Worker to the margin API prefix only',
    (_name, config) => {
      expect(config.assets.run_worker_first).toEqual([`${MARGIN_API_PREFIX}/*`])
      expect(MARGIN_HEALTH_PATH.startsWith(`${MARGIN_API_PREFIX}/`)).toBe(true)
    },
  )

  it('binds margin-db-stg in preview and margin-db in production', () => {
    expect(configs.preview.d1_databases).toEqual([
      {
        binding: 'MARGIN_DB',
        database_name: 'margin-db-stg',
        database_id: '48958be2-df8f-4ec9-b6d9-7d7be51f87e6',
      },
    ])
    expect(configs.production.d1_databases).toEqual([
      {
        binding: 'MARGIN_DB',
        database_name: 'margin-db',
        database_id: 'c98621e9-5621-401a-b2f2-35390c25411d',
      },
    ])
  })

  it('keeps the production route table and worker names untouched', () => {
    expect(configs.production.name).toBe('erniesg-workers')
    expect(configs.production.routes).toEqual([
      { pattern: 'ernie.sg/*', zone_name: 'ernie.sg' },
    ])
    expect(configs.preview.name).toBe('erniesg-workers-preview')
    expect(configs.preview.routes).toBeUndefined()
  })
})
