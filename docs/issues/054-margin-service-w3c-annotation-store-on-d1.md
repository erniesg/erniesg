# margin service: a W3C Web Annotation store on D1 that enforces visibility server-side

depends-on: 062

## Provider

claude

## Goal

The storage and authorization half of `margin` — the reader-participation
layer for published documents. This issue builds the service with no UI and no
real auth: the data model, the D1 schema, the HTTP surface, and the rule that
decides who may see what.

**The anchor and annotation model already exists in this repository and must
be reused, not reinvented.** `src/research/annotations.ts` (366 lines, tested,
in production use by `ResearchStudio.tsx` and
`src/pages/research/[id]/exports/[file].ts`) already defines:

- `semanticTextAnchorSchema` — `{nodeId, position, quote}`, where `position`
  is a text-position selector and `quote` is an `{exact, prefix, suffix}`
  text-quote selector. This is W3C Web Annotation shape already.
- `textAnnotationSchema` — a discriminated union on `kind` of
  `highlightAnnotationSchema` and `noteAnnotationSchema`.
- `createSemanticTextAnchor`, `createSemanticTextAnchorFromRange`,
  `resolveTextAnchor`, `cacheAnnotationGeometry`, `createLayoutVersion`.
- `TextAnchorResolution` — `resolved` / `ambiguous` / `unresolved`, with
  `matchedBy: 'position-and-context' | 'quote-and-context' | 'unique-quote'`.

`src/publication/annotation-bundle.ts` builds on it with
`annotationBundleSchema`, `createAnnotationBundle` and
`serializeAnnotationBundle`.

062 has already moved these modules to `src/annotations/` unchanged. This
issue consumes them from there.

The stored shape is then the existing `SemanticTextAnchor` plus
`TextAnnotation`, extended only where margin genuinely needs more:

- a third `kind`, `proposal`, for 059's edit proposals;
- `visibility`, `creator`, `parentId` and the `(site, document)` tenancy key;
- an optional `structId` selector alongside `nodeId`, for documents that came
  through `@erniesg/struct`.

Adding a `kind` to a discriminated union and fields to a record is a small,
reviewable change. Building a parallel model beside a working one is not.

## Observed failure

- No annotation storage exists anywhere in the repo. `wrangler.production.jsonc`
  declares `assets` only: no `main`, no Worker script, no D1, KV or Durable
  Object binding in the repo at all.
- `ernie.sg` therefore has no server-side request path, so there is currently
  nowhere for a private note to be filtered out before it reaches a browser.

## Success criteria

1. Schema stores the existing `SemanticTextAnchor` + `TextAnnotation` plus
   `visibility`, `creator`, `parent_id`, an optional `struct_id`, and a
   tenancy key `(site, document)`. The `kind` union gains `proposal`.
2. Tenancy is real from the first commit. Nothing in the schema, the queries or
   the route shapes may assume the challenges book is the only document. A
   second site must be addable without a migration.
3. **Visibility is enforced in the query, never in serialization.** A private
   annotation belonging to another user must not be read from the database for
   this request. A test asserts that the SQL for a non-owner cannot return
   another user's private rows, not merely that the response omits them.
4. Routes under `/api/margin/v1/`: `GET|POST /annotations`,
   `PATCH|DELETE /annotations/:id`, `GET|PATCH /prefs`,
   `GET /proposals`, `POST /proposals/:id/apply`,
   `GET /documents/:id/history`. Apply and history return `501` in this issue;
   059 and 060 implement them.
5. `prefs` holds the per-user global default visibility. A new annotation with
   no explicit visibility takes that default; changing the default never
   rewrites existing annotations.
6. Storage sits behind a thin repository interface so D1 is not load-bearing
   in route handlers. This is what makes a later extraction to
   `margin-api.berlayar.ai` mechanical.
7. Authorization reads the caller through the `getPrincipal(request)` seam
   that 062 created. This issue neither defines nor replaces it.

## Acceptance tests

- Two users, each with one private and one public annotation on the same
  document: each `GET /annotations` returns exactly three rows, and the
  non-owner's query plan never touches the other's private row.
- Creating an annotation with no visibility takes the caller's default;
  changing the default afterwards leaves it unchanged.
- A reply whose target is an annotation is stored and returned with its
  `parent_id` intact.
- Rows for a second `(site, document)` are invisible to the first.
- Unknown `kind`, malformed selector, oversized body and cross-tenant
  `parent_id` are all rejected with 4xx and never stored.
- Every test that existed for `src/research/annotations.ts` still passes from
  its new location, unchanged.

## Definition of done

The route table above responds on a local `wrangler dev` with D1 local; every
acceptance test passes; the visibility test asserts at the query layer; no
route handler references D1 directly.

## Validation command

```bash
npx wrangler d1 migrations apply margin-db-stg --local
npm test
npx vitest run src/worker/margin
npm run build
```

## Allowed secrets

None in this issue. Names only for later: `WORKOS_ISSUER`,
`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`,
`WORKOS_REDIRECT_URI`.

## Artifact outputs

D1 migrations; the repository interface and its D1 implementation; the
`/api/margin/v1/` route handlers; the `getPrincipal` seam with a dev stub;
tests including the query-layer visibility proof.

## Stop conditions

**Stop before writing a second anchor or annotation schema.** If something
about `semanticTextAnchorSchema` or `textAnnotationSchema` does not fit,
extend it in place and say why; do not model it again alongside.

Also stop before filtering private rows in serialization rather than in the
query, before hardcoding the challenges book as the only tenant, and before
letting a route handler reach D1 directly.

## Human clarification protocol

If the W3C model genuinely cannot express something asked for, add it as a
namespaced extension property and name it, rather than abandoning the model.

## Recommended response

Do the move first, as its own commit, with no other change. A pure relocation
with green tests is reviewable in a minute; a relocation tangled with a schema
extension is not.

Then model replies as annotations carrying a `parent_id`, which is what the
W3C model means by targeting another annotation, so threads need no second
table.

## Trade-offs

The W3C shape is more verbose than a purpose-built schema, and selectors as a
list costs a join or a JSON column. Both are the price of being adoptable by a
second site without a migration, which is the stated reason this is a service
and not a feature.

## Free-form response

`adapters/margin/` and the apply path are deliberately absent here. The
service must never hold a git credential; 060 builds the adapter that does.
