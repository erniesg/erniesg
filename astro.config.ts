import { rehypeHeadingIds, unified } from '@astrojs/markdown-remark'
import mdx from '@astrojs/mdx'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import { transformerCopyButton } from '@rehype-pretty/transformers'
import {
  transformerMetaHighlight,
  transformerNotationDiff,
} from '@shikijs/transformers'
import { defineConfig } from 'astro/config'
import { readFile } from 'node:fs/promises'
import rehypeKatex from 'rehype-katex'
import rehypeExternalLinks from 'rehype-external-links'
import rehypePrettyCode from 'rehype-pretty-code'
import remarkEmoji from 'remark-emoji'
import remarkMath from 'remark-math'
import remarkToc from 'remark-toc'
import sectionize from '@hbsnow/rehype-sectionize'

import icon from 'astro-icon'
import type { Plugin } from 'vite'
import { LOCAL_OCR_ASSET_FILES } from './tools/local-ocr-assets'

const includeResearch = process.env.PUBLIC_RESEARCH_RELEASE === 'staging'

function localOcrBuildAssetsPlugin(): Plugin {
  return {
    name: 'local-ocr-build-assets',
    apply: 'build',
    async buildStart() {
      for (const [name, path] of LOCAL_OCR_ASSET_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `assets/ocr/${name}`,
          source: await readFile(path),
        })
      }
    },
  }
}

function localOcrDevAssetsPlugin(): Plugin {
  return {
    name: 'local-ocr-dev-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname
        const prefix = '/assets/ocr/'
        if (!pathname.startsWith(prefix)) return next()
        const source = LOCAL_OCR_ASSET_FILES.get(pathname.slice(prefix.length))
        if (!source) return next()
        response.setHeader(
          'Content-Type',
          pathname.endsWith('.gz')
            ? 'application/gzip'
            : pathname.endsWith('.js')
              ? 'application/javascript; charset=utf-8'
              : 'text/plain; charset=utf-8',
        )
        response.setHeader(
          'Cache-Control',
          'public, max-age=31536000, immutable',
        )
        response.end(await readFile(source))
      })
    },
  }
}

// https://astro.build/config
export default defineConfig({
  site: 'https://ernie.sg',
  compressHTML: true,
  redirects: {
    // PubPub legacy slugs → new readable slugs (migrated 2026-05)
    '/blog/161hmmds':
      '/blog/a-i-for-humans-building-a-i-native-products-and-treating-data',
    '/blog/1bt4uylj':
      '/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh',
    '/blog/1eogiw8s':
      '/blog/developer-diaries-deep-learning-in-data-poor-regimes-i',
    '/blog/33ietk6v':
      '/blog/sound-before-symbols-on-human-creativity-and-intelligence',
    '/blog/4nrd812x': '/blog/a-i-for-humans-be-like-its-just-x',
    '/blog/6p2l328i':
      '/blog/developer-diaries-were-all-bayesian-inference-machines-now',
    '/blog/7b4nk0ao':
      '/blog/developer-diaries-a-i-development-be-like-scarcer-than-early-internet',
    '/blog/7t92wlwf':
      '/blog/a-i-in-non-english-regimes-and-the-things-people-say-in-china',
    '/blog/9hq39jmi':
      '/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh',
    '/blog/9tss8q7y':
      '/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human',
    '/blog/ap22r9st':
      '/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh',
    '/blog/ayldd7lx':
      '/blog/sight-before-sound-seeing-and-searching-with-machines/zh',
    '/blog/eog11k9z': '/blog/a-i-art-and-anti-discrimination',
    '/blog/ettc9fqh':
      '/blog/move-aside-gpt-4-for-i-own-this-google-search-result-mlops-for-museums',
    '/blog/g6zjtf2s': '/blog/developer-diaries-the-sound-of-stories',
    '/blog/gcdzise9': '/blog/mlops-for-museums',
    '/blog/hnn0p7d9':
      '/blog/sight-before-sound-seeing-and-searching-with-machines',
    '/blog/i8a0vp8z':
      '/blog/fork-work-why-work-when-we-can-use-autonomous-agents-instead',
    '/blog/jqeeg1f8':
      '/blog/developer-diaries-hack-exams-because-exams-are-not-meant-for-humans',
    '/blog/r2map92q': '/blog/tutorial-air-drumming-with-a-i',
    '/blog/r4a1ex9r':
      '/blog/developer-diaries-digitalise-any-instrument-and-start-playing',
    '/blog/wpnv7rhs':
      '/blog/berlayar-building-a-stable-extensible-flexible-and-scalable-stack',
    '/blog/xlkdc79p': '/blog/demo-the-sound-of-stories',
    '/blog/z40gi88t':
      '/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content',
    '/blog/zc0zx741':
      '/blog/berlayar-building-a-stable-extensible-flexible-and-scalable-stack-2',
    '/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content-zh':
      '/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh',
    '/blog/sight-before-sound-seeing-and-searching-with-machines-zh':
      '/blog/sight-before-sound-seeing-and-searching-with-machines/zh',
    '/blog/sound-before-symbols-on-human-creativity-and-intelligence-zh':
      '/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh',
    '/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human-zh':
      '/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh',
  },
  integrations: [
    sitemap({
      filter: (page) =>
        includeResearch || !new URL(page).pathname.startsWith('/research'),
    }),
    mdx(),
    react(),
    icon(),
  ],
  markdown: {
    syntaxHighlight: false,
    processor: unified({
      rehypePlugins: [
        [
          rehypeExternalLinks,
          {
            target: '_blank',
            rel: ['nofollow', 'noreferrer', 'noopener'],
          },
        ],
        rehypeHeadingIds,
        rehypeKatex,
        sectionize,
        [
          rehypePrettyCode,
          {
            theme: {
              light: 'github-light-high-contrast',
              dark: 'github-dark-high-contrast',
            },
            transformers: [
              transformerNotationDiff(),
              transformerMetaHighlight(),
              transformerCopyButton({
                visibility: 'hover',
                feedbackDuration: 1000,
              }),
            ],
          },
        ],
      ],
      remarkPlugins: [remarkToc, remarkMath, remarkEmoji],
    }),
  },
  server: {
    port: 1234,
    host: true,
  },
  devToolbar: {
    enabled: false,
  },
  vite: {
    plugins: [localOcrBuildAssetsPlugin(), localOcrDevAssetsPlugin()],
    // PDF.js is loaded only after the reader chooses a file. Pre-bundling it
    // prevents Vite's first dynamic import from reloading the studio and
    // discarding that browser-local File during a cold dev/Playwright run.
    optimizeDeps: {
      include: ['pdfjs-dist'],
    },
    server: {
      watch: {
        ignored: ['**/.agent/evidence/**', '**/.agent/vm-runs/**'],
      },
    },
  },
})
