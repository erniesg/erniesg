/**
 * The book's code editors: plain textareas, given syntax colour, line numbers,
 * indent guides and the four keys Python needs (Tab, Shift-Tab, Enter,
 * Backspace), with Cmd/Ctrl+Enter pressing the editor's own run button.
 *
 * Moved out of `preview.py`'s page script so the published site runs the very
 * same code (#380): the preview serves this file as a module, the site bundles
 * it. `wireEditors` is safe to call again on the same page (the site calls it on
 * every page view): an editor it has already taught is left alone.
 */

// Syntax colour, line numbers and indent guides: a highlighted copy of the
// code drawn under a transparent textarea, so editing stays native.
const KEYWORDS = new Set(('and as assert async await break continue del elif else except finally for '
  + 'from global if import in is lambda nonlocal not or pass raise return try while with yield').split(' '));
const DEFINERS = new Set(['def', 'class']);
const CONSTANTS = new Set(['True', 'False', 'None', 'self']);
const BUILTINS = new Set(('abs all any bool dict enumerate filter float int isinstance len list map max '
  + 'min print range reversed round set sorted str sum tuple type zip ValueError KeyError IndexError '
  + 'TypeError ZeroDivisionError Exception NotImplementedError input open iter next ord chr divmod').split(' '));
const TOKEN = /(#[^\n]*)|([rbfuRBFU]{0,2}(?:"{3}[\s\S]*?(?:"{3}|$)|'{3}[\s\S]*?(?:'{3}|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|(@\w+)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
const esc = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function highlight(source) {
  let html = '', last = 0, afterDef = false, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(source))) {
    html += esc(source.slice(last, m.index));
    const [text, com, str, dec, num, word] = m;
    let cls = com ? 'com' : str ? 'str' : dec ? 'dec' : num ? 'num' : '';
    if (word) {
      if (afterDef) cls = 'fn';
      else if (DEFINERS.has(word)) cls = 'def';
      else if (KEYWORDS.has(word)) cls = 'kw';
      else if (CONSTANTS.has(word)) cls = 'con';
      else if (BUILTINS.has(word)) cls = 'bi';
      else if (source[TOKEN.lastIndex] === '(') cls = 'fn';
      afterDef = DEFINERS.has(word);
    } else afterDef = false;
    html += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
    last = TOKEN.lastIndex;
  }
  html += esc(source.slice(last));
  return html.replace(/(^|\n)((?: {4})+)/g, (_, start, indent) =>
    start + '<span class="ig">    </span>'.repeat(indent.length / 4));
}

function paintEditor(editor) {
  editor.setAttribute('wrap', 'off');
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  const hl = document.createElement('pre');
  hl.className = 'code-hl'; hl.setAttribute('aria-hidden', 'true');
  const gutter = document.createElement('pre');
  gutter.className = 'code-gutter'; gutter.setAttribute('aria-hidden', 'true');
  editor.replaceWith(wrap);
  wrap.append(gutter, hl, editor);
  const paint = () => {
    hl.innerHTML = highlight(editor.value) + '\n';
    const lines = editor.value.split('\n').length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  };
  const follow = () => {
    hl.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    gutter.style.transform = `translateY(${-editor.scrollTop}px)`;
  };
  editor.addEventListener('input', paint);
  editor.addEventListener('scroll', follow);
  paint();
}

// The editors are plain textareas taught the four keys Python needs.
// Edits go through execCommand('insertText') so native undo stays one step.
const INDENT = '    ';
const DEDENTERS = /^\s*(return|pass|break|continue|raise)\b/;

function insert(editor, text, start, end) {
  editor.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
}

function shiftLines(editor, outdent) {
  const { value, selectionStart: start, selectionEnd: end } = editor;
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const stop = value.charAt(end - 1) === '\n' && end > start ? end - 1 : end;
  let to = value.indexOf('\n', stop);
  if (to === -1) to = value.length;
  const lines = value.slice(from, to).split('\n');
  const changed = lines.map(line => outdent
    ? line.replace(/^ {1,4}/, '')
    : (line.trim() || lines.length === 1 ? INDENT + line : line));
  const firstDelta = changed[0].length - lines[0].length;
  insert(editor, changed.join('\n'), from, to);
  const total = changed.join('\n').length - (to - from);
  editor.setSelectionRange(Math.max(from, start + firstDelta), end + total);
}

function runCell(editor, advance) {
  const holder = editor.closest('.cell-run, .desk, .exercise');
  const button = holder && holder.querySelector('.exec, .run, .check');
  if (!button) return;
  button.click();
  if (advance) {
    const editors = [...document.querySelectorAll('.editor')];
    const next = editors[editors.indexOf(editor) + 1];
    if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
}

function teachKeys(editor) {
  let escaped = false;
  editor.addEventListener('keydown', event => {
    const { key, shiftKey } = event;
    const command = event.metaKey || event.ctrlKey;
    if (key === 'Escape') { escaped = true; return; }
    const leaving = escaped && key === 'Tab';
    escaped = false;
    if (leaving || event.isComposing) return;

    const { value, selectionStart: start, selectionEnd: end } = editor;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const before = value.slice(lineStart, start);

    if (key === 'Enter' && command) {
      event.preventDefault();
      runCell(editor, shiftKey);
    } else if (key === 'Enter') {
      event.preventDefault();
      let indent = (before.match(/^ */) || [''])[0];
      if (/:\s*$/.test(before)) indent += INDENT;
      else if (DEDENTERS.test(before)) indent = indent.slice(INDENT.length);
      insert(editor, '\n' + indent, start, end);
    } else if (key === 'Tab') {
      event.preventDefault();
      const multiline = value.slice(start, end).includes('\n');
      if (shiftKey || multiline) shiftLines(editor, shiftKey);
      else insert(editor, ' '.repeat(4 - (before.length % 4)), start, end);
    } else if (key === 'Backspace' && start === end && before.length && /^ +$/.test(before)) {
      event.preventDefault();
      const drop = before.length % 4 || 4;
      insert(editor, '', start - drop, start);
    }
  });
}

export function wireEditors(root = document) {
  root.querySelectorAll('.editor').forEach(editor => {
    if (editor.dataset.editorWired) return;
    editor.dataset.editorWired = '1';
    paintEditor(editor);
    teachKeys(editor);
  });
}
