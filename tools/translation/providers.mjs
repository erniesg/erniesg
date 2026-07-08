import OpenAI from 'openai'

export function providerConfigFor(config, purpose, locale) {
  if (purpose === 'translate') {
    return config.providers?.translate?.[locale] ?? config.providers?.default
  }
  if (purpose === 'research') {
    return config.providers?.research?.[locale] ?? config.providers?.default
  }
  if (purpose === 'review') {
    return config.providers?.review?.pass1?.[locale] ?? config.providers?.default
  }
  return config.providers?.default
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
    throw new Error(`${providerName} is not configured for structured JSON translation output.`)
  }
}

function responseText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text
  }
  const chunks = []
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text)
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
  assertProviderReady(config, providerConfig)
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  })
  const model =
    process.env.OPENAI_TRANSLATION_MODEL || providerConfig.model || config.providers?.default?.model
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
