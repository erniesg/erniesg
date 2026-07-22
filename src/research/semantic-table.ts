export type StrictSemanticTableCell = {
  text: string
  headerScope: 'column' | 'row' | null
  columnSpan: number
  rowSpan: number
}

export type StrictSemanticTable = {
  rows: Array<{ cells: StrictSemanticTableCell[] }>
}

const HEADER_SCOPES = new Set<unknown>(['column', 'row', null])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function normalizedText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

function validCell(value: unknown): value is StrictSemanticTableCell {
  return (
    isRecord(value) &&
    normalizedText(value.text).length > 0 &&
    HEADER_SCOPES.has(value.headerScope) &&
    positiveInteger(value.columnSpan) &&
    positiveInteger(value.rowSpan)
  )
}

function rectangularGrid(rows: StrictSemanticTable['rows']) {
  const occupied: boolean[][] = Array.from({ length: rows.length }, () => [])
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (const cell of rows[rowIndex].cells) {
      let column = 0
      while (occupied[rowIndex][column]) column += 1
      if (rowIndex + cell.rowSpan > rows.length) return null
      for (
        let targetRow = rowIndex;
        targetRow < rowIndex + cell.rowSpan;
        targetRow += 1
      ) {
        for (
          let targetColumn = column;
          targetColumn < column + cell.columnSpan;
          targetColumn += 1
        ) {
          if (occupied[targetRow][targetColumn]) return null
          occupied[targetRow][targetColumn] = true
        }
      }
    }
  }
  const width = Math.max(0, ...occupied.map((row) => row.length))
  if (
    width < 2 ||
    occupied.some(
      (row) =>
        row.length !== width ||
        Array.from({ length: width }, (_, index) => row[index] === true).some(
          (present) => !present,
        ),
    )
  ) {
    return null
  }
  return { rows: rows.length, columns: width }
}

export function isStrictSemanticTable(
  table: unknown,
): table is StrictSemanticTable {
  if (!isRecord(table) || !Array.isArray(table.rows) || table.rows.length < 2) {
    return false
  }
  if (
    table.rows.some(
      (row) =>
        !isRecord(row) ||
        !Array.isArray(row.cells) ||
        row.cells.length === 0 ||
        row.cells.some((cell) => !validCell(cell)),
    )
  ) {
    return false
  }
  const rows = table.rows as StrictSemanticTable['rows']
  if (!rectangularGrid(rows)) return false

  const hasColumnHeader = rows[0].cells.every(
    ({ headerScope }) => headerScope === 'column',
  )
  const hasRowHeaders = rows.every(({ cells }) =>
    cells.some(({ headerScope }) => headerScope === 'row'),
  )
  return hasColumnHeader || hasRowHeaders
}

function attributeInteger(attributes: string, name: string) {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:["'](\\d+)["']|(\\d+))`, 'iu'),
  )
  if (!match) return 1
  const value = Number(match[1] ?? match[2])
  return positiveInteger(value) ? value : null
}

function attributeValue(attributes: string, name: string) {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']+)["']|([^\\s>]+))`, 'iu'),
  )
  return (match?.[1] ?? match?.[2] ?? '').toLowerCase()
}

function decodeHtmlText(value: string) {
  const entities = new Map<string, string>([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ])
  return normalizedText(
    value
      .replace(/<br\s*\/?\s*>/giu, ' ')
      .replace(/<[^>]*>/gu, ' ')
      .replace(
        /&(?:#(\d+)|#x([a-f0-9]+)|([a-z]+));/giu,
        (original, decimal, hexadecimal, named) => {
          const codePoint = decimal
            ? Number(decimal)
            : hexadecimal
              ? Number.parseInt(hexadecimal, 16)
              : null
          if (codePoint !== null && Number.isSafeInteger(codePoint)) {
            try {
              return String.fromCodePoint(codePoint)
            } catch {
              return original
            }
          }
          return entities.get(named?.toLowerCase()) ?? original
        },
      ),
  )
}

export function semanticTableFromHtml(
  html: unknown,
): StrictSemanticTable | null {
  if (typeof html !== 'string') return null
  const tableMatch = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/iu)
  if (!tableMatch) return null
  const rows: StrictSemanticTable['rows'] = []
  for (const rowMatch of tableMatch[1].matchAll(
    /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu,
  )) {
    const cells: StrictSemanticTableCell[] = []
    for (const cellMatch of rowMatch[1].matchAll(
      /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
    )) {
      const columnSpan = attributeInteger(cellMatch[2], 'colspan')
      const rowSpan = attributeInteger(cellMatch[2], 'rowspan')
      if (columnSpan === null || rowSpan === null) return null
      const sourceScope = attributeValue(cellMatch[2], 'scope')
      const headerScope =
        cellMatch[1].toLowerCase() !== 'th'
          ? null
          : sourceScope === 'row'
            ? 'row'
            : sourceScope === 'col' || sourceScope === 'column'
              ? 'column'
              : rows.length === 0
                ? 'column'
                : 'row'
      cells.push({
        text: decodeHtmlText(cellMatch[3]),
        headerScope,
        columnSpan,
        rowSpan,
      })
    }
    rows.push({ cells })
  }
  const table = { rows }
  return isStrictSemanticTable(table) ? table : null
}
