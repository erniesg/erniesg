# Site organization and Struct research demo

Approved scope (12 October 2026): Blog `/blog`, Books `/books`, Research `/research`, Library `/library`, Projects `/projects`; experiments under `/projects/experiments`. Labels, page titles and canonical section URLs agree. Production publishes Blog and Research; the other three section trees remain preview-only. About and Tags remain footer links.

## Research filing

`/research/struct/` is the project/evidence page. The existing Semantic Responsive Typesetting working paper is a linked artifact, not a peer-reviewed publication claim. The October Struct #25–29 evaluation proposal, July scoping literature review, historical local adapter result, original one-fixture engineering benchmark, reader-facing criteria and limitations are separately linked. Spec 052 is evaluation direction, not a measured success rate. PDF reconstruction and deterministic semantic rendering remain separate.

## Demo

`/research/struct/demo/` presents actual external documents: Attention Is All You Need, Docling Technical Report and AI Must Die. Attention is not mirrored: the gateway fetches pinned arXiv version 1706.03762v7 on a visitor request and gives that network a private conversion result. Preconverted Docling (CC BY 4.0) and AI Must Die (CC BY-NC-SA 4.0) samples preserve credit, source links, licenses and an adaptation notice in their HTML and EPUBs. Existing fixture inputs were used for the three-item generation pilot, rather than advertised as actual-paper samples. If Letters Home Could Sing remains an independent Research publication and is not a demo sample.

The sample reference adapter checkout was `568d550`. AI Must Die and Docling both remain review-required; a valid EPUB is not evidence of faithful extraction or publication approval. Individual sample evidence files record input/output hashes and relevant checks.

The gateway accepts PDF uploads up to 10 MiB, with 3 conversion attempts per UTC day per network (IPv4 address or IPv6 /64), and a shared 20-attempt/day limit. Quota reservation happens atomically in D1 before source/body work, with at most two active request leases to protect the shared Worker memory limit. Busy rejections consume no attempt; crash leases expire. Provider job mappings are unique. Failed submissions consume attempts. Job results are scoped to the originating canonical IP, separately from the IPv6 /64 quota, expire 72 hours after submission, and cannot expose converter credentials, internal IDs, logs or other jobs. Finished backend files are swept after roughly 72 hours; queued/running jobs remain until completion. EPUB output streams have a 32 MiB byte ceiling. Anonymous writes require same-origin requests.

Use the existing production D1 database and converter; no new billable resource. `STRUCT_DEMO_TOKEN` is a Cloudflare secret, never a plain var or file. User explicitly approved reuse of the existing converter credential in the production Worker secret store. Preview credentials are not changed. The book/auth preview Worker must not be redeployed from this production build.

## Preservation

`/papers` routes redirect to `/research`, while existing paper annotation tenancy retains its original `/papers/<id>/` document URI. The author-published Chinese loss article is carried forward verbatim from the primary checkout to prevent the October 4 base reverting the October 7 publication. Original source images stay present. No translation tooling, unrelated book drafts or Performing Fire changes are included.

## Validation

Run focused route/quota/Worker suites, production build and gate, actual sample EPUB validation, browser demo flows and mobile/desktop rendering. Run `scripts/agent-evidence` on the committed integrated head; obtain fresh independent review before publication. Deployment and post-deployment checks target only `erniesg-workers` / `ernie.sg`, never `erniesg-workers-preview`.
