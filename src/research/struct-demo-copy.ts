import {
  SITE_LOCALE_STORAGE_KEY,
  LEGACY_BLOG_LOCALE_STORAGE_KEY,
} from '../lib/site-preferences'
import type { SupportedLocale } from '../lib/i18n'

const en = {
  remaining: (remaining: number, limit: number) =>
    `${remaining}/${limit} today`,
  limit: 'The daily limit has been reached.',
  reset: (time: string) => ` Resets at ${time}.`,
  nextReset: ' Resets at the next UTC day.',
  samples: ' Preconverted samples still work.',
  unavailable: 'Uploads are unavailable. Samples still work.',
  complete: 'Conversion complete. Your EPUB is ready.',
  noEpub:
    'Conversion finished, but no EPUB is available. Please try another PDF.',
  failed: 'Conversion failed. Please try another PDF.',
  queued: 'Your PDF is queued for conversion.',
  running: 'Converting your PDF…',
  paused:
    'Status checking paused. Your upload may still be converting. Retry to check its progress; do not upload it again.',
  busy: 'The converter is busy. Try again shortly. Preconverted samples still work.',
  temporary:
    'Conversion is temporarily unavailable. Try again shortly. Preconverted samples still work.',
  requestFailed:
    'The conversion request could not be confirmed. Check availability before trying again.',
  choose: 'Choose a PDF first.',
  oversize: (size: number) => `Choose a PDF no larger than ${size} MiB.`,
  invalid:
    'Choose a valid PDF file. Renaming another file to .pdf will not work.',
  uploading: 'Uploading your PDF…',
  uploadFailed:
    'The upload could not be confirmed. Check availability before trying again.',
  requestPaper: 'Requesting this paper from arXiv for conversion…',
  download: (name: string) => `Download ${name}`,
  retry: 'Retry status check',
  refresh: 'Check upload availability',
}
type DemoCopy = typeof en
const copy: Record<SupportedLocale, DemoCopy> = {
  en,
  zh: {
    remaining: (remaining, limit) => `${remaining}/${limit}（今日）`,
    limit: '已达到每日限额。',
    reset: (time) => ` 将于 ${time} 重置。`,
    nextReset: ' 将于下一个 UTC 日重置。',
    samples: ' 已转换的示例仍可使用。',
    unavailable: '上传暂不可用。样本仍可浏览。',
    complete: '转换完成，EPUB 已准备好。',
    noEpub: '转换已结束，但没有可用的 EPUB。请尝试其他 PDF。',
    failed: '转换失败，请尝试其他 PDF。',
    queued: '您的 PDF 已加入转换队列。',
    running: '正在转换您的 PDF…',
    paused:
      '状态检查已暂停。您的文件可能仍在转换，请重试以查看进度，不要重复上传。',
    busy: '转换服务正忙，请稍后重试。已转换的示例仍可使用。',
    temporary: '转换服务暂时不可用，请稍后重试。已转换的示例仍可使用。',
    requestFailed: '无法确认转换请求，请先检查服务是否可用，再重试。',
    choose: '请先选择 PDF。',
    oversize: (size) => `请选择不超过 ${size} MiB 的 PDF。`,
    invalid: '请选择有效的 PDF 文件。将其他文件重命名为 .pdf 无法完成转换。',
    uploading: '正在上传您的 PDF…',
    uploadFailed: '无法确认上传，请先检查服务是否可用，再重试。',
    requestPaper: '正在从 arXiv 获取此论文以进行转换…',
    download: (name) => `下载 ${name}`,
    retry: '重新检查状态',
    refresh: '检查上传服务是否可用',
  },
  ja: {
    remaining: (remaining, limit) => `${remaining}/${limit}（今日）`,
    limit: '1日の上限に達しました。',
    reset: (time) => ` ${time} にリセットされます。`,
    nextReset: ' 次の UTC 日にリセットされます。',
    samples: ' 変換済みのサンプルは引き続き利用できます。',
    unavailable: 'アップロードは利用できません。サンプルは閲覧できます。',
    complete: '変換が完了しました。EPUB をダウンロードできます。',
    noEpub:
      '変換は終了しましたが、EPUB がありません。別の PDF をお試しください。',
    failed: '変換に失敗しました。別の PDF をお試しください。',
    queued: 'PDF は変換待ちです。',
    running: 'PDF を変換しています…',
    paused:
      '状態の確認を中断しました。変換は続いている可能性があります。再確認して進捗を確認してください。同じファイルを再アップロードしないでください。',
    busy: '変換サービスが混み合っています。少し待ってから再試行してください。変換済みのサンプルは引き続き利用できます。',
    temporary:
      '変換は一時的に利用できません。少し待ってから再試行してください。変換済みのサンプルは引き続き利用できます。',
    requestFailed:
      '変換リクエストを確認できませんでした。利用状況を確認してから再試行してください。',
    choose: 'まず PDF を選択してください。',
    oversize: (size) => `${size} MiB 以下の PDF を選択してください。`,
    invalid:
      '有効な PDF ファイルを選択してください。別のファイルを .pdf に改名しても変換できません。',
    uploading: 'PDF をアップロードしています…',
    uploadFailed:
      'アップロードを確認できませんでした。利用状況を確認してから再試行してください。',
    requestPaper: '変換のために arXiv から論文を取得しています…',
    download: (name) => `${name} をダウンロード`,
    retry: '状態を再確認',
    refresh: 'アップロードの利用状況を確認',
  },
  ko: {
    remaining: (remaining, limit) => `${remaining}/${limit} (오늘)`,
    limit: '하루 한도에 도달했습니다.',
    reset: (time) => ` ${time}에 초기화됩니다.`,
    nextReset: ' 다음 UTC 날짜에 초기화됩니다.',
    samples: ' 변환된 샘플은 계속 이용할 수 있습니다.',
    unavailable: '업로드를 사용할 수 없습니다. 샘플은 볼 수 있습니다.',
    complete: '변환이 완료되었습니다. EPUB을 다운로드할 수 있습니다.',
    noEpub: '변환은 끝났지만 EPUB이 없습니다. 다른 PDF를 시도해 주세요.',
    failed: '변환에 실패했습니다. 다른 PDF를 시도해 주세요.',
    queued: 'PDF가 변환 대기열에 있습니다.',
    running: 'PDF를 변환하고 있습니다…',
    paused:
      '상태 확인이 일시 중지되었습니다. 파일이 아직 변환 중일 수 있습니다. 다시 확인하여 진행 상황을 확인해 주세요. 같은 파일을 다시 업로드하지 마세요.',
    busy: '변환 서비스가 혼잡합니다. 잠시 후 다시 시도해 주세요. 변환된 샘플은 계속 이용할 수 있습니다.',
    temporary:
      '변환 서비스를 일시적으로 이용할 수 없습니다. 잠시 후 다시 시도해 주세요. 변환된 샘플은 계속 이용할 수 있습니다.',
    requestFailed:
      '변환 요청을 확인하지 못했습니다. 이용 가능 여부를 확인한 후 다시 시도해 주세요.',
    choose: '먼저 PDF를 선택해 주세요.',
    oversize: (size) => `${size} MiB 이하의 PDF를 선택해 주세요.`,
    invalid:
      '유효한 PDF 파일을 선택해 주세요. 다른 파일의 이름을 .pdf로 바꿔도 변환할 수 없습니다.',
    uploading: 'PDF를 업로드하고 있습니다…',
    uploadFailed:
      '업로드를 확인하지 못했습니다. 이용 가능 여부를 확인한 후 다시 시도해 주세요.',
    requestPaper: '변환을 위해 arXiv에서 논문을 가져오고 있습니다…',
    download: (name) => `${name} 다운로드`,
    retry: '상태 다시 확인',
    refresh: '업로드 이용 가능 여부 확인',
  },
}

function supported(value: string | null): SupportedLocale | undefined {
  const language = value?.toLowerCase().split('-')[0]
  return language && Object.hasOwn(copy, language)
    ? (language as SupportedLocale)
    : undefined
}

/** The rendered page language wins; preferences cover the unprefixed page. */
export function currentStructDemoCopy(): DemoCopy {
  const documentLocale = supported(document.documentElement.lang)
  if (documentLocale && documentLocale !== 'en') return copy[documentLocale]
  try {
    const saved =
      supported(localStorage.getItem(SITE_LOCALE_STORAGE_KEY)) ??
      supported(localStorage.getItem(LEGACY_BLOG_LOCALE_STORAGE_KEY))
    if (saved) return copy[saved]
  } catch {
    /* A blocked storage area must not block conversions. */
  }
  return copy[documentLocale ?? 'en']
}
