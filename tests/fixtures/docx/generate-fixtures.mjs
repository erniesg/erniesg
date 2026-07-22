import { writeFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'

const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)

const xml = (value) => [strToU8(value), { level: 6, mtime: ZIP_MTIME }]
const binary = (value) => [value, { level: 6, mtime: ZIP_MTIME }]

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>
`

const packageRelationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>
`

const coreProperties = `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Explicit Structures Across Languages</dc:title>
  <dc:subject>A deterministic synthetic manuscript</dc:subject>
  <dc:creator>Ada Example; 李明</dc:creator>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2026-07-18T00:00:00Z</dcterms:modified>
</cp:coreProperties>
`

const styles = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Abstract"><w:name w:val="Abstract"/></w:style>
  <w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style>
</w:styles>
`

const numbering = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>
`

const footnotes = `<?xml version="1.0" encoding="UTF-8"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>Footnote text resolved from its explicit OOXML id.</w:t></w:r></w:p></w:footnote>
</w:footnotes>
`

const endnotes = `<?xml version="1.0" encoding="UTF-8"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:id="2"><w:p><w:r><w:endnoteRef/></w:r><w:r><w:t>Endnote text remains linked without geometric matching.</w:t></w:r></w:p></w:endnote>
</w:endnotes>
`

function documentXml({ malformed = false } = {}) {
  const imageRelationship = malformed ? 'rId404' : 'rId4'
  const footnoteId = malformed ? '99' : '1'
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Explicit Structures Across Languages</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Abstract"/></w:pPr><w:r><w:t>This local fixture preserves multilingual text: café, العربية, 日本語.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Deterministic relationships</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Plain, </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>
      <w:r><w:t xml:space="preserve">, </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>
      <w:r><w:t xml:space="preserve">, and </w:t></w:r>
      <w:hyperlink r:id="rId5"><w:r><w:t>linked text</w:t></w:r></w:hyperlink>
      <w:r><w:t xml:space="preserve"> carry a footnote</w:t><w:footnoteReference w:id="${footnoteId}"/><w:t xml:space="preserve"> and endnote</w:t><w:endnoteReference w:id="2"/><w:t>.</w:t></w:r>
    </w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Ordered parent item</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Nested bullet item</w:t></w:r></w:p>
    <w:p>
      <w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Synthetic figure" descr="A source-authored geometric figure"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${imageRelationship}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>
    </w:p>
    <w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 1. A source-preserved synthetic image.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Table 1. A semantic comparison.</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Language</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Greeting</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>English</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>中文</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>你好</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:sectPr/>
  </w:body>
</w:document>
`
}

function documentRelationships({ malformed = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure.png"/>
  ${malformed ? '<Relationship Id="rId404" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/missing.png"/>' : ''}
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/source" TargetMode="External"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>
`
}

// A tiny repository-owned PNG; no private or externally licensed content.
const figurePng = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
)

function fixture({ malformed = false } = {}) {
  return zipSync({
    '[Content_Types].xml': xml(contentTypes),
    '_rels/.rels': xml(packageRelationships),
    'docProps/core.xml': xml(coreProperties),
    'word/document.xml': xml(documentXml({ malformed })),
    'word/_rels/document.xml.rels': xml(documentRelationships({ malformed })),
    'word/styles.xml': xml(styles),
    'word/numbering.xml': xml(numbering),
    'word/footnotes.xml': xml(footnotes),
    'word/endnotes.xml': xml(endnotes),
    ...(!malformed ? { 'word/media/figure.png': binary(figurePng) } : {}),
  })
}

writeFileSync(new URL('structured-manuscript.docx', import.meta.url), fixture())
writeFileSync(
  new URL('malformed-manuscript.docx', import.meta.url),
  fixture({ malformed: true }),
)
