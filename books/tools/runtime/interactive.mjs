/**
 * The page code for everything on a book page that runs, apart from the inline
 * exercises (`exercises.mjs`) and the editors (`editor.mjs`): steppable
 * figures, runnable cells, the challenge desk with its call-by-call cases, and
 * the hint ladder.
 *
 * Moved out of `preview.py`'s page script so the published site runs the very
 * same code (#380). Where the code runs is the host's choice, passed in as a
 * backend with three calls that answer exactly as the preview's endpoints do:
 *
 *   exec({ source, earlier })  -> { output, ok }                 (/api/exec)
 *   grade({ node, source })    -> { ok, tiers, stopped_at, output,
 *                                   cases, summary }             (/api/grade)
 *   sample({ node, source })   -> { ok, calls, total, error }    (/api/sample)
 *
 * The preview answers them from its server; the published site from Python in
 * the reader's browser (`browser-backend.mjs`). A graded desk dispatches
 * `book:challenge-graded` ({ id, ok }), which is how progress records a solve.
 */

const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
// Each element is wired once, whatever calls this again: the site runs it on
// every page view.
const once = element => {
  if (element.dataset.interactiveWired) return true;
  element.dataset.interactiveWired = '1';
  return false;
};

// One call the tests made into the reader's code: what was called, what came
// back against what was expected, and what the reader printed during it. The
// prints are open by default on a wrong answer (that is when they are read)
// and one click away on a right one.
function caseHtml(call, isFailing) {
  const verdictClass = call.match === true ? 'good' : (call.match === false || call.raised) ? 'bad' : 'plain';
  const mark = verdictClass === 'good' ? '&#10003;' : verdictClass === 'bad' ? '&#10007;' : '&#8226;';
  const answer = call.raised
    ? `raised <b>${escapeHtml(call.raised)}</b>`
    : `returned <b>${escapeHtml(call.returned ?? '')}</b>`;
  const expected = call.expected !== undefined && call.match !== true
    ? `, expected <b>${escapeHtml(call.expected)}</b>` : '';
  const printed = (call.out || '') + (call.err || '');
  const dropped = (call.out_dropped_lines || 0) + (call.err_dropped_lines || 0);
  const prints = printed || dropped
    ? `<details class="case-prints"${verdictClass === 'bad' || isFailing ? ' open' : ''}>`
      + `<summary>Your output</summary><pre>${escapeHtml(printed)}`
      + (dropped ? `<span class="dropped">…truncated, ${dropped} more line${dropped === 1 ? '' : 's'}</span>` : '')
      + '</pre></details>'
    : '<p class="case-none">Printed nothing.</p>';
  return `<div class="call-case ${verdictClass}" data-test="${escapeHtml(call.test || '')}">`
    + `<div class="case-call"><span class="mark">${mark}</span>${escapeHtml(call.call)}</div>`
    + `<div class="case-got">${answer}${expected}</div>${prints}</div>`;
}

// Past this many calls a tier shows the first few and the failing one: a
// stress tier makes hundreds, and the reader needs the one that went wrong.
const CASES_SHOWN = 12;
function casesHtml(groups) {
  return groups.map(group => {
    const calls = group.calls || [];
    // The call that went wrong is the one with a wrong verdict, not the last
    // one: a failing test method does not stop the ones after it.
    const wrong = calls.find(call => call.match === false || (call.raised && call.match !== true));
    const failing = group.outcome && group.outcome !== 'pass' ? (wrong || calls[calls.length - 1]) : null;
    let shown = calls.slice(0, CASES_SHOWN);
    if (failing && !shown.includes(failing)) shown = [...shown.slice(0, CASES_SHOWN - 1), failing];
    // `total` is how many calls were made; only some were kept to show
    const total = Math.max(group.total ?? calls.length, calls.length);
    const more = total - shown.length;
    const head = group.label || `${group.tier} · ${total} call${total === 1 ? '' : 's'}`;
    return `<p class="cases-head">${escapeHtml(head)}</p>`
      + shown.map(call => caseHtml(call, call === failing)).join('')
      + (more > 0 ? `<p class="cases-head">…and ${more} more</p>` : '');
  }).join('');
}

