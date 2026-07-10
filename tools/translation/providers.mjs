import OpenAI from 'openai'
import {
  createCodexStructuredReview,
  createCodexStructuredTranslation,
} from './codex-cli.mjs'

function codexProviderConfig(baseConfig = {}) {
  const codexModel = process.env.CODEX_TRANSLATION_MODEL
  return {
    ...baseConfig,
    provider: 'codex-cli',
    model: codexModel,
    reasoningEffort: process.env.CODEX_TRANSLATION_REASONING_EFFORT ?? 'high',
    search: process.env.CODEX_TRANSLATION_SEARCH !== '0',
  }
}

function applyProviderOverride(baseConfig = {}, purpose) {
  const providerOverride =
    process.env[`TRANSLATION_${purpose.toUpperCase()}_PROVIDER`] ??
    process.env.TRANSLATION_PROVIDER
  if (providerOverride === 'codex-cli') return codexProviderConfig(baseConfig)
  return baseConfig
}

export function translationSourceForProvider(providerConfig = {}) {
  return providerConfig.provider === 'codex-cli'
    ? 'codex'
    : providerConfig.provider
}

export function providerConfigFor(config, purpose, locale, baseConfig = null) {
  if (baseConfig) return applyProviderOverride(baseConfig, purpose)
  if (purpose === 'translate') {
    return applyProviderOverride(
      config.providers?.translate?.[locale] ?? config.providers?.default,
      purpose,
    )
  }
  if (purpose === 'research') {
    return applyProviderOverride(
      config.providers?.research?.[locale] ?? config.providers?.default,
      purpose,
    )
  }
  if (purpose === 'review') {
    return applyProviderOverride(
      config.providers?.review?.pass1?.[locale] ?? config.providers?.default,
      purpose,
    )
  }
  return applyProviderOverride(config.providers?.default, purpose)
}

export function assertProviderReady(config, providerConfig) {
  const providerName = providerConfig?.provider
  if (!providerName) throw new Error('Translation provider is not configured.')
  const capabilities = config.providerCapabilities?.[providerName]
  for (const envName of capabilities?.requiresEnv ?? []) {
    if (!process.env[envName]) {
      throw new Error(
        `${envName} is required for ${providerName} translation/review calls. No content was written.`,
      )
    }
  }
  if (!capabilities?.supportsStructuredJson) {
    throw new Error(
      `${providerName} is not configured for structured JSON translation output.`,
    )
  }
}

function responseText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text
  }
  const chunks = []
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text)
        chunks.push(content.text)
    }
  }
  return chunks.join('\n')
}

export async function createStructuredTranslation({
  config,
  providerConfig,
  systemPrompt,
  segments,
  schema,
}) {
  if (providerConfig?.provider === 'codex-cli') {
    return createCodexStructuredTranslation({
      providerConfig,
      systemPrompt,
      segments,
      schema,
    })
  }
  assertProviderReady(config, providerConfig)
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  })
  const model =
    process.env.OPENAI_TRANSLATION_MODEL ||
    providerConfig.model ||
    config.providers?.default?.model
  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify(
          {
            segments: segments.map((segment) => ({
              id: segment.id,
              kind: segment.kind,
              sourceText: segment.sourceText,
            })),
          },
          null,
          2,
        ),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'mdx_translation_segments',
        schema,
        strict: true,
      },
    },
  })
  return JSON.parse(responseText(response))
}

export async function createStructuredReview({
  config,
  providerConfig,
  systemPrompt,
  sourceText,
  targetText,
  schema,
}) {
  if (providerConfig?.provider === 'codex-cli') {
    return createCodexStructuredReview({
      providerConfig,
      systemPrompt,
      sourceText,
      targetText,
      schema,
    })
  }
  assertProviderReady(config, providerConfig)
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  })
  const model =
    process.env.OPENAI_REVIEW_MODEL ||
    providerConfig.model ||
    config.providers?.default?.model
  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify(
          {
            sourceText,
            targetText,
          },
          null,
          2,
        ),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'translation_native_review',
        schema,
        strict: true,
      },
    },
  })
  return JSON.parse(responseText(response))
}
