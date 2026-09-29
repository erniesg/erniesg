/**
 * Where the published site runs the reader's code: Python in their own
 * browser, answering `interactive.mjs`'s three calls in exactly the shapes the
 * local preview's endpoints answer them (`preview.py`, `/api/exec`,
 * `/api/grade`, `/api/sample`).
 *
 * Nothing is re-implemented in JavaScript that Python already does: a cell
 * runs through `cell_runner.py`, and a tier through `grade_inprocess.py`,
 * which runs the tier file with `bookgrader` and `grader_observe` exactly as
 * `grade.py`'s subprocess does. Only the tier loop is here, and it is the
 * preview's loop line for line.
 *
 * `sources` maps each of those Python files' names to its text; the host
 * bundles them. `grading(node)` is a challenge's `{ module, tiers }` from the
 * book manifest, or null.
 */

import { runPython } from './python.mjs';

const TIERS = ['public', 'edge', 'stress', 'perf'];
const SAMPLE_TIER = 'public';
// Python in the browser runs a few times slower than on the reader's machine,
// so a tier's limit stretches by this much here. The perf tier's own timing
// assertions are unchanged; this only stops a runaway loop.
const BROWSER_SLOWDOWN = 2;
// How long one runnable cell may take, as on the preview.
const EXEC_TIMEOUT_SECONDS = 15;

const TOOLS = '/book/tools';
const PYTHON_FILES = ['bookgrader.py', 'grader_observe.py', 'grading.py', 'grade_inprocess.py', 'cell_runner.py'];

// Python source for one JSON value, without any quoting of our own to get wrong.
const literal = value => `__import__('json').loads(${JSON.stringify(JSON.stringify(value))})`;

// What grade.summarize says of a tier that ran out of time; it cannot be
// asked, because the worker it would run in has just been stopped.
const tooSlow = seconds =>
  `too slow: exceeded the ${seconds}s limit on the biggest allowed input. Look for work you repeat.`;

export function browserBackend({ sources, grading }) {
  const tools = Object.fromEntries(PYTHON_FILES.map(name => {
    if (typeof sources[name] !== 'string') throw new Error(`browserBackend needs the text of ${name}`);
    return [`${TOOLS}/${name}`, sources[name]];
  }));

  // The reader needs the test's name and line, not this browser's folders:
  // the same roots the preview strips from its own paths.
  const stripRoots = text => (text || '').split('/book/work/').join('').split('/book/').join('');

  async function exec({ source, earlier }) {
    const run = await runPython({
      files: tools,
      budgetMs: EXEC_TIMEOUT_SECONDS * 1000 * BROWSER_SLOWDOWN,
      // The output is kept to the grader's per-call cap as it is written
      // (bookgrader's bounded buffer), so a print in a loop cannot fill the
      // tab's memory before the time limit stops it.
      source: [
        'import contextlib, json, sys, traceback',
        `sys.path.insert(0, '${TOOLS}') if '${TOOLS}' not in sys.path else None`,
        'from bookgrader import _BoundedBuffer, _clip',
        `ns = {'__name__': '__main__'}`,
        `exec(compile(open('${TOOLS}/cell_runner.py').read(), '<runner>', 'exec'), ns)`,
        'buffer, ok = _BoundedBuffer(), True',
        'with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):',
        '    try:',
        `        ns['_run_cells'](${literal(earlier || [])}, ${literal(source || '')})`,
        '    except BaseException:',
        '        traceback.print_exc()',
        '        ok = False',
        'text, dropped = _clip(buffer.getvalue())',
        'dropped += buffer.dropped_lines',
        "output = text.strip() or '(no output)'",
        'if dropped:',
        "    output += f\"\\n…truncated, {dropped} more line{'' if dropped == 1 else 's'}\"",
        `json.dumps({'output': output, 'ok': ok})`,
      ].join('\n'),
    });
    if (run.timedOut) return { output: `stopped after ${EXEC_TIMEOUT_SECONDS} seconds`, ok: false };
    if (run.value === null) return { output: run.error || 'Python could not run this.', ok: false };
    return JSON.parse(run.value);
  }

  /** One tier: `{ outcome, output, calls, total, summary }`, or a timeout. */
  async function tier(node, spec, source, sample) {
    const found = grading(node);
    const folder = `/book/challenges/${node}`;
    const work = `/book/work/${node}`;
    const files = {
      ...tools,
      [`${folder}/tests/${spec.tier}.py`]: spec.source,
      [`${work}/${found.module}.py`]: source,
    };
    const run = await runPython({
      files,
      budgetMs: (spec.timeout || 60) * 1000 * BROWSER_SLOWDOWN,
      source: [
        'import sys',
        `sys.path.insert(0, '${TOOLS}') if '${TOOLS}' not in sys.path else None`,
        'import grade_inprocess',
        `grade_inprocess.run_tier_json('${folder}', '${spec.tier}', '${work}', ${sample ? 'True' : 'False'})`,
      ].join('\n'),
    });
    if (run.timedOut) {
      const output = `exceeded the ${spec.timeout || 60}s limit`;
      return { outcome: 'timeout', output, calls: [], total: 0, summary: tooSlow(spec.timeout || 60) };
    }
    if (run.value === null) {
      const output = run.error || 'Python could not run the tests.';
      return { outcome: 'fail', output, calls: [], total: 0, summary: output };
    }
    return JSON.parse(run.value);
  }

  async function grade({ node, source }) {
    const found = grading(node);
    if (!found) {
      const reason = `cannot grade this request: no tiers for ${node}`;
      return { ok: false, tiers: [], stopped_at: null, output: reason, summary: reason };
    }
    const byTier = Object.fromEntries(found.tiers.map(spec => [spec.tier, spec]));
    // The preview's loop: the public tier's calls are always shown (they are
    // the statement's rows), a failing tier's too, and the first red tier stops it.
    const results = [];
    const cases = [];
    let output = '', stoppedAt = null, summary = '';
    for (const name of TIERS) {
      const spec = byTier[name];
      const result = spec
        ? await tier(node, spec, source, false)
        : { outcome: 'missing', output: `No test file for the ${name} tier`, calls: [], total: 0, summary: '' };
      results.push({ tier: name, outcome: result.outcome });
      if (result.calls.length && (name === SAMPLE_TIER || result.outcome !== 'pass')) {
        cases.push({ tier: name, outcome: result.outcome, calls: result.calls, total: result.total ?? result.calls.length });
      }
      if (result.outcome !== 'pass') {
        output = result.output;
        stoppedAt = name;
        summary = result.summary || result.output;
        break;
      }
    }
    return {
      ok: stoppedAt === null,
      tiers: results,
      stopped_at: stoppedAt,
      output: stripRoots(output),
      cases,
      summary: stoppedAt ? stripRoots(summary) : '',
    };
  }

  async function sample({ node, source }) {
    const found = grading(node);
    const spec = found?.tiers.find(t => t.tier === SAMPLE_TIER);
    if (!spec) return { ok: false, calls: [], total: 0, error: `No samples for ${node}` };
    const result = await tier(node, spec, source, true);
    // As run_samples: an empty list means the file could not even run, and
    // then the reader gets why instead.
    const error = result.calls.length ? '' : stripRoots(result.summary || result.output);
    return { ok: !error, calls: result.calls, total: result.total ?? result.calls.length, error };
  }

  return { exec, grade, sample };
}