export function wireInteractive(root, backend) {
  root.querySelectorAll('.walk').forEach(walk => {
    if (once(walk)) return;
    const steps = Number(walk.dataset.steps) || 1;
    let step = 0;
    const paint = () => {
      walk.querySelectorAll('.walk-item').forEach(el =>
        el.classList.toggle('on', Number(el.dataset.index) === step));
      walk.querySelectorAll('.slot').forEach(el =>
        el.classList.toggle('on', Number(el.dataset.step) <= step));
      walk.querySelector('.walk-step b').textContent = step + 1;
      walk.querySelectorAll('.walk-note').forEach(el => { el.hidden = Number(el.dataset.index) !== step; });
      const answer = walk.querySelector('.walk-answer');
      if (answer) answer.hidden = step !== steps - 1;
    };
    walk.querySelector('[data-walk="next"]').onclick = () => { step = Math.min(step + 1, steps - 1); paint(); };
    walk.querySelector('[data-walk="back"]').onclick = () => { step = Math.max(step - 1, 0); paint(); };
    paint();
  });

  const runnableCells = [...root.querySelectorAll('.cell-run')];
  runnableCells.forEach((cell, index) => {
    if (once(cell)) return;
    const button = cell.querySelector('.exec');
    const status = cell.querySelector('.status');
    const output = cell.querySelector('.output');
    button.onclick = async () => {
      button.disabled = true; button.classList.add('busy'); status.textContent = 'Running';
      output.textContent = ''; output.classList.remove('error');
      const earlier = runnableCells.slice(0, index)
        .map((c, cellIndex) => ({
          index: cellIndex + 1,
          source: c.querySelector('.editor').value,
        }));
      try {
        const result = await backend.exec({ source: cell.querySelector('.editor').value, earlier });
        output.textContent = result.output;
        output.classList.toggle('error', result.ok === false);
        status.textContent = '';
      } catch (error) { status.textContent = String(error); }
      finally { button.disabled = false; button.classList.remove('busy'); }
    };
  });

  root.querySelectorAll('.desk').forEach(desk => {
    if (once(desk)) return;
    const button = desk.querySelector('.run');
    const sample = desk.querySelector('.sample');
    const status = desk.querySelector('.status');
    const tiers = desk.querySelector('.tiers');
    const output = desk.querySelector('.output');
    const verdict = desk.querySelector('.desk-verdict');
    const details = desk.querySelector('.full-output');
    const cases = desk.querySelector('.cases');
    // Everything the last run left is cleared before the next one starts, so a
    // stale red verdict never sits beside a run that has not finished (and a
    // request error cannot leave one up indefinitely).
    const clear = () => {
      tiers.innerHTML = ''; output.textContent = ''; if (cases) cases.innerHTML = '';
      verdict.hidden = true; verdict.innerHTML = ''; details.hidden = true;
    };
    const busy = on => { button.disabled = on; if (sample) sample.disabled = on; };
    button.onclick = async () => {
      busy(true);
      status.textContent = 'Running public, edge, stress, perf...';
      clear();
      try {
        const result = await backend.grade({ node: desk.dataset.node, source: desk.querySelector('.editor').value });
        tiers.innerHTML = result.tiers.map(t =>
          `<span class="tier ${t.outcome === 'pass' ? 'pass' : 'fail'}">${t.tier} - ${t.outcome}</span>`
        ).join('');
        status.textContent = result.ok ? 'All four tiers green.' : '';
        desk.dispatchEvent(new CustomEvent('book:challenge-graded', {
          bubbles: true, detail: { id: desk.dataset.node, ok: Boolean(result.ok) },
        }));
        verdict.hidden = result.ok;
        verdict.innerHTML = result.ok ? '' :
          `<span class="mark">&#10007;</span> ` + escapeHtml(result.summary || `${result.stopped_at} is red.`);
        if (cases) cases.innerHTML = casesHtml(result.cases || []);
        output.textContent = result.output || '';
        details.hidden = !result.output;
      } catch (error) { status.textContent = String(error); }
      finally { busy(false); }
    };
    if (sample) sample.onclick = async () => {
      busy(true);
      status.textContent = 'Running the samples...';
      clear();
      try {
        const result = await backend.sample({ node: desk.dataset.node, source: desk.querySelector('.editor').value });
        const calls = result.calls || [];
        status.textContent = calls.length ? 'Samples only. Not graded.' : '';
        if (result.error) {
          verdict.hidden = false;
          verdict.innerHTML = `<span class="mark">&#10007;</span> ` + escapeHtml(result.error);
        }
        const total = result.total ?? calls.length;
        if (cases) cases.innerHTML = casesHtml([{ label: `Samples · ${total}`, calls, total }]);
      } catch (error) { status.textContent = String(error); }
      finally { busy(false); }
    };
  });

  // Hints live in the terminal. The bulb shows the next one; a read hint's dot
  // shows it again. Spending is per challenge, for the session, and never falls.
  root.querySelectorAll('.hint-panel').forEach(panel => {
    if (once(panel)) return;
    const desk = panel.closest('.desk');
    const button = desk.querySelector('.hint-button');
    const total = Number(panel.dataset.total);
    const key = 'hints:' + panel.dataset.ladder;
    let spent = 0;
    try { spent = Math.min(total, Number(JSON.parse(sessionStorage.getItem(key) || '0')) || 0); } catch {}
    let current = spent;
    const next = panel.querySelector('.hint-next');
    const paint = () => {
      if (button) button.querySelector('.hint-count').textContent = `${spent}/${total}`;
      panel.querySelectorAll('.hint-dot').forEach(dot => {
        const n = Number(dot.dataset.rung);
        dot.classList.toggle('spent', n <= spent);
        dot.classList.toggle('current', n === current);
        dot.disabled = n > spent;
        dot.setAttribute('aria-label', `Hint ${n}` + (n <= spent ? ', read' : ', not read yet'));
      });
      panel.querySelectorAll('.hint-body').forEach(body => { body.hidden = Number(body.dataset.rung) !== current; });
      const shown = panel.querySelector(`.hint-body[data-rung="${current}"]`);
      panel.querySelector('.hint-title').textContent = shown ? shown.dataset.title : '';
      next.hidden = spent >= total;
      next.textContent = spent ? 'Next hint' : 'Show hint 1';
    };
    const open = () => {
      panel.hidden = false;
      panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = '';
      if (button) button.setAttribute('aria-expanded', 'true');
    };
    const spend = () => {
      if (spent < total) spent += 1;
      current = spent;
      try { sessionStorage.setItem(key, JSON.stringify(spent)); } catch {}
      paint(); open();
    };
    if (button) button.onclick = () => {
      if (!panel.hidden) { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); return; }
      if (!spent) spend(); else { current = current || spent; paint(); open(); }
    };
    next.onclick = spend;
    panel.querySelector('.hint-close').onclick = () => {
      panel.hidden = true; if (button) { button.setAttribute('aria-expanded', 'false'); button.focus(); }
    };
    panel.querySelectorAll('.hint-dot').forEach(dot => dot.onclick = () => {
      current = Number(dot.dataset.rung); paint(); open();
    });
    paint();
  });
}
