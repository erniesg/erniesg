import { sha256 } from './content.mjs'

const FENCE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g
const INLINE_CODE_RE = /`[^`\n]+`/g
const IMPORT_EXPORT_RE = /^(?:import|export)\s.+$/gm
const URL_RE = /https?:\/\/[^\s)>"']+/g
const FIXED_ATTR_RE =
  /\b(?:src|href|data-[\w-]+|id|class|preload|controls|width|height|loading|decoding|target|rel)=["'][^"']*["']/g

function collectMatches(text, regex, kind, regions) {
  for (const match of text.matchAll(regex)) {
    const start = match.index + (match[1] ? match[1].length : 0)
    const raw = match[0].slice(match[1] ? match[1].length : 0)
    regions.push({
      kind,
      start,
      end: start + raw.length,
      text: raw,
    })
  }
}

export function getLockedRegions(text) {
  const regions = []
  collectMatches(text, FENCE_RE, 'code-fence', regions)
  collectMatches(text, INLINE_CODE_RE, 'inline-code', regions)
  collectMatches(text, IMPORT_EXPORT_RE, 'module-statement', regions)
  collectMatches(text, URL_RE, 'url', regions)
  collectMatches(text, FIXED_ATTR_RE, 'fixed-attribute', regions)
  return mergeRegions(regions)
}

export function mergeRegions(regions) {
  return [...regions]
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .reduce((merged, region) => {
      const previous = merged.at(-1)
      if (!previous || region.start > previous.end) {
        merged.push({ ...region })
        return merged
      }
      if (region.end > previous.end) {
        previous.end = region.end
        previous.text = previous.text + region.text.slice(previous.text.length)
      }
      return merged
    }, [])
}

export function isInsideLockedRegion(start, end, regions) {
  return regions.some((region) => start >= region.start && end <= region.end)
}

export function lockedRegionHash(text) {
  const payload = getLockedRegions(text).map((region) => ({
    kind: region.kind,
    start: region.start,
    end: region.end,
    text: text.slice(region.start, region.end),
  }))
  return sha256(JSON.stringify(payload))
}

export function assertLockedRegionsPreserved(source, output) {
  const missing = getLockedRegions(source).filter((region) => {
    const slice = source.slice(region.start, region.end)
    return slice.trim() !== '' && !output.includes(slice)
  })

  if (missing.length > 0) {
    const labels = missing
      .slice(0, 5)
      .map((region) => `${region.kind}@${region.start}-${region.end}`)
      .join(', ')
    throw new Error(`Locked MDX regions were modified or removed: ${labels}`)
  }
}
