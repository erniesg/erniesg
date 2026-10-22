import { test, expect } from '@playwright/test'

test('debug locale detection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  
  // Intercept /research/zh/ and return modified English page
  await page.route('**/research/zh/', async (route) => {
    const response = await route.fetch({ url: '/research/' })
    const html = await response.text()
      .then(text => text
        .replace(/<html lang="en">/, '<html lang="zh-Hans">')
        .replace(/<meta name="site-document-locale" content="en">/, '<meta name="site-document-locale" content="zh">')
      )
    await route.fulfill({ response, body: html })
  })
  
  await page.goto('/research/zh/')
  
  // Check the pathname
  const pathname = await page.evaluate(() => window.location.pathname)
  console.log('pathname:', pathname)
  
  // Check the locale detection
  const locale = await page.evaluate(() => {
    const segments = window.location.pathname.split('/').filter(Boolean)
    const knownSections = ['research', 'about', 'blog', 'tags', 'books', 'library', 'projects']
    if (segments.length >= 2 && knownSections.includes(segments[0])) {
      return segments[1]
    }
    return null
  })
  console.log('detected locale:', locale)
  
  // Check the MobileMenu's locale state
  const menuButton = page.locator('header button.md\\:hidden')
  await menuButton.click()
  const aboutItem = page.getByRole('menuitem', { name: '关于' })
  await expect(aboutItem).toBeVisible()
})
