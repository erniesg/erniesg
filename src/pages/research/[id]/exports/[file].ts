import { createDemoAnnotations } from '@/research/annotations'
import {
  buildExportPackage,
  EXPORT_PACKAGE_PATHS,
  getExportFile,
  type ExportPackagePath,
} from '@/research/export-package'
import { getDefaultExportOverrides } from '@/research/overrides'
import { papers } from '@/research/papers'

type ExportProps = {
  paper: (typeof papers)[number]
  file: ExportPackagePath
}

export function getStaticPaths() {
  return papers.flatMap((paper) =>
    EXPORT_PACKAGE_PATHS.map((file) => ({
      params: { id: paper.id, file },
      props: { paper, file },
    })),
  )
}

export async function GET({ props }: { props: ExportProps }) {
  const exportPackage = await buildExportPackage(
    props.paper,
    createDemoAnnotations(props.paper),
    getDefaultExportOverrides(props.paper.id),
  )
  const artifact = getExportFile(exportPackage, props.file)
  const disposition =
    artifact.path.endsWith('.epub') || artifact.path === 'checksums.sha256'
      ? 'attachment'
      : 'inline'
  const body = artifact.bytes.slice().buffer as ArrayBuffer

  return new Response(body, {
    headers: {
      'Content-Type': artifact.mediaType,
      'Content-Disposition': `${disposition}; filename="${artifact.path}"`,
    },
  })
}
