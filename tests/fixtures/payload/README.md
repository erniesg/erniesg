# Local Payload export fixture

The adapter consumes decoded JSON; it does not connect to Payload Local API,
REST, or GraphQL and it never fetches an upload URL. `publication.json` is the
document shape used by the tests:

- scalar publication fields (`id`, `title`, `description`, `authors`, `locale`,
  `status`, and `version`);
- `content.root.children`, containing typed Lexical nodes;
- `uploads`, whose embedded `data` is base64 and whose descriptors carry media,
  accessibility, dimensions, focal point, and crop metadata; and
- optional `localeVariants`, an object keyed by canonical BCP-47 locale.

`mapping.json` is a strict, versioned policy. Field paths and block/relationship
maps are data only. Function values, hooks, resolvers, prototype keys, and
other executable values are rejected before mapping.

Missing upload bytes produce a `missing-asset` diagnostic and a source-text
fallback. A remote `url` is retained only as source data and is never read.
