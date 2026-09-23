# `@erniesg/margin`

Durable text anchoring, selection capture and highlight painting for margin
annotations. No framework, no CSS framework, no hard-coded service origin, and
nothing that knows which document it is annotating.

It is the browser half of the margin. The service half is addressed only
through an injectable transport, so the package can be pointed at another host
— or at a stub — without a source change.

## Why anchoring is the hard part

A highlight is stored against text that is still being written. Offsets drift
the moment a sentence is inserted above it, and a quote can be reworded,
duplicated or moved into another block. So an annotation carries several
selectors at once and resolution tries them in order:

| order | selector               | what it means                                                                            |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------- |
| 1     | `struct-id`            | the block's stable id, and its digest still matches, so the text is byte-identical       |
| 2     | `position-and-context` | the stored offsets still hold the quote, with the stored neighbourhood around it         |
| 3     | `quote-and-context`    | the quote moved inside the block, but exactly one occurrence still has its neighbourhood |
| 4     | `unique-quote`         | the context is gone, but the quote occurs exactly once                                   |

`resolveTextAnchor` runs those four inside one node. `resolveAnchorInDocument`
runs them over a whole document and adds one more step that a single-node
resolver cannot do: if the quote is no longer in its block but is somewhere
else in the document, and exactly one candidate is identified, it re-anchors
there and reports `relocated-quote` with `movedFromNodeId` set.

When nothing identifies a single occurrence, the annotation is **orphaned, not
dropped**. An orphan carries its `quote`, its `reason` and a readable `detail`,
so the rail can keep showing it. Guessing between two equally good candidates
would attach a note to the wrong sentence, which is worse than telling the
reader it came loose.

## The anchor format

```jsonc
{
  "nodeId": "block-ch12-hash-maps-prose-3",
  // Optional. Present when the host's renderer emits stable block ids.
  "struct": { "id": "block-ch12-hash-maps-prose-3", "digest": "3f9a12c0b7d4" },
  "position": { "start": 412, "end": 468 },
  "quote": {
    "exact": "a hash map is an array you address by content",
    "prefix": "…the 32 characters before it…",
    "suffix": "…the 32 characters after it…",
  },
}
```

An omitted `positionUnit` means UTF-16 offsets, as produced by JavaScript DOM
selection. A wire anchor may explicitly carry `positionUnit: 'codepoint'` for
W3C character offsets. The span must equal the quote length in its stated
unit; the schema rejects anchors where it does not. `struct` is additive — an anchor stored
before struct ids existed resolves exactly as it did before.

Offsets are into the block's **anchorable text**: the concatenation of its
descendant text nodes, excluding any subtree matched by
`NON_ANNOTATABLE_SELECTOR` (figures, images, form controls, and anything marked
`data-margin-annotatable="false"`). A generated figure is redrawn on the next
build and has no durable text, so it is not in the coordinate space at all —
selecting inside one reports `non-annotatable` rather than storing an anchor
that will orphan.

## Using it

As a custom element:

```html
<margin-rail document-uri="https://example.test/books/a/ch1"></margin-rail>
<script type="module">
  import { defineMarginElements } from '@erniesg/margin'
  defineMarginElements()
</script>
```

It finds the document's text through `text-selector`, which defaults to
`[data-reading-column="text"]`, and reads blocks matching `[data-block-kind]`.
Everything it draws is in a shadow root, so it leaks no styles into the host
page and inherits none. The one stylesheet it adds to the host document holds
only `::highlight()` rules for the highlight names it registers, which can
match nothing else.

As a plain JS API, with no element at all:

```js
import { createMarginController, annotationsFromAnchors } from '@erniesg/margin'

const margin = createMarginController({
  root: document.querySelector('[data-reading-column="text"]'),
  onSelection(capture) {
    if (capture.status !== 'captured') return
    margin.render(
      annotationsFromAnchors(capture.anchors, {
        kind: 'highlight',
        color: 'amber',
      }),
    )
  },
})
margin.start()
```

React is a separate entry point and an optional peer dependency:

```jsx
import { MarginRail } from '@erniesg/margin/react'
```

`@erniesg/margin/anchor` is the anchoring core on its own. It touches no DOM
API, so a server or a build step can resolve anchors with it.

### Selection is not a mouse event

The capture path listens to `selectionchange` and to nothing else. A mouse
drag, a shift+arrow extension and a screen reader's own selection all leave the
same `Range` behind, so all three arrive at the same code and produce the same
anchor. There is no mouse-specific branch that a keyboard path could fall out
of step with.

A selection crossing block boundaries produces one anchor per block, in
document order, rather than failing.

### Painting

`paintHighlights` uses the CSS Custom Highlight API, which paints ranges the
browser holds outside the DOM. Overlapping highlights and multi-block ranges
therefore need no special handling, and the host's markup is left byte
identical — which matters, because the block digests an anchor resolves through
are taken over exactly that markup. Where the API is missing the fallback draws
absolutely positioned rectangles from `getClientRects()`, which also writes
nothing into the text.

### Talking to a service

```js
import {
  createHttpTransport,
  createMarginClient,
  createMarginController,
} from '@erniesg/margin'

const client = createMarginClient(
  createHttpTransport({ baseUrl: 'https://example.test' }),
)
const margin = createMarginController({
  root: document.querySelector('[data-reading-column="text"]'),
})

const captured = margin.capture()
if (captured.status === 'captured') {
  const blocks = margin.blocks()
  await client.createAnnotations({
    documentUri: 'https://example.test/books/a/ch1',
    kind: 'highlight',
    targets: captured.anchors,
    targetTexts: captured.anchors.map((anchor) => {
      const text = blocks.find((block) => block.id === anchor.nodeId)?.text
      if (text === undefined) throw new Error('Selected block text is missing')
      return text
    }),
  })
}
```

`baseUrl` is required. Every path the client builds starts with
`/api/margin/v1/`. Swap `createHttpTransport` for any object with a
`request({ path, method, body })` method to point the package somewhere else,
or at a stub.

`targetTexts` supplies each selected node's complete anchorable text in target
order. The client checks the quote and context against that text, then converts
UTF-16 positions to W3C codepoint positions before sending. It refuses a
missing or mismatched text input before sending any target in the request.
This includes ASCII selections because earlier text in the node can contain
non-BMP characters. An anchor already marked `positionUnit: 'codepoint'`
passes through without `targetTexts`; legacy stored wire anchors remain
readable through that explicit unit. For `@document`, provide the complete
ordered nonfigure text stream and the client omits the structural selector.

## Building and testing

```bash
npm run build --prefix packages/margin   # tsc -> dist/, with .d.ts
npm run test  --prefix packages/margin   # vitest, including the build itself
```

The package's own test suite compiles it with the build config, asserts the
compile is clean, asserts every path in `exports` is actually emitted, asserts
no book identifier reaches the output, and asserts no source file imports
anything outside the package other than its declared dependencies.

### A note on how it is wired into this repository

This package is published from a repository that is not itself an npm
workspace. The site imports it by relative path
(`../../packages/margin/src/...`) rather than by name; from the package's side
nothing changes, because the dependency only ever points inwards. Registering
`packages/*` under `workspaces` in the root `package.json` requires
regenerating `package-lock.json`, which is a separate change.
