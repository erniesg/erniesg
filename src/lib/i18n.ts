export const SUPPORTED_LOCALES = ['en', 'zh', 'ko', 'ja'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: SupportedLocale = 'en'

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  zh: '中文',
  ko: '한국어',
  ja: '日本語',
}

export const LOCALE_HTML_LANG: Record<SupportedLocale, string> = {
  en: 'en',
  zh: 'zh-Hans',
  ko: 'ko',
  ja: 'ja',
}

export const LOCALE_SHORT_LABELS: Record<SupportedLocale, string> = {
  en: 'EN',
  zh: '中',
  ko: '한',
  ja: '日',
}

export const TAG_LABELS: Record<SupportedLocale, Record<string, string>> = {
  en: {},
  zh: {
    grief: '悲伤',
    loss: '失去',
    personal: '个人',
    reflection: '反思',
  },
  ko: {
    grief: '슬픔',
    loss: '상실',
    personal: '개인',
    reflection: '성찰',
  },
  ja: {
    grief: '悲しみ',
    loss: '喪失',
    personal: '個人',
    reflection: '省察',
  },
}

export const STATIC_TRANSLATIONS: Record<
  SupportedLocale,
  Record<string, string>
> = {
  en: {
    'nav.blog': 'Blog',
    'nav.about': 'About',
    'nav.tags': 'Tags',
    'ui.menu': 'Menu',
    'ui.toggleMenu': 'Toggle menu',
    'ui.changeLanguage': 'Change language',
    'ui.toggleTheme': 'Toggle theme',
    'ui.theme.light': 'Light',
    'ui.theme.dark': 'Dark',
    'ui.theme.system': 'System',
    'ui.pagination': 'pagination',
    'ui.previous': 'Previous',
    'ui.next': 'Next',
    'ui.previousPage': 'Go to previous page',
    'ui.nextPage': 'Go to next page',
    'ui.morePages': 'More pages',
    'ui.scrollToTop': 'Scroll to top',
    'footer.rights': 'All rights reserved.',
    'footer.madeWith': 'Made with care by',
    'home.eyebrow': 'Home of Chen Enjiao',
    'home.welcome': 'Welcome!',
    'home.intro':
      'Essays and experiments on building AI in the wild: turning fuzzy ideas and messy workflows into useful systems and playable tools, with notes on everything else along the way.',
    'home.latestPosts': 'Latest posts',
    'home.seeAllPosts': 'See all posts',
    'blog.title': 'Blog',
    'blog.page': 'Page',
    'blog.noTags': 'No tags available',
    'tags.title': 'Tags',
    'tags.description': 'A list of all tags used in blog posts',
    'tags.postsTaggedWith': 'Posts tagged with',
    'authors.title': 'Authors',
    'authors.description': 'A list of authors on this site.',
    'authors.empty': 'No authors found.',
    'authors.postsBy': 'Posts by',
    'authors.noPosts': 'No posts available from this author.',
    'about.title': 'About',
    'about.copy':
      'Some keywords I try to track are: multimodal AI, generative agents and open source. In my leisure time, I enjoy working out, reading, learning or simply traveling. Check out some of my projects below!',
    'about.featuredProjects': 'Featured Projects',
    'author.erniesg.bio':
      'Senior AI Engineer at SPH Media Limited (since April 2026). Previously Editorial AI and Automation Lead at Tech in Asia. Passionate about multilingualism, multimodal AI, and building impactful solutions. Founded Code for Asia (2016-2023) to democratize tech knowledge. Currently pursuing MITx DEDP, exploring the intersection of AI, culture and economics.',
    'project.neural-art-search.name': 'Neural Art Search',
    'project.neural-art-search.description':
      'A neural search system for artworks on the National Gallery Singapore collection. Enables intuitive discovery of art pieces through advanced semantic search capabilities.',
    'project.storylabs.name': 'StoryLabs',
    'project.storylabs.description':
      "A full-stack, multimedia story generator and reader that personalizes content to a child's diverse interests.",
    'project.the-sound-of-stories.name': 'The Sound of Stories',
    'project.the-sound-of-stories.description':
      'Featured at the Esplanade as part of National Arts Council’s Arts x Tech Lab 2023/24, this bilingual storyteller personalizes "The Boy and the Drum" for each reader on WhatsApp.',
    '404.title': '404',
    '404.heading': '404: Page not found',
    '404.message': 'Page not found.',
    '404.home': 'Go to home page',
  },
  zh: {
    'nav.blog': '博客',
    'nav.about': '关于',
    'nav.tags': '标签',
    'ui.menu': '菜单',
    'ui.toggleMenu': '打开菜单',
    'ui.changeLanguage': '切换语言',
    'ui.toggleTheme': '切换主题',
    'ui.theme.light': '浅色',
    'ui.theme.dark': '深色',
    'ui.theme.system': '跟随系统',
    'ui.pagination': '分页',
    'ui.previous': '上一页',
    'ui.next': '下一页',
    'ui.previousPage': '前往上一页',
    'ui.nextPage': '前往下一页',
    'ui.morePages': '更多页面',
    'ui.scrollToTop': '回到顶部',
    'footer.rights': '版权所有。',
    'footer.madeWith': '用心制作：',
    'home.eyebrow': '陈恩娇的主页',
    'home.welcome': '欢迎！',
    'home.intro':
      '关于在真实世界中构建 AI 的随笔与实验：把模糊想法和复杂工作流变成有用的系统和可玩的工具，也顺手记下沿途遇到的其他一切。',
    'home.latestPosts': '最新文章',
    'home.seeAllPosts': '查看全部文章',
    'blog.title': '博客',
    'blog.page': '第',
    'blog.noTags': '暂无标签',
    'tags.title': '标签',
    'tags.description': '博客文章使用过的全部标签。',
    'tags.postsTaggedWith': '包含此标签的文章',
    'authors.title': '作者',
    'authors.description': '本站作者列表。',
    'authors.empty': '未找到作者。',
    'authors.postsBy': '作者文章：',
    'authors.noPosts': '这位作者暂无文章。',
    'about.title': '关于',
    'about.copy':
      '我持续关注的一些关键词包括：多模态人工智能、生成式智能体和开源。闲暇时，我喜欢运动、阅读、学习，或者单纯旅行。下面是我的一些项目。',
    'about.featuredProjects': '精选项目',
    'author.erniesg.bio':
      '陈恩娇目前是 SPH Media Limited 的高级 AI 工程师（自 2026 年 4 月起）。此前曾任 Tech in Asia 编辑部 AI 与自动化负责人。热衷于多语言、多模态 AI，以及构建有实际影响力的解决方案。曾创办 Code for Asia（2016-2023），推动技术知识民主化。目前正在修读 MITx DEDP，并探索 AI、文化与经济之间的交汇。',
    'project.neural-art-search.name': '神经艺术搜索 (Neural Art Search)',
    'project.neural-art-search.description':
      '面向新加坡国家美术馆馆藏的神经搜索系统，让用户通过先进语义搜索能力更直观地发现艺术作品。',
    'project.storylabs.name': '故事实验室 (StoryLabs)',
    'project.storylabs.description':
      '一个全栈多媒体故事生成器和阅读器，会根据孩子多元的兴趣个性化生成内容。',
    'project.the-sound-of-stories.name': '故事之声 (The Sound of Stories)',
    'project.the-sound-of-stories.description':
      '作为 National Arts Council Arts x Tech Lab 2023/24 的一部分在滨海艺术中心亮相，这个双语讲故事工具会为 WhatsApp 上的每位读者个性化改写《男孩与鼓》。',
    '404.title': '404',
    '404.heading': '404：找不到页面',
    '404.message': '找不到页面。',
    '404.home': '回到首页',
  },
  ko: {
    'nav.blog': '블로그',
    'nav.about': '소개',
    'nav.tags': '태그',
    'ui.menu': '메뉴',
    'ui.toggleMenu': '메뉴 열기',
    'ui.changeLanguage': '언어 변경',
    'ui.toggleTheme': '테마 변경',
    'ui.theme.light': '라이트',
    'ui.theme.dark': '다크',
    'ui.theme.system': '시스템',
    'ui.pagination': '페이지 이동',
    'ui.previous': '이전',
    'ui.next': '다음',
    'ui.previousPage': '이전 페이지로 이동',
    'ui.nextPage': '다음 페이지로 이동',
    'ui.morePages': '더 많은 페이지',
    'ui.scrollToTop': '맨 위로 이동',
    'footer.rights': '모든 권리 보유.',
    'footer.madeWith': '정성껏 만든 사람:',
    'home.eyebrow': 'Chen Enjiao의 홈',
    'home.welcome': '환영합니다!',
    'home.intro':
      '현장에서 AI를 만드는 일에 관한 에세이와 실험입니다. 모호한 아이디어와 복잡한 업무 흐름을 쓸모 있는 시스템과 가지고 놀 수 있는 도구로 바꾸고, 그 사이의 다른 삶의 기록도 함께 남깁니다.',
    'home.latestPosts': '최신 글',
    'home.seeAllPosts': '모든 글 보기',
    'blog.title': '블로그',
    'blog.page': '페이지',
    'blog.noTags': '사용 가능한 태그가 없습니다',
    'tags.title': '태그',
    'tags.description': '블로그 글에 사용된 모든 태그 목록입니다.',
    'tags.postsTaggedWith': '이 태그가 달린 글',
    'authors.title': '작성자',
    'authors.description': '이 사이트의 작성자 목록입니다.',
    'authors.empty': '작성자를 찾을 수 없습니다.',
    'authors.postsBy': '작성자 글:',
    'authors.noPosts': '이 작성자의 글이 없습니다.',
    'about.title': '소개',
    'about.copy':
      '제가 계속 추적하려는 키워드는 멀티모달 AI, 생성형 에이전트, 오픈소스입니다. 여가 시간에는 운동, 독서, 학습, 여행을 즐깁니다. 아래에서 몇 가지 프로젝트를 확인해 보세요.',
    'about.featuredProjects': '주요 프로젝트',
    'author.erniesg.bio':
      'Chen Enjiao는 SPH Media Limited의 시니어 AI 엔지니어입니다(2026년 4월부터). 이전에는 Tech in Asia에서 Editorial AI and Automation Lead로 일했습니다. 다국어, 멀티모달 AI, 영향력 있는 솔루션 구축에 관심이 많습니다. 기술 지식의 민주화를 위해 Code for Asia(2016-2023)를 창립했으며, 현재 MITx DEDP를 이수하며 AI, 문화, 경제의 교차점을 탐구하고 있습니다.',
    'project.neural-art-search.name': '신경 예술 검색 (Neural Art Search)',
    'project.neural-art-search.description':
      'National Gallery Singapore 컬렉션의 작품을 위한 신경 검색 시스템입니다. 고급 의미 검색 기능으로 예술 작품을 직관적으로 발견할 수 있게 합니다.',
    'project.storylabs.name': '이야기 연구소 (StoryLabs)',
    'project.storylabs.description':
      '아이의 다양한 관심사에 맞춰 콘텐츠를 개인화하는 풀스택 멀티미디어 이야기 생성기이자 리더입니다.',
    'project.the-sound-of-stories.name': '이야기의 소리 (The Sound of Stories)',
    'project.the-sound-of-stories.description':
      'National Arts Council의 Arts x Tech Lab 2023/24 일부로 Esplanade에서 소개된 이 이중언어 스토리텔러는 WhatsApp에서 각 독자에게 맞춰 "The Boy and the Drum"을 개인화합니다.',
    '404.title': '404',
    '404.heading': '404: 페이지를 찾을 수 없습니다',
    '404.message': '페이지를 찾을 수 없습니다.',
    '404.home': '홈으로 이동',
  },
  ja: {
    'nav.blog': 'ブログ',
    'nav.about': '紹介',
    'nav.tags': 'タグ',
    'ui.menu': 'メニュー',
    'ui.toggleMenu': 'メニューを開く',
    'ui.changeLanguage': '言語を変更',
    'ui.toggleTheme': 'テーマを変更',
    'ui.theme.light': 'ライト',
    'ui.theme.dark': 'ダーク',
    'ui.theme.system': 'システム',
    'ui.pagination': 'ページ送り',
    'ui.previous': '前へ',
    'ui.next': '次へ',
    'ui.previousPage': '前のページへ',
    'ui.nextPage': '次のページへ',
    'ui.morePages': 'さらにページがあります',
    'ui.scrollToTop': '先頭へ戻る',
    'footer.rights': '全著作権所有。',
    'footer.madeWith': '心を込めて制作：',
    'home.eyebrow': 'Chen Enjiao のホーム',
    'home.welcome': 'ようこそ！',
    'home.intro':
      '現場で AI を作ることについてのエッセイと実験です。曖昧なアイデアや複雑なワークフローを、役に立つシステムや遊べるツールへ変えながら、その道中のあれこれも書き残します。',
    'home.latestPosts': '最新記事',
    'home.seeAllPosts': 'すべての記事を見る',
    'blog.title': 'ブログ',
    'blog.page': 'ページ',
    'blog.noTags': '利用できるタグはありません',
    'tags.title': 'タグ',
    'tags.description': 'ブログ記事で使われているすべてのタグ一覧です。',
    'tags.postsTaggedWith': 'このタグの記事',
    'authors.title': '著者',
    'authors.description': 'このサイトの著者一覧です。',
    'authors.empty': '著者が見つかりません。',
    'authors.postsBy': '著者の記事：',
    'authors.noPosts': 'この著者の記事はまだありません。',
    'about.title': '紹介',
    'about.copy':
      '私が追いかけているキーワードは、マルチモーダル AI、生成エージェント、オープンソースです。余暇には運動、読書、学習、あるいは旅を楽しんでいます。下にいくつかのプロジェクトを掲載しています。',
    'about.featuredProjects': '注目プロジェクト',
    'author.erniesg.bio':
      'Chen Enjiao は SPH Media Limited のシニア AI エンジニアです（2026年4月より）。以前は Tech in Asia で Editorial AI and Automation Lead を務めました。多言語性、マルチモーダル AI、実際に影響を生むソリューション構築に関心があります。技術知識の民主化を目指して Code for Asia（2016-2023）を創設し、現在は MITx DEDP を履修しながら AI、文化、経済の交差点を探求しています。',
    'project.neural-art-search.name':
      'ニューラルアート検索 (Neural Art Search)',
    'project.neural-art-search.description':
      'National Gallery Singapore のコレクション作品のためのニューラル検索システムです。高度な意味検索によって、作品を直感的に発見できます。',
    'project.storylabs.name': 'ストーリーラボ (StoryLabs)',
    'project.storylabs.description':
      '子どもの多様な興味に合わせてコンテンツを個別化する、フルスタックのマルチメディア物語生成・読書ツールです。',
    'project.the-sound-of-stories.name': '物語の音 (The Sound of Stories)',
    'project.the-sound-of-stories.description':
      'National Arts Council の Arts x Tech Lab 2023/24 の一環として Esplanade で紹介されたこのバイリンガル storyteller は、WhatsApp 上で読者ごとに "The Boy and the Drum" を個別化します。',
    '404.title': '404',
    '404.heading': '404: ページが見つかりません',
    '404.message': 'ページが見つかりません。',
    '404.home': 'ホームへ戻る',
  },
}

