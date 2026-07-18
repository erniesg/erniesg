import type { ResearchPaper } from '@/research/schema'

export default function ResearchPaperActions({
  paper,
}: {
  paper: ResearchPaper
}) {
  const exports = `/research/${paper.id}/exports`

  return (
    <nav aria-label="Paper downloads">
      <a href={`${exports}/print.pdf`}>Paginated PDF</a>
      <a href={`${exports}/reflowable.html`}>Reflowable HTML</a>
      <a href={`${exports}/publication.epub`}>EPUB</a>
      <a href={`${exports}/publication-paperpro.epub`}>Paper Pro EPUB</a>
      <a href={`${exports}/publication-papermove.epub`}>Paper Pro Move EPUB</a>
      <a href={`${exports}/source.json`}>Source graph</a>
      <a href={`${exports}/layout-manifest.json`}>Layout manifest</a>
      <a href={`${exports}/export-manifest.json`}>Export manifest</a>
    </nav>
  )
}
