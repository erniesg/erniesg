import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { DEFAULT_LOCALE, type SupportedLocale } from './i18n'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const DATE_LOCALES: Record<SupportedLocale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  ko: 'ko-KR',
  ja: 'ja-JP',
}

const READ_TIME_LABELS: Record<SupportedLocale, (minutes: string) => string> = {
  en: (minutes) => `${minutes} min read`,
  zh: (minutes) => `${minutes} 分钟阅读`,
  ko: (minutes) => `${minutes}분 읽기`,
  ja: (minutes) => `約${minutes}分で読めます`,
}

export function formatDate(date: Date, locale: SupportedLocale = DEFAULT_LOCALE) {
  return Intl.DateTimeFormat(DATE_LOCALES[locale], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

export function readingTime(
  html: string,
  locale: SupportedLocale = DEFAULT_LOCALE,
) {
  const textOnly = html.replace(/<[^>]+>/g, '')
  const wordCount = textOnly.split(/\s+/).length
  const readingTimeMinutes = (wordCount / 200 + 1).toFixed()
  return READ_TIME_LABELS[locale](readingTimeMinutes)
}
