# PDF note-marker taxonomy

The local PDF importer classifies every numeric or symbolic marker that could be
a note reference before matching it to a note body. Classifications are emitted
as `CLASSIFIED_NOTE_MARKER` diagnostics with a normalized source box,
confidence, threshold, disposition, and deciding evidence. Diagnostic messages
contain stable marker and region identifiers, not document prose.

The classification threshold is `0.85`. A marker without decisive evidence for
a non-note meaning remains an `unresolved-note-marker`, enters the note matcher,
and fails closed if it cannot be resolved. Reclassification never deletes source
text: citations, affiliations, equation references, section references, and
bibliography entries remain canonical prose with their normal PDF provenance.

| Taxonomy                          | Disposition                 | Required evidence                                                                                           |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `footnote-reference`              | note reference              | Exact label in a same-page footnote band                                                                    |
| `endnote-reference`               | note reference              | Exact label in a later endnote section                                                                      |
| `bracketed-bibliography-citation` | citation retained as prose  | Reference-list heading, bracket syntax, at least two citation markers, and no note body region              |
| `superscript-citation-cluster`    | citation retained as prose  | Reference-list heading, clustered superscript syntax, at least two citation labels, and no note body region |
| `author-affiliation-superscript`  | plain text                  | Page-one superscript before Abstract or Introduction with no matching note body                             |
| `equation-reference`              | plain text                  | Marker immediately governed by Equation or Eq. context                                                      |
| `section-reference`               | plain text                  | Marker immediately governed by Section or Sec. context                                                      |
| `bibliography-entry`              | plain text                  | Numbered marker inside a detected reference-list section                                                    |
| `unresolved-note-marker`          | note reference, fail closed | Candidate marker lacks enough evidence for safe reclassification                                            |

Note relationships use the existing exact-label confidence score and are
accepted only at or above `0.70`. Candidates within `0.04` of the best score
remain `AMBIGUOUS_NOTE_MATCH`; a best candidate below the threshold remains
`UNRESOLVED_NOTE_REFERENCE`. Every relationship records its threshold, score,
candidate source boxes, and evidence such as same-page scope, same-column
geometry, page-wide note region, note-following-reference, or later-endnote
scope.
