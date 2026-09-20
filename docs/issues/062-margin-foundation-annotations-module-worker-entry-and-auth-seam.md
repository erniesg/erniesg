# margin foundation: move the annotations module, add the Worker entry, bind D1, define the auth seam

## Provider

claude

## Goal

The small shared groundwork that 054, 055 and 056 all need, pulled into one
fast issue so those three can then run in parallel instead of queueing behind
each other. This issue writes almost no new logic. It relocates existing code
and creates the seams the others plug into.

## Observed failure

- `src/research/annotations.ts` and `src/publication/annotation-bundle.ts`
  hold the anchor and annotation model, but their path says "research" while
  margin needs them for books, papers and the library too. Three separate
  issues would each want to move them, and whichever landed second would
  conflict.
- `wrangler.production.jsonc` declares `assets` only — no `main`, no D1
  binding anywhere in the repo. Every service issue needs that wiring and only
  one of them can add it.
- There is no `getPrincipal` seam, so 054 (which needs a caller identity) and
  055 (which implements one for real) would both invent it.

## Success criteria

1. `src/research/annotations.ts` and `src/publication/annotation-bundle.ts`
   move to `src/annotations/` with **no behaviour change**. All existing
   importers are updated: `src/publication/annotation-bundle.test.ts`,
   `src/components/research/ResearchStudio.tsx`,
   `src/pages/research/[id]/exports/[file].ts`. `src/research/annotations.ts`
   may re-export from the new location for compatibility.
2. Every test that existed for those modules passes from the new location,
   unchanged. A test asserts the moved schemas parse the same fixtures as
   before the move.
3. A Worker entry point is added as `main` in `wrangler.jsonc` and
   `wrangler.production.jsonc`, serving nothing but a health route. Static
   asset serving for every existing route is unchanged — a test asserts an
   existing page still returns its built HTML.
4. `margin-db` (APAC, `c98621e9-5621-401a-b2f2-35390c25411d`) and
   `margin-db-stg` (`48958be2-df8f-4ec9-b6d9-7d7be51f87e6`) are bound.
5. A `getPrincipal(request)` seam exists with a dev stub keyed by an env var,
   returning a principal or null. It is the single place any route learns who
   the caller is. 055 replaces its implementation and nothing else.
6. No annotation storage, no routes beyond health, no auth logic. Those are
   054 and 055.

## Acceptance tests

- Every pre-existing annotation test passes from `src/annotations/`.
- `ResearchStudio` renders and its annotation behaviour is unchanged.
- An existing static route still serves its built HTML with the Worker in
  place.
- `getPrincipal` returns null with no stub configured and a principal with it
  set; no route yet depends on the result.

## Definition of done

`npm test` and `npm run build` pass, the Worker serves the health route on a
local `wrangler dev`, and `git log` shows the move as its own commit with no
logic change in it.

## Validation command

```bash
npm test
npm run build
npx wrangler dev --local --test-scheduled &
curl -sf http://localhost:8787/api/margin/v1/health
```

## Allowed secrets

None.

## Artifact outputs

`src/annotations/` with the moved modules and their tests; the Worker entry
and D1 bindings; the `getPrincipal` seam with a dev stub.

## Stop conditions

Stop before changing any annotation behaviour while moving it — a relocation
tangled with a schema change is not reviewable. Stop before adding routes,
storage or auth. Stop before altering how any existing static route is served.

## Human clarification protocol

If adding `main` to the Wrangler config changes how existing assets are
served in any observable way, stop and report rather than adjusting the asset
configuration to compensate.

## Recommended response

Make the move its own commit, with `git mv` and import updates only, so the
diff is reviewable at a glance. Wire the Worker in a second commit.

## Trade-offs

This issue exists purely to unblock parallelism and would otherwise be three
paragraphs inside 054. That is the point: it is small, it is fast, and three
issues stop waiting on each other once it lands.

## Free-form response

The annotation model is the thing most at risk of being reinvented — it
already exists, tested and in production use. Moving it somewhere neutral
first, on its own, is what makes "reuse it" the obvious path for every issue
that follows.
