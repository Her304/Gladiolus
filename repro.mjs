import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()) })
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message + '\n' + (e.stack||'')))

async function snap(label) {
  console.log('=== ' + label + ' ===')
  console.log('hash:', page.url().replace('http://localhost:5179',''))
  console.log('body:', (await page.locator('body').innerText().catch(()=>'(none)')).slice(0,300).replace(/\n+/g,' | '))
  console.log('errors:', errs.join(' ;; ') || 'none')
  errs.length = 0
}

await page.goto('http://localhost:5179/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await snap('initial (signed out)')

// Try clicking into the dispatch tab (default) and signing in
await page.goto('http://localhost:5179/#/driver/today', { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
await snap('hash #/driver/today (signed out)')

// Sign in as dispatch
await page.goto('http://localhost:5179/', { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.click('button:has-text("Sign in")').catch(()=>{})
await page.waitForTimeout(800)
await snap('after dispatch sign-in')

// Now sign out
await page.click('button:has-text("Sign out")').catch(()=>{})
await page.waitForTimeout(800)
await snap('after sign out')

await browser.close()
