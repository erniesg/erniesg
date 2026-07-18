# Visual diagnostic evidence

Blocking PDF diagnostics have one visual contract across the browser studio,
synthetic-fixture evidence, and opt-in local corpus review. The renderer uses
the normalized source boxes already carried by reconstruction results; it does
not rerun or relax any reconstruction rule.

## Fixture evidence

Run:

```bash
npm run srt:overlay-evidence
```

The command reads only repository-owned PDFs listed in
`tests/fixtures/pdf/manifest.json` and writes deterministic, self-contained HTML
to `.agent/evidence/diagnostic-overlays/`. Its generated `README.md` is the
review index. Each row must name:

- the fixture;
- the rule or renderer contract under review;
- every demonstrated diagnostic code; and
- before/after artifacts for at least one fixture affected by an SRT rule
  change.

The HTML contains no timestamp, absolute path, random identifier, or runtime
version. Repeated runs over unchanged fixtures and code must therefore be
byte-identical. Evidence may include only committed synthetic fixtures; private,
downloaded, subscription, and ambiguously licensed documents are forbidden.

The repository evidence runner invokes this command through the required test
lane's `pretest` lifecycle. `scripts/agent-evidence` remains unchanged and the
generated overlay directory sits beside its timestamped lane manifests.

## Private corpus overlays

Operators may request local visual output while preserving the corpus report's
privacy boundary:

```bash
npm run pdf:corpus-audit -- --report-only \
  --overlay-output /absolute/local/review-directory \
  /absolute/local/pdf-directory
```

The overlay directory is mandatory when the option is present and must resolve
outside the repository, including through existing symbolic-link ancestors.
Artifacts are self-contained local HTML and may contain document text, so they
must not be committed, uploaded, or logged. The JSON report never records the
overlay directory or artifact names and continues to contain basenames, hashes,
metrics, counts, and redacted diagnostic messages only.

## Studio interaction

For a blocked import, the studio draws the selected PDF page with PDF.js after
reconstruction has completed. Category-colored SVG overlays sit above that
raster. The diagnostic text list remains the keyboard-accessible selector and
source of diagnostic messages. Selecting a note diagnostic draws the marker-to-
candidate connections and lists every score and evidence string. Selecting an
ambiguous reading-order diagnostic draws both numbered region sequences.
