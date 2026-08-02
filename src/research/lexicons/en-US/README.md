# Pinned en-US lexical proof model

Visible PDF line-end hyphens are resolved offline with two pinned inputs:

- `scowl-2020.12.07.dic` and `.aff`, copied from Debian's
  `hunspell-en-us` package version `1:2020.12.07-2`, prove word validity.
- `ushyphmax-2005-05-30.tex`, copied from GNU groff 1.23.0's
  `tmac/hyphen.en`, proves admissible American-English hyphenation points.

The runtime accepts only explicit `en` or `en-US` language scope. It does not
fetch, update, or consult host dictionaries. Structural counts are checked
when the module loads, and these source digests are recorded in
`PDF_HYPHEN_LEXICAL_MODEL`:

```text
829a043cf078d1e80e886289a13823454977f442a239a859d2133ea61944aa60  scowl-2020.12.07.dic
70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5  scowl-2020.12.07.aff
f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8  ushyphmax-2005-05-30.tex
```

`LICENSE-SCOWL.txt` preserves the SCOWL collection's notices. The
hyphenation-pattern copyright and redistribution notice are preserved at the
top of `ushyphmax-2005-05-30.tex`.
