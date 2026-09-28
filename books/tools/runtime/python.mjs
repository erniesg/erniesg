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

const workerSource = () => `importScripts('${pyodideUrl()}');
const ready = loadPyodide();
ready.then(() => postMessage({ ready: true }), err => postMessage({ ready: false, error: String(err) }));
onmessage = async ({ data }) => {
  const py = await ready;
  let out = '', error = '', value = null;
  py.setStdout({ batched: s => { out += s + '\\n'; } });
  py.setStderr({ batched: s => { error += s + '\\n'; } });
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

function runOnce({ source, files, budgetMs }) {
  return (async () => {
    try {
      await (pyReady ?? startWorker());
    } catch (err) {
      stopWorker();
      return { out: '', error: err.message, value: null, timedOut: false };
    }
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

/**
 * Run `source` (optionally after writing `files`, path to text) and resolve
 * `{ out, error, value, timedOut }`. `value` is the run's last expression when
 * it is a string, which is how a caller gets JSON back.
 */
export function runPython(job) {
  const run = queue.then(() => runOnce(typeof job === 'string' ? { source: job } : job));
  queue = run.catch(() => {});
  return run;
}
