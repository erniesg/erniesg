import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The evidence lane budget is one value.
 *
 * `DEFAULT_BUDGET_MS` in `scripts/agent-evidence` is the only place its number
 * appears. Every other bound on these lanes either derives it (the trusted
 * publisher), names it (the runbook), or leaves the lanes uncapped so the
 * budget governs (`.agent/commands.yaml`). The supervision ceiling it must fit
 * under is held to one value in the same way.
 *
 * These checks are static and cheap, so they run in the ordinary test lane.
 * The producer itself is exercised by `agent-evidence-budget.test.mjs`, which
 * that lane excludes.
 */

const PRODUCER = 'scripts/agent-evidence'
const WORKFLOW = '.github/workflows/agent-evidence.yml'
const PUBLISHER = '.github/workflows/agent-evidence-publisher.yml'
const COMMANDS = '.agent/commands.yaml'
const PRODUCER_TEST = 'tools/agent-evidence-budget.test.mjs'

const integer = (literal) => Number(literal.replaceAll('_', ''))

function laneBudgetMs() {
  const source = readFileSync(PRODUCER, 'utf8')
  const matches = [...source.matchAll(/^const DEFAULT_BUDGET_MS = ([1-9][0-9_]*);$/gmu)]
  expect(matches, 'exactly one DEFAULT_BUDGET_MS integer literal').toHaveLength(1)
  return integer(matches[0][1])
}

/** Every ceiling literal the trusted runner enforces, in either language. */
function supervisionCeilings() {
  const publisher = readFileSync(PUBLISHER, 'utf8')
  return [
    ...publisher.matchAll(
      /^\s*(?:const )?(MAX_TIMEOUT_MS|CANDIDATE_TIMEOUT_CEILING_MS) = ([0-9_]+);?$/gmu,
    ),
  ].map((match) => ({ name: match[1], ms: integer(match[2]) }))
}

describe('the lane budget is one value', () => {
  /** Every way the evidence files have written a budget or timeout number. */
  function restatements(text, budgetMs) {
    const found = []
    const seconds = budgetMs / 1000
    const minutes = seconds / 60
    const spellings = new Set([
      String(budgetMs),
      budgetMs.toLocaleString('en-US'),
      budgetMs.toLocaleString('en-US').replaceAll(',', '_'),
      `${seconds} s`,
      `${seconds}s`,
      `${seconds.toLocaleString('en-US')} s`,
      `${seconds} seconds`,
      `${minutes} min`,
      `${minutes} minutes`,
    ])
    for (const spelling of spellings) {
      const pattern = new RegExp(`(?<![0-9_,.])${spelling.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![0-9_,])`, 'gu')
      for (const match of text.matchAll(pattern)) found.push(match[0])
    }
    return found
  }

  const governed = [
    PRODUCER,
    '.agent/verify.md',
    COMMANDS,
    WORKFLOW,
    PUBLISHER,
    PRODUCER_TEST,
    'tools/agent-evidence-budget-rule.test.mjs',
  ]

  it('states the budget number only in its definition', () => {
    const budgetMs = laneBudgetMs()
    for (const file of governed) {
      let text = readFileSync(file, 'utf8')
      if (file === PRODUCER) {
        text = text.replace(/^const DEFAULT_BUDGET_MS = [0-9_]+;$/mu, '')
      }
      expect(restatements(text, budgetMs), `${file} restates the lane budget`).toEqual([])
    }
  })

  it('bounds the trusted producer by the budget, not by a number of its own', () => {
    const publisher = readFileSync(PUBLISHER, 'utf8')
    const producerCall = publisher.match(
      /candidateSpawnSync\(\s*producerNode,[\s\S]*?"trusted evidence producer",\s*\)/u,
    )
    expect(producerCall, 'the trusted producer call').not.toBeNull()
    expect(producerCall[0]).toMatch(/timeout: producerTimeoutMs\b/u)
    expect(producerCall[0]).not.toMatch(/timeout: [0-9]/u)
    expect(publisher).toContain(
      '/^const DEFAULT_BUDGET_MS = ([1-9][0-9_]*);$/m.exec(trustedProducerSource)',
    )

    // The derived bound must fit under the ceiling the trusted runner
    // enforces, or the runner refuses the producer before it starts.
    const overhead = integer(publisher.match(/const PRODUCER_OVERHEAD_MS = ([0-9_]+);/u)[1])
    for (const { ms } of supervisionCeilings()) {
      expect(laneBudgetMs() + overhead).toBeLessThanOrEqual(ms)
    }
  })

  it('holds the supervision ceiling to one value across both languages', () => {
    // The Python runner and the JS launcher each need the ceiling and cannot
    // share a constant, so they must agree, and no prose may restate it.
    const ceilings = supervisionCeilings()
    expect(ceilings.map(({ name }) => name).sort()).toEqual([
      'CANDIDATE_TIMEOUT_CEILING_MS',
      'MAX_TIMEOUT_MS',
    ])
    expect(new Set(ceilings.map(({ ms }) => ms)).size, JSON.stringify(ceilings)).toBe(1)
    const ceilingMs = ceilings[0].ms
    for (const file of governed) {
      const text = readFileSync(file, 'utf8')
        .replace(/^\s*(?:const )?(?:MAX_TIMEOUT_MS|CANDIDATE_TIMEOUT_CEILING_MS) = [0-9_]+;?$/gmu, '')
      expect(restatements(text, ceilingMs), `${file} restates the supervision ceiling`).toEqual([])
    }
  })

  it('gives no budget-governed lane a timeout of its own in commands.yaml', () => {
    // A per-lane cap there either restates the budget or undercuts it: `test`
    // had 900 s against a measured run of about 1,724 s.
    const producer = readFileSync(PRODUCER, 'utf8')
    const laneCommands = new Set(
      [...producer.matchAll(/^\s*"command": "([^"]+)",?$/gmu)].map((match) => match[1]),
    )
    expect(laneCommands.size).toBeGreaterThanOrEqual(4)
    const blocks = readFileSync(COMMANDS, 'utf8').split(/^  (?=[A-Za-z0-9_-]+:$)/mu).slice(1)
    let governedLanes = 0
    for (const block of blocks) {
      const command = block.match(/^\s*command: "([^"]+)"$/mu)?.[1]
      if (!command || !laneCommands.has(command)) continue
      governedLanes += 1
      expect(block, `${command} must not carry timeout_seconds`).not.toMatch(/timeout_seconds/u)
    }
    expect(governedLanes, 'build, test and e2e are budget-governed').toBeGreaterThanOrEqual(3)
  })

  it('keeps the producer-running test out of the evidence test lane', () => {
    // `npm run test` is the evidence `test` lane. Running the real producer
    // from inside it is re-entrant: it spends the budget under test and can
    // leave a nested `.agent/evidence` run in the candidate tree.
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
    expect(scripts.test).toContain(`--exclude '${PRODUCER_TEST}'`)
    expect(scripts['test:agent-evidence']).toContain(PRODUCER_TEST)
  })

  it('describes the budget as shared in the runbook, by its constant', () => {
    const runbook = readFileSync('.agent/verify.md', 'utf8')
    expect(runbook).toContain('DEFAULT_BUDGET_MS')
    expect(runbook).not.toMatch(/gives each lane/u)
  })
})
