import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageManifest = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
const consumerRoot = await mkdtemp(join(tmpdir(), "struct-consumer-"));
let tarballPath;

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  )[0];
  tarballPath = join(packageRoot, packed.filename);
  assert.equal(packed.name, "@erniesg/struct");
  assert.equal(packed.version, "0.1.0-rc.0");

  execFileSync("npm", ["init", "--yes"], {
    cwd: consumerRoot,
    stdio: "ignore",
  });
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-package-lock", tarballPath],
    { cwd: consumerRoot, stdio: "inherit" },
  );

  const installedRoot = join(
    consumerRoot,
    "node_modules",
    "@erniesg",
    "struct",
  );
  const installedManifest = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(installedManifest.exports), [
    ".",
    "./core",
    "./schema",
    "./ids",
    "./recovery",
    "./renderers/xhtml",
    "./renderers/epub",
  ]);

  const declarationPaths = Object.values(installedManifest.exports).flatMap(
    (entry) => [entry.types],
  );
  for (const declarationPath of declarationPaths) {
    await stat(join(installedRoot, declarationPath));
  }

  const probePath = join(consumerRoot, "installed-consumer.mjs");
  await writeFile(probePath, consumerProbeSource(), "utf8");
  const probe = await import(probePath);
  const { root, core, schema, ids, recovery, xhtml, epub } = probe;

  assert.equal(schema.STRUCT_SCHEMA_VERSION, "0.2.0");
  assert.match(ids.structId("consumer", "sample"), /^struct-consumer-/u);
  assert.equal(
    recovery.recoverySummary({ ready: true, diagnostics: [] }).status,
    "ready",
  );

  const document = consumerDocument(root.structDigest);
  const encoded = root.encodeStructDocument(document);
  const decoded = root.decodeStructDocument(encoded);
  assert.deepEqual(decoded, document);
  assert.equal(
    core.pageLayoutsFromBlocks(
      [{ page: 1, width: 600, height: 800, rotation: 0 }],
      decoded.blocks,
    )[0].blocks[0],
    "consumer-block",
  );
  assert.match(xhtml.renderPublicationXhtml(decoded), /Consumer/u);
  const exportResult = await epub.buildStructEpub(decoded);
  assert.equal(exportResult.mediaType, "application/epub+zip");
  assert.ok(exportResult.bytes.byteLength > 0);

  console.log(
    JSON.stringify({
      tarball: packed.filename,
      exports: Object.keys(installedManifest.exports),
      declarations: declarationPaths.length,
      privatePathRefusals: 2,
    }),
  );
} finally {
  if (tarballPath) await rm(tarballPath, { force: true });
  await rm(consumerRoot, { recursive: true, force: true });
}

function consumerProbeSource() {
  return `
import assert from "node:assert/strict";

const publicSpecifiers = [
  "@erniesg/struct",
  "@erniesg/struct/core",
  "@erniesg/struct/schema",
  "@erniesg/struct/ids",
  "@erniesg/struct/recovery",
  "@erniesg/struct/renderers/xhtml",
  "@erniesg/struct/renderers/epub",
];
const installedRootUrl = new URL(
  ".",
  await import.meta.resolve("@erniesg/struct"),
);
const publicResolvedUrls = await Promise.all(
  publicSpecifiers.map((specifier) => import.meta.resolve(specifier)),
);
for (const resolvedUrl of publicResolvedUrls) {
  assert.ok(
    resolvedUrl.startsWith(installedRootUrl.href),
    resolvedUrl + " must resolve below " + installedRootUrl.href,
  );
}

export const root = await import("@erniesg/struct");
export const core = await import("@erniesg/struct/core");
export const schema = await import("@erniesg/struct/schema");
export const ids = await import("@erniesg/struct/ids");
export const recovery = await import("@erniesg/struct/recovery");
export const xhtml = await import("@erniesg/struct/renderers/xhtml");
export const epub = await import("@erniesg/struct/renderers/epub");

await assert.rejects(
  import("@erniesg/struct/src/index.js"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);
await assert.rejects(
  import("@erniesg/struct/package.json"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);
`;
}

function consumerDocument(structDigest) {
  const sourceSha256 = "b".repeat(64);
  const document = {
    schemaVersion: "0.2.0",
    documentId: "consumer-document",
    source: {
      format: "unknown",
      fileName: "consumer.struct",
      sha256: sourceSha256,
      byteLength: 13,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: "Consumer",
      subtitle: "",
      authors: ["Fixture Author"],
      abstract: "",
      updated: "2026-08-20",
    },
    blocks: [
      {
        id: "consumer-block",
        kind: "paragraph",
        text: "Consumer text",
        page: 1,
        order: 0,
        column: "single",
        inline: [],
        evidence: {
          confidence: 1,
          pages: [1],
          boxes: [],
          sourceIds: ["source-node"],
        },
      },
    ],
    assets: [],
    relationships: [],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ["consumer-block"],
        columns: [
          {
            id: "consumer-column",
            side: "single",
            blockIds: ["consumer-block"],
          },
        ],
      },
    ],
    diagnostics: [],
    recovery: {
      status: "ready",
      title: "Ready",
      summary: "Ready",
      issues: [],
    },
    receipt: {
      schemaVersion: "0.2.0",
      documentId: "consumer-document",
      sourceSha256,
      blockCount: 1,
      assetCount: 0,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount: 13,
      conservation: {
        sourceNodeCount: 1,
        accountedSourceNodeCount: 1,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceAssetCount: 0,
        accountedSourceAssetCount: 0,
        sourceRelationshipCount: 0,
        accountedSourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: 13,
        structBlockCount: 1,
        structAssetCount: 0,
        structRelationshipCount: 0,
        structDiagnosticCount: 0,
        structTextCharacterCount: 13,
      },
      generatedSha256: "",
    },
  };
  const { receipt, ...withoutReceipt } = document;
  receipt.generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    assets: [],
  });
  return document;
}
