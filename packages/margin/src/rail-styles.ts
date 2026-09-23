/** The one package rail's shadow styles. Palette keys remain semantic. */
export const RAIL_STYLES = `
:host { display:block; color:inherit; font:inherit; --margin-surface:#fff; --margin-ink:#222; --margin-line:#b9b9b9; --margin-muted:#555; }
* { box-sizing:border-box; }
button, input, textarea, select { font:inherit; }
button { cursor:pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline:3px solid #1769aa; outline-offset:2px; }
.mobile-toggle { display:none; }
.panel { color:var(--margin-ink); background:var(--margin-surface); border:1px solid var(--margin-line); border-radius:.75rem; padding:1rem; box-shadow:0 7px 24px #00000012; }
.heading { display:flex; justify-content:space-between; align-items:baseline; gap:.5rem; }
.heading h2 { font-size:1rem; margin:0; }
.count { font-size:.8rem; color:var(--margin-muted); }
.controls { display:grid; gap:.65rem; margin:.8rem 0 1rem; }
.controls label { display:grid; gap:.2rem; font-size:.8rem; }
.controls input, .controls select, .edit textarea { width:100%; border:1px solid var(--margin-line); border-radius:.4rem; background:var(--margin-surface); color:var(--margin-ink); padding:.45rem; }
.list { list-style:none; display:grid; gap:.65rem; padding:0; margin:0; }
.entry { border:1px solid var(--margin-line); border-inline-start:4px solid var(--margin-color,#aa8330); border-radius:.4rem; padding:.65rem; background:var(--margin-surface); }
.entry[data-margin-color="highlight"] { --margin-color:#c79b22; }
.entry[data-margin-color="question"] { --margin-color:#3292ba; }
.entry[data-margin-color="insight"] { --margin-color:#399a58; }
.entry[data-margin-color="action"] { --margin-color:#bf6395; }
.entry[data-orphaned] { border-style:dashed; }
.entry[data-flash] { animation:margin-flash 1.2s ease-out; }
.entry-main { display:block; border:0; background:transparent; color:inherit; text-align:start; width:100%; padding:0; line-height:1.45; }
.quote { display:block; font-weight:600; overflow-wrap:anywhere; }
.body { display:block; margin:.35rem 0 0; white-space:pre-wrap; overflow-wrap:anywhere; }
.meta { display:block; color:var(--margin-muted); font-size:.75rem; margin-top:.3rem; }
.entry-actions { display:flex; align-items:center; flex-wrap:wrap; gap:.35rem; margin-top:.55rem; }
.entry-actions button, .actions button, .edit button { border:1px solid var(--margin-line); border-radius:.4rem; padding:.28rem .48rem; background:var(--margin-surface); color:inherit; }
.empty, .notice { font-size:.83rem; color:var(--margin-muted); margin:.7rem 0; }
.notice[role=status] { color:#8b2e16; }
.edit { display:grid; gap:.4rem; margin-top:.6rem; }
.edit textarea { min-height:5rem; resize:vertical; }
.edit-actions { display:flex; gap:.4rem; }
.dialog { position:fixed; z-index:1000; width:min(22rem,calc(100vw - 1rem)); border:1px solid var(--margin-line); border-radius:.75rem; padding:1rem; background:var(--margin-surface); color:var(--margin-ink); box-shadow:0 12px 42px #0004; }
.dialog h3 { font-size:1rem; margin:0 0 .65rem; }
.swatches { display:flex; gap:.4rem; flex-wrap:wrap; }
.swatches button { border:1px solid var(--margin-line); border-radius:2rem; padding:.38rem .62rem; background:var(--margin-color); color:#17202a; }
.swatches button[data-margin-color="highlight"] { --margin-color:#f4d35e; }
.swatches button[data-margin-color="question"] { --margin-color:#91daf0; }
.swatches button[data-margin-color="insight"] { --margin-color:#a6deb1; }
.swatches button[data-margin-color="action"] { --margin-color:#f1b7d6; }
.dialog label { display:grid; gap:.25rem; margin-top:.75rem; font-size:.82rem; }
.dialog textarea { width:100%; min-height:5rem; padding:.5rem; border:1px solid var(--margin-line); border-radius:.4rem; background:var(--margin-surface); color:var(--margin-ink); resize:vertical; }
.dialog-actions { display:flex; justify-content:flex-end; gap:.4rem; margin-top:.5rem; }
.dialog-actions button { border:1px solid var(--margin-line); border-radius:.4rem; background:var(--margin-surface); color:inherit; padding:.35rem .6rem; }
.dialog-actions button[data-margin-save-note] { background:#17395c; color:#fff; }
.screenreader { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
@keyframes margin-flash { from { background:#fff1ad; } to { background:var(--margin-surface); } }
@media (max-width:1279px) {
  :host { pointer-events:none; }
  .mobile-toggle { display:block; margin-left:auto; pointer-events:auto; border:1px solid var(--margin-line); border-radius:2rem; background:var(--margin-surface); color:var(--margin-ink); padding:.55rem .9rem; box-shadow:0 3px 16px #0003; }
  .panel { display:none; pointer-events:auto; max-height:min(75vh,40rem); overflow:auto; margin-top:.5rem; box-shadow:0 12px 42px #0004; }
  :host([overlay-open]) .panel { display:block; }
  .dialog { pointer-events:auto; }
}
@media (prefers-color-scheme:dark) {
  :host { --margin-surface:#20242b; --margin-ink:#f1f3f5; --margin-line:#717b89; --margin-muted:#ccd2d8; }
  .dialog-actions button[data-margin-save-note] { background:#a5cdf4; color:#10243a; }
}
`
