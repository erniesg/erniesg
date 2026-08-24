export type SourceParityEntry = {
  readonly packagePath: string;
  readonly rule: string;
  readonly packageSha256: string;
};

/**
 * Immutable package-local source contract. The package tree is the only
 * source read by the conformance test; canonical app paths are retained only
 * as reviewed exclusions in the historical manifest contract.
 */
export const PARITY_SCHEMA_VERSION = 1 as const;

export const PARITY_ENTRIES: readonly SourceParityEntry[] = [
  {
    packagePath: "codec/bytes.ts",
    rule: "esm-imports",
    packageSha256:
      "04549a3f84594453ec90c319ad3b013ac479a99a1861c70344bc5b0cdc80b805",
  },
  {
    packagePath: "codec/index.ts",
    rule: "esm-imports",
    packageSha256:
      "c6e4d730dc782a400a833f79a14f672944e23d0cffd1ac38243b2ae2995eacac",
  },
  {
    packagePath: "codec/invariants.ts",
    rule: "generic-model-invariants",
    packageSha256:
      "1d317a67ecbfa7eda8c9c820524f5449a7aa806ac9228141112c81750ba3c5f2",
  },
  {
    packagePath: "codec/parsers.ts",
    rule: "generic-model-parser",
    packageSha256:
      "620f330d7f5c73342c82a0eb9cff5f4b18a6b5797a2e160a4881757ec91fae33",
  },
  {
    packagePath: "codec/primitives.ts",
    rule: "safe-id-primitives",
    packageSha256:
      "707ced139e00b4d80aae27d52d7f4fb3ef6e604296be874677643715047287c5",
  },
  {
    packagePath: "codec/structure.ts",
    rule: "esm-imports",
    packageSha256:
      "1241ab23eb0da2cd85f7e0ac198b442a4cc0246d75f67603d2980cbe4387fe3e",
  },
  {
    packagePath: "core.ts",
    rule: "codec-facade",
    packageSha256:
      "5ea085ff0a109434009af112ccb987501ae178549589018749b422840bfb32d2",
  },
  {
    packagePath: "epub.ts",
    rule: "generic-model-epub",
    packageSha256:
      "4be79a389054a86b084660f64890966dc290a575a078120bab7d969208d5a429",
  },
  {
    packagePath: "ids.ts",
    rule: "esm-imports",
    packageSha256:
      "556f86b46550760719984d392266f551e1b3a73b8dc25854f59f5e925e684202",
  },
  {
    packagePath: "index.ts",
    rule: "root-facade",
    packageSha256:
      "c11c52ee11d9104701bd9351466ac92d99e5f0f97136f20decf6cfd57b886a43",
  },
  {
    packagePath: "model-consultation-receipt.ts",
    rule: "generic-receipt",
    packageSha256:
      "c98da5d50eaee762fe01c4f1ad326d20d55f3b5d8d14041696866d6f21d66bc6",
  },
  {
    packagePath: "reading-order.ts",
    rule: "esm-imports",
    packageSha256:
      "7c496f3d4bb72f2810e8f9a3ef8a3cc04d359d85158a8148d6ce03bad81cd1d9",
  },
  {
    packagePath: "recovery.ts",
    rule: "esm-imports",
    packageSha256:
      "ac2ab6b8f674008c09a69aad84766c922e767e500e82011c1042656bde754c79",
  },
  {
    packagePath: "renderers/epub.ts",
    rule: "renderer-epub-facade",
    packageSha256:
      "77dfd2ce81a50ef6e5bcee424b04add78b979fa5f626fd504b8f8abaff535452",
  },
  {
    packagePath: "renderers/xhtml.ts",
    rule: "renderer-xhtml-facade",
    packageSha256:
      "6907f349531561be4247374af910145a132d0c240bde6e26a4a78d7f32b680d5",
  },
  {
    packagePath: "schema.ts",
    rule: "package-only-schema",
    packageSha256:
      "b3835d149b5f8dc96c0ccac7d9c2604799a57ebdb2e82f64f7d994741d2d4471",
  },
  {
    packagePath: "sha256.ts",
    rule: "byte-identical",
    packageSha256:
      "7c240348df2f60ec53ee870346ab4d1ac2dfff16b8a32b1464b7b875c1c749f4",
  },
  {
    packagePath: "types.ts",
    rule: "generic-model-types",
    packageSha256:
      "9aaf1e51c0167dd3445db491fdd5e36f5ac120d63a033e147e84d223c8195083",
  },
  {
    packagePath: "xhtml.ts",
    rule: "esm-imports",
    packageSha256:
      "4014eb7be096e01508287c33060a64fb2a5abb66040f00bb36ed8677ca4692a3",
  },
] as const;

export const EXCLUDED_CANONICAL: Readonly<Record<string, string>> = {
  "codec/model.ts":
    "PDF-coupled model receipt codec is forbidden from the package",
  "codec.test.ts":
    "canonical codec suite is app-coupled; package characterization suite is maintained locally",
  "epub-integrity.test.ts":
    "canonical EPUB suite is app-coupled; package characterization suite is maintained locally",
  "from-reconstruction.ts":
    "historical compatibility shim for the app-owned extractor adapter is outside package core",
  "struct.test.ts":
    "canonical integration suite imports app/PDF providers; package characterization suites are maintained locally",
} as const;

export const PARITY_MANIFEST_SHA256 =
  "9a141b01808d04f22c40f001b495825dba7fc129e2997db9ad5406a8a43fc714";
