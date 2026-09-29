/**
 * Inline exercises: the reader's code runs in their own browser (Pyodide in a
 * worker) and is checked line by line against the output the exercise expects.
 *
 * Moved out of `preview.py`'s page script so the published site runs the very
 * same code: the preview serves this file as a module, the site bundles it.
 * `wireExercises` tells its host when a check finishes, which is how a solve is
 * recorded without this file knowing where progress is kept.
 */

const exerciseId = section => (section.id || '').replace(/^ex-/, '');

import { pythonLoaded, runPython } from './python.mjs';

const MAX_EXTRA_ROWS = 5;
const tidy = text => text.replace(/^\n+|\n+$/g, '').split('\n').map(l => l.trimEnd()).join('\n').trimEnd();
const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Each line the exercise expects is one test, read like a grader's report.
export function results(produced, expected, error) {
  const want = tidy(expected).split('\n');
  const got = tidy(produced) ? tidy(produced).split('\n') : [];
  const code = text => `<code>${escapeHtml(text.length > 200 ? text.slice(0, 200) + '…' : text)}</code>`;
  const rows = want.map((line, i) => {
    const ok = got[i] === line;
    const detail = ok ? code(line)
      : `expected ${code(line)} · got ${i < got.length ? code(got[i]) : 'nothing'}`;
    return { ok, html: `<li class="case ${ok ? 'pass' : 'fail'}"><span class="mark">${ok ? '&#10003;' : '&#10007;'}</span>`
      + `<span class="case-n">Test ${i + 1}</span><span>${detail}</span></li>` };
  });
  // Extra lines are shown up to a few; the rest, and any the worker let go
  // (its "…truncated, N more lines" line), are one count, so a print in a
  // loop is one row instead of thousands.
  let extras = got.slice(want.length);
  let more = 0;
  const last = extras[extras.length - 1] || '';
  // The worker only ever reports a positive count; a zero is the reader's own
  // print, and stays an extra line like any other.
  const cut = /^…truncated, ([1-9]\d*) more lines?$/.exec(last);
  const partial = last === '…truncated, the rest of the last line';
  if (cut) { more += Number(cut[1]); extras = extras.slice(0, -1); }
  if (partial) extras = extras.slice(0, -1);
  more += Math.max(0, extras.length - MAX_EXTRA_ROWS);
  extras.slice(0, MAX_EXTRA_ROWS).forEach(line => rows.push({ ok: false, extra: true,
    html: `<li class="case fail"><span class="mark">&#10007;</span><span class="case-n">Extra</span>`
      + `<span>printed ${code(line)}, which no test asked for</span></li>` }));
  if (more || partial) rows.push({ ok: false, extra: true,
    html: `<li class="case fail"><span class="mark">&#10007;</span><span class="case-n">Extra</span>`
      + `<span>…and ${more ? `${more} more line${more === 1 ? '' : 's'}` : 'the rest of a long line'}`
      + ` no test asked for</span></li>` });
  const passed = rows.filter(r => r.ok).length;
  const allOk = passed === want.length && rows.length === want.length && !error;
  const head = allOk
    ? `&#10003; All ${want.length} test${want.length > 1 ? 's' : ''} passed`
    : `&#10007; ${passed} of ${want.length} test${want.length > 1 ? 's' : ''} passed`;
  return { allOk, html: `<p class="results-head ${allOk ? 'pass' : 'fail'}">${head}</p>`
    + `<ol class="cases">${rows.map(r => r.html).join('')}</ol>`
    + (error ? `<pre class="case-error">${escapeHtml(error.trim())}</pre>` : '') };
}

export function wireExercises(root = document, { onResult } = {}) {
root.querySelectorAll('.exercise').forEach(ex => {
  const button = ex.querySelector('.check');
  const editor = ex.querySelector('.editor');
  const status = ex.querySelector('.status');
  const panel = ex.querySelector('.results');
  if (!button || !editor || ex.dataset.wired) return; // the print edition shows exercises without a checker
  ex.dataset.wired = '1';
  button.onclick = async () => {
    button.disabled = true; button.classList.add('busy');
    status.textContent = pythonLoaded() ? 'Checking' : 'Loading Python, first time only';
    panel.hidden = true; panel.innerHTML = ''; panel.className = 'results';
    const { out, error } = await runPython(editor.value);
    const { allOk, html } = results(out, ex.dataset.expected, error);
    panel.hidden = false;
    panel.className = 'results ' + (allOk ? 'pass' : 'fail');
    panel.innerHTML = html;
    status.textContent = '';
    button.disabled = false; button.classList.remove('busy');
    onResult?.({ id: exerciseId(ex), section: ex, code: editor.value, allOk });
  };
});
}

