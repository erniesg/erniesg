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
  revisionContext = null,
}) {
  return [
    `You are a native-level ${targetLocale} literary and technical translator.`,
    `Translate from ${sourceLocale} to ${targetLocale} for Ernie's personal site.`,
    'Do not produce direct literal translation. Preserve Ernie’s argument, rhythm, dry humor, and bilingual technical precision.',
    'Translate only the segment values. Preserve MDX syntax, code, URLs, imports, component names, and fixed HTML attributes.',
    'Keep every placeholder shaped like ⟪LOCKED_0001⟫ exactly once and unchanged; it represents protected code or a URL that will be restored after translation.',
    'Translate ordinary human-facing English nouns, verbs, place names, interface labels, headings, quotations, and attributions. Do not create hybrids by attaching target-language grammar to untranslated English common words.',
    'Preserve only product and brand names, code or identifiers, standard technical acronyms such as API/SQL/LLM, and terms the glossary explicitly preserves. Integrate any preserved technical English naturally into the target-language sentence.',
    'Translate human-facing quotations, blockquotes, captions, attributions, and accessibility text. Preserve the original language only when the text is deliberately presented as an original-language artifact, such as model output being analyzed.',
    'Escape literal currency dollar signs in MDX prose as \\$ so they are not parsed as inline math.',
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
    revisionContext
      ? [
          '',
          'Revision task:',
          'Independent native reviewers rejected the current machine translation. Address every reported issue, then edit every returned segment for native cadence, meaning fidelity, and Ernie’s voice even when a sentence was not explicitly flagged. Do not copy an awkward reviewer suggestion mechanically.',
          'Before returning, scan the entire revision for untranslated ordinary English prose, hybrid English-plus-target-language grammar, unlocalized human-facing labels or attributions, incomplete sentences, and direct calques. Repair them even if the reviewers mentioned only examples.',
          'Reviewer feedback:',
          JSON.stringify(revisionContext, null, 2),
        ].join('\n')
      : '',
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
    'Judge reader-facing translated content only. translationStatus: machine is intentional ownership metadata and must remain machine after automated review; never report it as a quality issue. The pipeline may normalize equivalent YAML scalars such as a date-only value to an ISO timestamp or quote style, so do not report semantically equivalent frontmatter serialization as translation churn.',
    'Set passed=false only when there is at least one major or blocking reader-facing issue, unresolved research, broken syntax, meaning drift, or the score is below the publish threshold. Minor polish notes alone must still return passed=true and a score of at least 0.90.',
    'Translate human-facing quotations, blockquotes, captions, attributions, and accessibility text. Accept original-language text only when it is deliberately presented as an artifact, such as model output being analyzed.',
    'Preserve product names, code terms, and glossary-preserved terms.',
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
