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
import type { AstroIntegration } from 'astro'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import rehypeBlockIds from './src/lib/rehype-block-ids'
import { includeInSitemap, papersListing } from './src/lib/papers-listing'
import { papersListingEnv } from './src/lib/papers-listing-env'
import {
  legacyRedirectTarget,
  REDIRECT_STATUS,
  writeBuildRedirects,
} from './tools/ia-redirects.mjs'
import { LOCAL_OCR_ASSET_FILES } from './tools/local-ocr-assets'

const SITE_URL = 'https://ernie.sg'

// The same inputs page modules see through `import.meta.env`, `.env` files
// included, so the sitemap and the nav can never disagree.
const listingEnv = papersListingEnv(
  process.env.NODE_ENV === 'development' ? 'development' : 'production',
  fileURLToPath(new URL('.', import.meta.url)),
)
const papersListingState = papersListing(listingEnv)
const productionRelease = listingEnv.PUBLIC_RESEARCH_RELEASE === 'production'

/**
 * The dev server's half of the ADR 010 redirects: a real 301 for every legacy
 * `/research` and `/study` URL, pages and files alike, from the same rules the
 * build turns into `_redirects` and static stubs.
 */
function legacyRedirectsDevPlugin(): Plugin {
  return {
    name: 'legacy-redirects-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const target = legacyRedirectTarget(url.pathname)
        if (target === null) return next()
        response.statusCode = REDIRECT_STATUS
        response.setHeader('Location', `${target}${url.search}`)
        response.end()
      })
    },
  }
}

/**
 * The build's half: once Astro has emitted `/papers` and `/library`, write a
 * redirect for every legacy URL that now lives there. Derived from the output,
 * so a new page or asset cannot ship without its redirect.
 */
function legacyRedirectsBuild(): AstroIntegration {
  return {
    name: 'legacy-redirects-build',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        await writeBuildRedirects(fileURLToPath(dir), { site: SITE_URL })
      },
    },
  }
}

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
  site: SITE_URL,
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
        includeInSitemap(new URL(page).pathname.replace(/\/$/u, '') || '/', {
          listing: papersListingState,
          production: productionRelease,
        }),
    }),
    mdx(),
    react(),
    icon(),
    legacyRedirectsBuild(),
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
        // Last, so it sees the final block structure every plugin above made.
        rehypeBlockIds,
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
    plugins: [
      legacyRedirectsDevPlugin(),
      localOcrBuildAssetsPlugin(),
      localOcrDevAssetsPlugin(),
    ],
    // The publication worker graph is loaded only after the reader chooses a
    // file. Pre-bundle both PDF.js import targets and the OCR adapter so Vite
    // cannot discover them later, reload the studio, and discard that
    // browser-local File during a cold dev/Playwright run.
    optimizeDeps: {
      include: [
        'pdfjs-dist',
        'pdfjs-dist/legacy/build/pdf.mjs',
        'tesseract.js',
      ],
      // Headless OCR loads this native Node package only when `document` is
      // absent. Browser dependency discovery must not inspect its
      // platform-specific optional binaries.
      exclude: ['@napi-rs/canvas'],
    },
    server: {
      watch: {
        ignored: ['**/.agent/evidence/**', '**/.agent/vm-runs/**'],
      },
    },
  },
})
