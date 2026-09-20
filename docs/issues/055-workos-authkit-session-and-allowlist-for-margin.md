# WorkOS AuthKit session and an allowlist for margin

depends-on: 054

## Provider

claude

## Goal

Replace 054's dev principal stub with a real WorkOS AuthKit session, and gate
writing behind an allowlist. Reading the book stays open to everyone, logged
out. Annotating, commenting and proposing edits require a signed-in identity
on a list the owner controls. Applying an edit requires `hello@ernie.sg`.

Berlayar central auth already exists and the user base is shared: anyone who
can sign into `rucksack.berlayar.ai` has an account that works here, same
hosted login, no new signup. What does not exist is an application
registration for this surface — WorkOS bakes the callback allowlist into the
`client_id` and every API validates the `client_id` claim per application.
`CENTRAL_AUTH.md` is explicit: "Do not reuse Paillette's client ID for
Rucksack. Separate application objects limit redirect, credential, and session
blast radius."

## Observed failure

- `getPrincipal` is a dev stub keyed by an env var. Any caller can claim any
  identity, so 054's visibility rule currently protects nothing in production.
- No WorkOS application exists for `ernie.sg`. The live credential set on the
  trusted VM at `~/.config/rucksack/product.env` belongs to the Rucksack
  application and its redirect allowlist points at `rucksack.berlayar.ai`; it
  will not redirect to `ernie.sg`.

## Success criteria

1. Authorization-code flow through AuthKit's hosted UI. The code is exchanged
   server-side and a sealed session is stored in an app-specific cookie named
   `margin-session`, `Secure`, `HttpOnly`, `SameSite=Lax`, narrowest viable
   path, never scoped to a parent domain.
2. Token validation fails closed and checks all of: signature and allowed
   algorithm, expiry and activation, exact environment issuer, exact
   application `client_id` claim, non-empty subject. Provider or JWKS failure
   never falls back to a trusted header, an email, or public access.
3. Identity is stored as `(provider, issuer, subject)`, unique and idempotent.
   Email is profile data only and is never the durable key.
4. An `allowlist` table holds the identities permitted to write. Reading a
   document requires nothing. Creating or editing any annotation requires an
   allowlist entry. `POST /proposals/:id/apply` requires the admin identity,
   bound once to `hello@ernie.sg` by verified email and thereafter authorized
   by `(issuer, sub)`.
5. Only `getPrincipal`'s implementation changes. Route handlers, the
   repository interface and the visibility queries from 054 are untouched.
6. `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`. Only a
   validated same-origin return path is preserved across login.
7. Secrets are read from the deployment platform's store and appear in no
   file, bundle, log, test fixture or issue comment.

## Acceptance tests

- Anonymous read of a public annotation succeeds; anonymous write is 401.
- Signed in but not on the allowlist: read succeeds, write is 403.
- A token from a different WorkOS application (wrong `client_id`) is rejected.
- An expired token is rejected; a token with a valid signature but the wrong
  issuer is rejected.
- Two allowlisted users cannot read each other's private annotations,
  re-running 054's isolation test against real sessions.
- `apply` is 403 for an allowlisted non-admin and succeeds for the admin.
- With the WorkOS provider unreachable, every authenticated route fails closed
  and no route falls back to a header-supplied identity.

## Definition of done

All acceptance tests pass against the WorkOS staging environment; the dev stub
is unreachable in a production build; no secret value appears in the repo or
in CI output.

## Validation command

```bash
npm test
npx vitest run src/worker/margin
npm run build
```

## Allowed secrets

`WORKOS_ISSUER`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`,
`WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI` — by name only, from the
platform secret store. Never written to any file in the repository.

## Artifact outputs

The AuthKit flow and sealed-session handling; token validation; the
`(provider, issuer, subject)` identity table; the allowlist table and its
checks; the real `getPrincipal`; tests.

## Stop conditions

**This issue cannot complete without a human.** Creating a WorkOS application
is a dashboard action with no public API. Stop and apply
`rucksack-needs-human` when the credentials are absent, having built and
tested everything reachable against the staging environment or a local mock.

Also stop before authorizing by email anywhere except the single admin
bootstrap, before placing a cookie on `.berlayar.ai`, and before letting any
provider failure degrade to public access.

## Human clarification protocol

Required from the owner, in the WorkOS dashboard, about two minutes:

1. Create an application named `Margin` in both WorkOS environments.
2. Add callback URLs `https://ernie.sg/auth/callback` and the local dev URL.
3. Provide `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`.

`WORKOS_ISSUER` is derivable, `WORKOS_REDIRECT_URI` is ours to choose, and
`WORKOS_COOKIE_PASSWORD` is a generated random value — those three need no
human. Ask for the two values and nothing else.

## Recommended response

Use `rucksack/src/rucksack/workos_auth.py` as the contract reference — it is
229 lines already serving `rucksack.berlayar.ai` and it names exactly the
claims to verify. Port the checks, not the code; this surface is TypeScript.

## Trade-offs

An allowlist means the book is readable by everyone but writable by few. That
is deliberate for a first release: it ships with no moderation, rate-limiting
or spam surface, and opening it up later is deleting one check rather than
building a moderation system.

## Free-form response

Because the Berlayar user base is shared per environment, the allowlist is the
only thing standing between "has a Berlayar account" and "can write on the
book". It is therefore the security boundary, not a convenience.