const SUPPORTED_LOCALE_SET = new Set<string>(SUPPORTED_LOCALES)

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALE_SET.has(locale)
}

export function normalizeLocale(locale: string): SupportedLocale {
  const primary = locale.toLowerCase().split('-')[0]
  return isSupportedLocale(primary) ? primary : DEFAULT_LOCALE
}

export function getLocaleFromPostId(id: string): SupportedLocale {
  const suffix = id.split('/').at(-1)
  return suffix && isSupportedLocale(suffix) ? suffix : DEFAULT_LOCALE
}

export function getCanonicalPostId(id: string): string {
  const parts = id.split('/')
  const suffix = parts.at(-1)
  return suffix && isSupportedLocale(suffix) ? parts.slice(0, -1).join('/') : id
}

export function getLocalizedPostId(
  id: string,
  locale: SupportedLocale,
): string {
  const canonicalId = getCanonicalPostId(id)
  return locale === DEFAULT_LOCALE ? canonicalId : `${canonicalId}/${locale}`
}

export function getPostLocalePath(id: string, locale: SupportedLocale): string {
  return `/blog/${getLocalizedPostId(id, locale)}`
}

export function pickPreferredLocale(languages: readonly string[]) {
  for (const language of languages) {
    const primary = language.toLowerCase().split('-')[0]
    if (isSupportedLocale(primary)) return primary
  }

  return DEFAULT_LOCALE
}

export function isCanonicalDefaultPostId(id: string) {
  return getLocaleFromPostId(id) === DEFAULT_LOCALE
}

export function isLegacyChinesePostId(id: string) {
  return id.endsWith('-zh')
}

export function getTagLabel(tag: string, locale: SupportedLocale) {
  return TAG_LABELS[locale][tag] ?? tag
}

export function getStaticTranslation(key: string, locale: SupportedLocale) {
  return STATIC_TRANSLATIONS[locale][key] ?? STATIC_TRANSLATIONS.en[key] ?? key
}
