# Translation Quality Rubric

Reject a translation when it:

- reads like sentence-by-sentence translation from the source
- preserves English word order in Chinese, Korean, or Japanese
- leaves ordinary prose as half-translated technical residue, such as `数据set`, `数据源s`, `データset`, `データソースs`, `데이터 소스s`, or English verbs like `ingest`, `chunk`, `query`, `validate` used as untranslated verbs
- over-translates code, product names, URLs, paths, identifiers, fixed HTML values, math, or quoted source text
- removes Ernie's bluntness, humor, uncertainty, or code-switching
- adds claims not present in the source
- weakens titles or descriptions into generic SEO text
- uses culturally wrong terminology for names, places, publications, idioms, or technical concepts

For Chinese, compare against the protected legacy Chinese posts before approving. For Korean and Japanese, require native technical essay register and reviewer notes explaining why the prose passes. Any reviewer pass must include one short explanation of why the output is not a direct translation.
