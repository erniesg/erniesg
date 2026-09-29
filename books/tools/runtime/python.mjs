/**
 * Python in the reader's browser: Pyodide in one worker, one run at a time.
 *
 * Every edition that runs the reader's code without a server uses this: the
 * inline exercises, and on the published site the runnable cells and the
 * challenge desk too. Loaded lazily, on the first run, never on page load.
 *
 * A run may bring files to write first (a challenge's tiers, the grader) and
 * its own time budget. A run past its budget terminates the worker, so a loop
 * that never ends costs the reader a Python reload, not a frozen tab.
 */

// Overridable so a test can stand in a Python whose load time it controls.
const PYODIDE_DEFAULT = 'https://cdn.jsdelivr.net/npm/pyodide@0.26.4/pyodide.js';
const pyodideUrl = () => window.__bookPyodideUrl || PYODIDE_DEFAULT;
// The learner's code gets this long once Python is up. Loading Python has its
// own, longer budget: a slow first download is not an infinite loop.
export const RUN_BUDGET_MS = 8000;
const LOAD_BUDGET_MS = 60000;
export const TIMED_OUT = 'Stopped after a few seconds: is there a loop that never ends?';
// Characters of printed output kept per stream, as the grader caps each call.
export const OUTPUT_CAP_CHARS = 20000;

const workerSource = () => `importScripts('${pyodideUrl()}');
const ready = loadPyodide();
ready.then(() => postMessage({ ready: true }), err => postMessage({ ready: false, error: String(err) }));
// What the reader prints is kept up to a cap as it arrives: a print in a loop
// that runs to the time limit must not fill the tab's memory first.
const OUTPUT_CAP = ${OUTPUT_CAP_CHARS};
function capped() {
  const sink = { text: '', dropped: 0 };
  sink.add = line => {
    if (sink.text.length < OUTPUT_CAP) sink.text += line.slice(0, OUTPUT_CAP - sink.text.length) + '\\n';
    else sink.dropped += 1;
  };
  sink.value = () => sink.text + (sink.dropped
    ? '…truncated, ' + sink.dropped + ' more line' + (sink.dropped === 1 ? '' : 's') + '\\n'
    : '');
  return sink;
}
onmessage = async ({ data }) => {
  const py = await ready;
  const stdout = capped(), stderr = capped();
  let out = '', error = '', value = null;
  py.setStdout({ batched: s => stdout.add(s) });
  py.setStderr({ batched: s => stderr.add(s) });
  try {
    for (const [path, text] of Object.entries(data.files || {})) {
      py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
      py.FS.writeFile(path, text);
    }
    const result = await py.runPythonAsync(data.source, { globals: py.globals.get('dict')() });
    if (typeof result === 'string') value = result;
  } catch (err) {
    const lines = String(err.message).trim().split('\\n');
    const where = [...String(err.message).matchAll(/File "<exec>", line (\\d+)/g)].pop();
    error += (where ? 'Crashed on line ' + where[1] + ' · ' : '') + lines[lines.length - 1];
  }
  out = stdout.value() + out;
  error = stderr.value() + error;
  postMessage({ id: data.id, out, error, value });
};`;

// Python's stdout is global to the worker, so two runs at once would
// interleave their output; and a reply is matched to its request by id, never
// by whichever handler was installed last.
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
      job.resolve({ out: data.out, error: data.error, value: data.value ?? null, timedOut: false });
    };
    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'Python could not load.')); };
  });
  return pyReady;
}

function stopWorker() {
  pyWorker?.terminate();
  pyWorker = null; pyReady = null;
}

/** Whether Python is already loaded, so a caller can say "first time only". */
export const pythonLoaded = () => pyWorker !== null;

function runOnce({ source, files, budgetMs }, mine) {
  return (async () => {
    try {
      await (pyReady ?? startWorker());
    } catch (err) {
      stopWorker();
      return { out: '', error: err.message, value: null, timedOut: false };
    }
    // The page may have changed while Python was loading.
    if (mine !== generation) return CANCELLED;
    const worker = pyWorker;
    const id = ++nextRunId;
    return new Promise(resolve => {
      // The budget starts now: Python is loaded and this run is the only one.
      const timer = setTimeout(() => {
        pending.delete(id);
        if (pyWorker === worker) stopWorker();
        resolve({ out: '', error: TIMED_OUT, value: null, timedOut: true });
      }, budgetMs ?? RUN_BUDGET_MS);
      pending.set(id, { resolve, timer });
      worker.postMessage({ id, source, files });
    });
  })();
}

// Bumped by cancelPython: a job queued under an older generation belongs to a
// page that is gone, and never starts.
let generation = 0;
const CANCELLED = { out: '', error: 'Cancelled: the page changed.', value: null, timedOut: false, cancelled: true };

/**
 * Run `source` (optionally after writing `files`, path to text) and resolve
 * `{ out, error, value, timedOut }`. `value` is the run's last expression when
 * it is a string, which is how a caller gets JSON back.
 */
export function runPython(job) {
  const mine = generation;
  const run = queue.then(() =>
    mine === generation ? runOnce(typeof job === 'string' ? { source: job } : job, mine) : CANCELLED);
  queue = run.catch(() => {});
  return run;
}

/**
 * Abandon every run this page started: the one in progress is stopped (its
 * worker terminated, so a loop ends now rather than at its time limit) and
 * the queued ones never start. The site calls this as it swaps pages, so the
 * next page's first run is not held up behind the last page's.
 */
export function cancelPython() {
  generation += 1;
  const running = pending.size > 0;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.resolve(CANCELLED);
  }
  pending.clear();
  if (running) stopWorker();
  queue = Promise.resolve();
}
