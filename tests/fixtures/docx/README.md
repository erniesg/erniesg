# Synthetic DOCX fixtures

These repository-owned OOXML packages contain only generated text, XML, and a
tiny generated PNG. Rebuild them with `node generate-fixtures.mjs` after
installing dependencies.

- `structured-manuscript.docx` covers headings, rich runs, hyperlinks, nested
  lists, footnotes, endnotes, an image/caption pair, a semantic table, and
  multilingual text.
- `malformed-manuscript.docx` intentionally contains a missing image part and
  a dangling footnote reference so the importer must fail closed.
