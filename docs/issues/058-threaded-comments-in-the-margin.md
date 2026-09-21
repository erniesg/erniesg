# Threaded comments in the margin

depends-on: 057

## Provider

claude

## Goal

A note in the margin becomes a conversation. Another reader replies to it,
and to a reply. The thread renders in the rail under the annotation it hangs
from.

The storage for this already exists: 054 models a reply as an annotation whose
`target` is another annotation's id, which is what the W3C model says to do,
so threads need no new table. This issue is the traversal, the rendering and
the rules.

## Observed failure

- 057 renders a flat list. `parent_id` is stored and never read.

## Success criteria

1. Replying to any `commenting` annotation creates another `commenting`
   annotation targeting it. Depth is not artificially limited to one level,
   but rendering collapses beyond a readable depth rather than indenting
   indefinitely.
2. A thread is fetched in one request, not N+1, and renders in stable order
   (creation time, ties broken by id).
3. **Visibility composes correctly.** A reply to a public annotation may be
   private; a public reply to an annotation the reader cannot see must be
   impossible to create, and a reply whose parent is later made private must
   not leak the parent's quote to a reader who has lost access to it. Tests
   cover each case explicitly.
4. Deleting an annotation with replies does not orphan the replies into
   invisibility: the body is tombstoned and the thread structure survives, or
   the subtree is deleted with it. Pick one, document it, test it.
5. Each participant is shown by display name, never by email address.
6. Editing your own reply is allowed and records a modified time; editing
   another's is refused at the API, not only hidden in the UI.
7. The thread is fully keyboard-navigable and each reply is an addressable
   target so a link can point at it.

## Acceptance tests

- A three-deep thread renders in correct order from a single request.
- A private reply to a public note is invisible to a second reader while the
  note remains visible.
- Making a parent private removes its quote from a non-owner's response
  entirely, including from any reply payload.
- Attempting to reply to an annotation the caller cannot read is 404, not 403
  — existence itself must not leak.
- Editing another user's reply is 403 at the API.
- Deleting a parent behaves as documented and the test asserts that behaviour.
- No email address appears in any thread response.

## Definition of done

Threads render, compose visibility correctly under every case above, and the
N+1 test passes.

## Validation command

```bash
npm --workspace packages/margin test
npx vitest run src/worker/margin
npm test
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
npx playwright test tests/e2e/margin-threads.spec.ts
```

## Concurrency

This repository runs multiple issue workers on one host. Any command in this
spec that binds a port must choose it per run, never a fixed default, and any
temporary path must be unique per worker. A spec that hardcodes `8787`, `4321`
or a fixed preview port is a spec that cannot be run in parallel with another.
Playwright is the trap worth naming: `playwright.config.ts` reads
`SRT_E2E_PORT` and otherwise binds every run to `1234`, so set that
variable per run rather than inventing a new name for it. Ask the kernel
for a free port rather than sampling a range: with up to 16 workers,
`$RANDOM % 200` collides often enough to fail a correct run.

## Allowed secrets

None.

## Artifact outputs

Thread fetch and traversal; reply UI in the rail; the visibility composition
rules and their tests; the documented delete semantics.

## Stop conditions

Stop before returning 403 where 404 is required to avoid leaking existence,
before exposing an email address, and before shipping a thread fetch that
issues a query per reply.

## Human clarification protocol

If tombstoning versus cascade deletion is genuinely ambiguous for this book,
choose tombstoning — a conversation that loses its root is still worth reading
— and record the choice in the package README.

## Recommended response

Fetch the whole thread for a document in the same query that fetches its
annotations, and assemble the tree in memory. Threads on a book page are small
and a second round trip buys nothing.

## Trade-offs

Unlimited depth with collapsed rendering is more work than a one-level reply
model, but a one-level model makes the second reply to a reply unrepresentable
and that is usually discovered after data exists.

## Free-form response

The 404-versus-403 rule is the one thing here that is easy to get wrong and
hard to notice: replying to an id you cannot read must be indistinguishable
from replying to an id that does not exist.
