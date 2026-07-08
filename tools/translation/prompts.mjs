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
      corpus = await fs.readFile(
        '.translation/style-corpus/zh-human.md',
        'utf8',
      )
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

export function buildReviewPrompt({
  sourceLocale,
  targetLocale,
  sourcePath,
  targetPath,
  styleContext,
  reviewerProfile,
}) {
  return [
    `You are a ${reviewerProfile} for ${targetLocale} translations.`,
    'Review as a native bilingual editor, not as the original translator.',
    'Reject direct translation, awkward calques, hybrid suffixes, mistranslated technical terms, broken MDX, and tone drift.',
    'Accept deliberate preservation of product names, code terms, quoted English, and glossary-preserved terms.',
    '',
    `Source locale: ${sourceLocale}`,
    `Target locale: ${targetLocale}`,
    `Source path: ${sourcePath}`,
    `Target path: ${targetPath}`,
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
  ]
    .filter(Boolean)
    .join('\n')
}

export function reviewJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['passed', 'score', 'issues', 'unresolvedResearch', 'notes'],
    properties: {
      passed: { type: 'boolean' },
      score: { type: 'number', minimum: 0, maximum: 1 },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'location', 'problem', 'suggestion'],
          properties: {
            severity: { type: 'string', enum: ['minor', 'major', 'blocking'] },
            location: { type: 'string' },
            problem: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
      unresolvedResearch: {
        type: 'array',
        items: { type: 'string' },
      },
      notes: { type: 'string' },
    },
  }
}
