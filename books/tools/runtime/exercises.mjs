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

// Inline exercises run in the reader's browser (Pyodide in a worker), never
// on the server: the published book has no /api/exec to fall back on.
// Overridable so a test can stand in a Python whose load time it controls.
const PYODIDE_DEFAULT = 'https://cdn.jsdelivr.net/npm/pyodide@0.26.4/pyodide.js';
const pyodideUrl = () => window.__bookPyodideUrl || PYODIDE_DEFAULT;
// The learner's code gets this long once Python is up. Loading Python has its
// own, longer budget: a slow first download is not an infinite loop.
const RUN_BUDGET_MS = 8000;
const LOAD_BUDGET_MS = 60000;
const workerSource = () => `importScripts('${pyodideUrl()}');
const ready = loadPyodide();
ready.then(() => postMessage({ ready: true }), err => postMessage({ ready: false, error: String(err) }));
onmessage = async ({ data }) => {
  const py = await ready;
  let out = '', error = '';
  py.setStdout({ batched: s => { out += s + '\\n'; } });
  py.setStderr({ batched: s => { error += s + '\\n'; } });
  try {
    await py.runPythonAsync(data.source, { globals: py.globals.get('dict')() });
  } catch (err) {
    const lines = String(err.message).trim().split('\\n');
    const where = [...String(err.message).matchAll(/File "<exec>", line (\\d+)/g)].pop();
    error += (where ? 'Crashed on line ' + where[1] + ' · ' : '') + lines[lines.length - 1];
  }
  postMessage({ id: data.id, out, error });
};`;
// One worker, one run at a time. Python's stdout is global to the worker, so
// two runs at once would interleave their output; and a reply is matched to
// its request by id, never by whichever handler was installed last.
let pyWorker = null;
let pyReady = null;
let nextRunId = 0;
let queue = Promise.resolve();
const pending = new Map();
function startWorker() {
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' })));
  pyWorker = worker;
  pyReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Python did not load in time. Check your connection and try again.')), LOAD_BUDGET_MS);
    worker.onmessage = ({ data }) => {
      if ('ready' in data) {
        clearTimeout(timer);
        return data.ready ? resolve() : reject(new Error('Python could not load: ' + data.error));
      }
      const job = pending.get(data.id);
      if (!job) return; // a reply to a run that already timed out
      pending.delete(data.id);
      clearTimeout(job.timer);
      job.resolve({ out: data.out, error: data.error });
    };
    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'Python could not load.')); };
  });
  return pyReady;
}
function stopWorker() {
  pyWorker?.terminate();
  pyWorker = null; pyReady = null;
}
function runOnce(source) {
  return (async () => {
    try {
      await (pyReady ?? startWorker());
    } catch (err) {
      stopWorker();
      return { out: '', error: err.message };
    }
    const worker = pyWorker;
    const id = ++nextRunId;
    return new Promise(resolve => {
      // The budget starts now: Python is loaded and this run is the only one.
      const timer = setTimeout(() => {
        pending.delete(id);
        if (pyWorker === worker) stopWorker();
        resolve({ out: '', error: 'Stopped after a few seconds: is there a loop that never ends?' });
      }, RUN_BUDGET_MS);
      pending.set(id, { resolve, timer });
      worker.postMessage({ id, source });
    });
  })();
}
function runInBrowser(source) {
  const run = queue.then(() => runOnce(source));
  queue = run.catch(() => {});
  return run;
}
const tidy = text => text.replace(/^\n+|\n+$/g, '').split('\n').map(l => l.trimEnd()).join('\n').trimEnd();
const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Each line the exercise expects is one test, read like a grader's report.
function results(produced, expected, error) {
  const want = tidy(expected).split('\n');
  const got = tidy(produced) ? tidy(produced).split('\n') : [];
  const code = text => `<code>${escapeHtml(text)}</code>`;
  const rows = want.map((line, i) => {
    const ok = got[i] === line;
    const detail = ok ? code(line)
      : `expected ${code(line)} · got ${i < got.length ? code(got[i]) : 'nothing'}`;
    return { ok, html: `<li class="case ${ok ? 'pass' : 'fail'}"><span class="mark">${ok ? '&#10003;' : '&#10007;'}</span>`
      + `<span class="case-n">Test ${i + 1}</span><span>${detail}</span></li>` };
  });
  got.slice(want.length).forEach(line => rows.push({ ok: false, extra: true,
    html: `<li class="case fail"><span class="mark">&#10007;</span><span class="case-n">Extra</span>`
      + `<span>printed ${code(line)}, which no test asked for</span></li>` }));
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
    status.textContent = pyWorker ? 'Checking' : 'Loading Python, first time only';
    panel.hidden = true; panel.innerHTML = ''; panel.className = 'results';
    const { out, error } = await runInBrowser(editor.value);
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

