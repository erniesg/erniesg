import fs from 'node:fs/promises'
import { readJson, sha256 } from './content.mjs'

export async function loadStyleContext(targetLocale) {
  const [style, rubric, glossary] = await Promise.all([
    fs.readFile(`docs/translation/style/${targetLocale}.md`, 'utf8'),
    fs.readFile('docs/translation/style/rubric.md', 'utf8'),
    readJson('docs/translation/glossary.json', { terms: {} }),
  ])
  let corpus = ''
  if (targetLocale === 'zh') {
    try {
      corpus = await fs.readFile('.translation/style-corpus/zh-human.md', 'utf8')
    } catch {
      corpus = ''
    }
  }
  return {
    style,
    rubric,
    glossary,
    corpus,
    styleGuideSha256: sha256(`${style}\n${corpus}`),
    rubricSha256: sha256(`${rubric}\n${JSON.stringify(glossary)}`),
  }
}

export function buildTranslationPrompt({
  sourceLocale,
  targetLocale,
  sourcePath,
  styleContext,
  researchReport,
}) {
  return [
    `You are a native-level ${targetLocale} literary and technical translator.`,
    `Translate from ${sourceLocale} to ${targetLocale} for Ernie's personal site.`,
    'Do not produce direct literal translation. Preserve Ernie’s argument, rhythm, dry humor, and bilingual technical precision.',
    'Translate only the segment values. Preserve MDX syntax, code, URLs, imports, component names, and fixed HTML attributes.',
    'If a term needs research and no research evidence is available, return an unresolved research item instead of guessing.',
    '',
    `Source path: ${sourcePath}`,
    '',
    'Style guide:',
    styleContext.style,
    '',
    targetLocale === 'zh' && styleContext.corpus
      ? `Human Chinese reference corpus:\n${styleContext.corpus.slice(0, 12000)}`
      : '',
    '',
    'Rubric:',
    styleContext.rubric,
    '',
    'Glossary:',
    JSON.stringify(styleContext.glossary, null, 2),
    '',
    'Research notes:',
    JSON.stringify(researchReport ?? { candidates: [] }, null, 2),
  ]
    .filter(Boolean)
    .join('\n')
}

export function translationJsonSchema(segmentIds) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['translations', 'unresolvedResearch'],
    properties: {
      translations: {
        type: 'object',
        additionalProperties: false,
        required: segmentIds,
        properties: Object.fromEntries(
          segmentIds.map((id) => [
            id,
            {
              type: 'string',
              description: `Native translation for segment ${id}`,
            },
          ]),
        ),
      },
      unresolvedResearch: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  }
}
