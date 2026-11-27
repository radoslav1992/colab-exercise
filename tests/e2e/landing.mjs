/**
 * End-to-end tests of the landing page ("/"): a document of its own that loads none of the app,
 * shows the account controls that fit the deployment and the visitor, and leads into the app.
 * They run where the tests of accounts run (the real Worker under `wrangler dev`, or the Node
 * server), and once more against a site without accounts.
 */
import { assert, assertEqual, assertExcludes, assertIncludes } from './helpers.mjs'

const SECRET_KEY = 'notebook-lab:session-secret'

/** The five topics of the landing page and the sample notebook each one opens, and the note that says where to start. */
const TOPICS = [
  ['Speech to text', '01-speech-to-text.ipynb'],
  ['Text to speech', '02-text-to-speech.ipynb'],
  ['A language model, one token at a time', '03-llm-tokens-and-sampling.ipynb'],
  ['Attention from scratch', '04-attention-from-scratch.ipynb'],
  ['Diffusion on toy data', '05-diffusion-toy.ipynb'],
  ['Check your setup', '00-check-your-setup.ipynb'],
]

function watch(page) {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return problems
}

/** The account controls that show, by their text, in the order of the page. */
async function accountControls(page) {
  return page.locator('a[data-account]:visible, [data-account]:visible > a').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()))
}

/** The script has asked the server what the deployment offers and set the controls. */
async function settled(page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

export function register(suite, env) {
  const base = env.site.url
  const context = (options = {}) => env.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', ...options })

  suite.test('landing: a real page with its content in the HTML, fonts from this site, nothing of the app, no console or policy errors', async () => {
    const ctx = await context()
    const page = await ctx.newPage()
    const problems = watch(page)
    const requests = []
    page.on('request', (request) => requests.push(request))
    const response = await page.goto(`${base}/`)
    await settled(page)
    assertEqual(response.status(), 200, 'the start page')
    assertIncludes(response.headers()['content-security-policy'] ?? '', "font-src 'self' data:", 'served under the policy of public/_headers')
    assertEqual(problems, [], 'console problems')

    // The document itself, as a reader without JavaScript or a search engine gets it.
    const html = await (await ctx.request.get(`${base}/`)).text()
    assert(html.length < 200_000, `the HTML is light (${html.length} bytes)`)
    assertExcludes(html, 'noindex', 'the landing page may be indexed')
    assertExcludes(html, 'rel="canonical"', 'no canonical address: the domain is not known')
    assert(!/(?:href|src|content)="https?:\/\//.test(html), 'no absolute addresses')
    assertEqual((html.match(/<h1[\s>]/g) ?? []).length, 1, 'exactly one h1')
    for (const part of ['<title>Notebook Lab: course notebooks for AI that run in the browser</title>', 'name="description"', 'property="og:title"', 'property="og:description"', 'Try a notebook', 'What students can run', 'How it works for a teacher', 'Plain facts', 'Got a join code?', 'No analytics, no tracking.']) {
      assertIncludes(html, part, 'the content is in the HTML')
    }
    assertExcludes(html, '<!-- doodle:', 'every doodle was written into the page when it was built')
    assert((html.match(/<svg /g) ?? []).length >= 20, 'the doodles are inline SVG')
    assertEqual(await page.locator('h1').count(), 1, 'one h1 on the page')
    assertEqual(await page.locator('svg.doodle:not([aria-hidden=true])').count(), 0, 'doodles are decoration: hidden from screen readers')
    for (const path of ['/playground', '/courses']) assertIncludes(await (await ctx.request.get(`${base}${path}`)).text(), 'name="robots" content="noindex"', `${path} stays out of search engines`)
    assertEqual((await ctx.request.get(`${base}/app`)).status(), 404, 'the app document has no address of its own')

    // Fonts: Fraunces and Caveat, from this site only.
    const fonts = requests.filter((request) => request.resourceType() === 'font').map((request) => new URL(request.url()))
    assertEqual(fonts.map((url) => url.pathname.replace(/-[\w-]{8}\.woff2$/, '.woff2')).sort(), ['/assets/caveat-latin-wght-normal.woff2', '/assets/fraunces-latin-opsz-normal.woff2'], 'two font files, latin only')
    assert(fonts.every((url) => url.origin === base), 'fonts come from this site')
    assert(requests.every((request) => new URL(request.url()).origin === base), 'everything comes from this site')
    assertEqual(await page.evaluate(() => [document.fonts.check('600 40px Fraunces'), document.fonts.check('500 24px Caveat')]), [true, true], 'both fonts are loaded')
    assertIncludes(await page.locator('h1').evaluate((node) => getComputedStyle(node).fontFamily), 'Fraunces', 'the headline is set in Fraunces')
    assertIncludes(await page.locator('.note').first().evaluate((node) => getComputedStyle(node).fontFamily), 'Caveat', 'the notes are handwritten')
    const small = await page.locator('.hand, .note, .step h3').evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node, node.matches('.step h3') ? '::before' : null).fontSize)).filter((size) => size < 18))
    assertEqual(small, [], 'handwriting is never small')

    // Nothing of the app: no editor, no Markdown, no Python runtime, no notebooks.
    const scripts = requests.filter((request) => ['script', 'fetch', 'xhr'].includes(request.resourceType())).map((request) => new URL(request.url()).pathname)
    assert(scripts.every((path) => !/editor|markdown|\/app-|worker|pyodide|ipynb|\/assets\/\d\d-[a-z]/.test(path)), `no chunk of the app is requested (${scripts.join(', ')})`)
    assertEqual(scripts.filter((path) => path.startsWith('/api/')), ['/api/config'], 'one question to the server: what this deployment offers')
    const bytes = (await Promise.all(requests.filter((request) => request.resourceType() === 'script').map(async (request) => (await (await request.response()).body()).length))).reduce((sum, n) => sum + n, 0)
    assert(bytes < 12_000, `the scripts of the landing page are small (${bytes} bytes)`)
    assertEqual(await page.evaluate(() => document.cookie), '', 'no cookie')
    await ctx.close()
  })

  suite.test('landing: nothing sticks out at 1280 and 390 px, in light and dark', async () => {
    for (const width of [1280, 390]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await context({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme })
        const page = await ctx.newPage()
        const problems = watch(page)
        await page.goto(`${base}/`)
        await settled(page)
        const sizes = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          wide: Array.from(document.querySelectorAll('body *'))
            .filter((node) => !node.closest('svg') || node.tagName === 'svg')
            .filter((node) => {
              const box = node.getBoundingClientRect()
              return box.width > 0 && (box.right > window.innerWidth + 1 || box.left < -1)
            })
            .map((node) => `${node.tagName.toLowerCase()}.${node.getAttribute('class')}`)
            .slice(0, 5),
          background: getComputedStyle(document.body).backgroundColor,
          cut: Array.from(document.querySelectorAll('.mock-code')).filter((node) => node.scrollWidth > node.clientWidth + 1).length,
        }))
        assert(sizes.scrollWidth <= sizes.innerWidth, `${width} px ${scheme}: no sideways scrolling (${sizes.scrollWidth})`)
        assertEqual(sizes.wide, [], `${width} px ${scheme}: nothing sticks out`)
        assertEqual(sizes.cut, 0, `${width} px ${scheme}: the code in the picture of the notebook is not cut off`)
        const [r, g, b] = sizes.background.match(/\d+/g).map(Number)
        assert(scheme === 'dark' ? r + g + b < 150 : r + g + b > 650, `${width} px ${scheme}: the paper is ${scheme} (${sizes.background})`)
        // The notes around the notebook stay inside the hero and do not cover the notebook's text.
        const notes = await page.evaluate(() => {
          const hero = document.querySelector('.hero').getBoundingClientRect()
          const mock = document.querySelector('.mock').getBoundingClientRect()
          return Array.from(document.querySelectorAll('.note span')).map((node) => {
            const box = node.getBoundingClientRect()
            const inside = box.top >= hero.top && box.bottom <= hero.bottom && box.left >= 0 && box.right <= window.innerWidth
            const overlap = Math.max(0, Math.min(box.right, mock.right) - Math.max(box.left, mock.left)) * Math.max(0, Math.min(box.bottom, mock.bottom) - Math.max(box.top, mock.top))
            return { text: node.textContent, inside, covers: overlap > 0.12 * box.width * box.height }
          })
        })
        assertEqual(notes.map((note) => note.text), ['Python, right in the tab', 'the model runs on your graphics card', 'checks say when you got it'], 'three notes')
        assert(notes.every((note) => note.inside && !note.covers), `${width} px ${scheme}: the notes sit around the notebook (${JSON.stringify(notes)})`)
        assertEqual(problems, [], 'console problems')
        if (env.screenshotDir) {
          await page.screenshot({ path: `${env.screenshotDir}/landing-${width}-${scheme}.png`, fullPage: true })
          if (width === 1280 && scheme === 'light') await page.locator('.hero').screenshot({ path: `${env.screenshotDir}/landing-hero-1280-light.png` })
        }
        await ctx.close()
      }
    }
  })

  suite.test('landing: the theme button switches the theme and the app keeps it', async () => {
    const ctx = await context({ colorScheme: 'light' })
    const page = await ctx.newPage()
    await page.goto(`${base}/`)
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click()
    assertEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'dark')
    const [r, g, b] = (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).match(/\d+/g).map(Number)
    assert(r + g + b < 150, 'the paper is dark')
    await page.reload()
    assertEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'the choice is applied before the page is drawn again')
    await page.getByRole('link', { name: 'Try a notebook' }).click()
    await page.waitForSelector('.cell')
    assertEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'the app has the same theme')
    await page.getByRole('button', { name: 'Switch to the light theme' }).waitFor()
    await ctx.close()
  })

  suite.test('landing: "Try a notebook" and every topic open the right notebook in the playground', async () => {
    const ctx = await context()
    const page = await ctx.newPage()
    const problems = watch(page)
    await page.goto(`${base}/`)
    assertEqual(await page.locator('.topic h3 a').evaluateAll((links) => links.map((link) => link.getAttribute('href'))), TOPICS.map(([, file]) => `/playground?sample=${file.replace('.ipynb', '')}`), 'the topics link to their notebooks')
    assertEqual(await page.locator('.topic:not(.topic-first) > svg.doodle').count(), 5, 'five topics have a drawing')
    await page.getByRole('link', { name: 'Try a notebook' }).click()
    await page.waitForURL(`${base}/playground`)
    await page.waitForFunction(() => document.title.startsWith('00-check-your-setup.ipynb'))
    for (const [title, file] of TOPICS) {
      await page.goto(`${base}/`)
      await page.getByRole('link', { name: title }).click()
      await page.waitForFunction((name) => document.title.startsWith(name), file)
      assertEqual(await page.locator('#notebook-select').inputValue(), `sample:${file}`, `${title} opens ${file}`)
      assertEqual(new URL(page.url()).pathname + new URL(page.url()).search, '/playground', 'the address is the playground again, so a reload keeps whatever is open then')
    }
    // The name of a sample is checked against the list: anything else opens what was open before.
    for (const bad of ['no-such-notebook', '../notebooks/01-speech-to-text', '01-speech-to-text.ipynb', '%3Cscript%3E']) {
      await page.goto(`${base}/playground?sample=${bad}`)
      await page.waitForSelector('.cell')
      await page.waitForFunction(() => document.title.startsWith('00-check-your-setup.ipynb'))
    }
    // Back in the app, the brand leads to the landing page for somebody who is not signed in.
    await page.locator('.brand').click()
    await page.waitForURL(`${base}/`)
    await page.getByRole('heading', { level: 1 }).waitFor()
    assertEqual(problems, [], 'console problems')
    await ctx.close()
  })

  suite.test('landing: signed out it offers "Sign in" and "Create an account", which open the dialog; signed in it offers "My courses"', async () => {
    const ctx = await context()
    const page = await ctx.newPage()
    const problems = watch(page)
    await page.goto(`${base}/`)
    await settled(page)
    assertEqual(await accountControls(page), ['Sign in', 'Create a teacher account', 'Create a teacher account', 'Create an account', 'Sign in'], 'the controls of a visitor')
    assert(await page.locator('section.join').isVisible(), '"Got a join code?" shows')

    // "Create a teacher account": the dialog opens over the page it leads to, with "teacher" chosen.
    await page.locator('.hero').getByRole('link', { name: 'Create a teacher account' }).click()
    const dialog = page.locator('dialog[open]')
    await dialog.getByRole('heading', { name: 'Create an account' }).waitFor()
    assertEqual(new URL(page.url()).pathname + new URL(page.url()).search, '/courses', 'the request is taken out of the address')
    assert(await dialog.locator('input[type=radio][value=teacher]').isChecked(), 'a teacher account is what was asked for')
    assert(await dialog.evaluate((node) => node.contains(document.activeElement)), 'the keyboard is in the dialog')
    assertEqual(await dialog.locator('svg.doodle').count(), 1, 'the dialog has its doodle')
    // Cancelled, the page says what it needs; a reload does not open the dialog again.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('heading', { name: 'Sign in to continue' }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: 'Sign in to continue' }).waitFor()
    assertEqual(await page.locator('dialog[open]').count(), 0, 'no dialog after a reload')

    // "Create an account" under "Got a join code?": a student account.
    await page.goto(`${base}/`)
    await page.locator('section.join').getByRole('link', { name: 'Create an account' }).click()
    await dialog.getByRole('heading', { name: 'Create an account' }).waitFor()
    assert(await dialog.locator('input[type=radio][value=student]').isChecked(), 'a student by default')
    await dialog.getByLabel('Your name').fill('Lana Landing')
    await dialog.getByLabel('Email').fill('lana@lab.test')
    await dialog.getByLabel('Password').fill('landing password')
    await dialog.getByRole('button', { name: 'Create account' }).click()
    await page.getByRole('heading', { name: 'My courses' }).waitFor()
    assertEqual(await page.locator('.account-link').innerText(), 'Lana Landing', 'signed in')

    // Signed in, the landing page offers "My courses" and nothing else. It only looks whether a session secret is there.
    await page.goto(`${base}/`)
    await settled(page)
    assertEqual(await accountControls(page), ['My courses', 'My courses', 'My courses'], 'the controls of somebody who is signed in')
    assert(typeof (await page.evaluate((key) => localStorage.getItem(key), SECRET_KEY)) === 'string', 'the session secret is still where the app keeps it')
    await page.locator('.site-tools').getByRole('link', { name: 'My courses' }).click()
    await page.getByRole('heading', { name: 'My courses' }).waitFor()
    assertEqual(new URL(page.url()).pathname, '/courses', 'it leads to the courses')
    // A link with the sign-in request does nothing for somebody who is signed in.
    await page.goto(`${base}/courses?auth=signin`)
    await page.getByRole('heading', { name: 'My courses' }).waitFor()
    assertEqual(await page.locator('dialog[open]').count(), 0, 'no dialog')
    assertEqual(new URL(page.url()).search, '', 'and the request is gone from the address')

    // Sign out leads back to the landing page; "Sign in" from there works.
    await page.goto(`${base}/account`)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL(`${base}/`)
    await settled(page)
    assertEqual((await accountControls(page))[0], 'Sign in', 'signed out again')
    await page.locator('.site-tools').getByRole('link', { name: 'Sign in' }).click()
    await dialog.getByRole('heading', { name: 'Sign in' }).waitFor()
    await dialog.getByLabel('Email').fill('lana@lab.test')
    await dialog.getByLabel('Password').fill('landing password')
    await dialog.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'My courses' }).waitFor()
    assertEqual(await page.locator('.account-link').innerText(), 'Lana Landing', 'signed in from the landing page')
    assertEqual(problems, [], 'console problems')
    await ctx.close()
  })

  suite.test('landing: the notes draw themselves in once, and not at all with reduced motion', async () => {
    const animations = async (reducedMotion) => {
      const ctx = await context({ reducedMotion })
      const page = await ctx.newPage()
      await page.goto(`${base}/`)
      const found = await page.evaluate(() => ({
        strokes: Array.from(document.querySelectorAll('.hero .draw path')).map((node) => getComputedStyle(node).animationName),
        notes: Array.from(document.querySelectorAll('.hero .note span')).map((node) => getComputedStyle(node).animationName),
        counts: Array.from(document.querySelectorAll('.hero *')).map((node) => getComputedStyle(node).animationIterationCount),
        elsewhere: Array.from(document.querySelectorAll('main > section:not(.hero) *, header *, footer *')).filter((node) => getComputedStyle(node).animationName !== 'none').length,
        running: document.getAnimations().length,
      }))
      await ctx.close()
      return found
    }
    const still = await animations('reduce')
    assert(still.strokes.length >= 12, 'the hero has strokes that can draw themselves')
    assert(still.strokes.every((name) => name === 'none') && still.notes.every((name) => name === 'none'), 'reduced motion: nothing is animated')
    assertEqual(still.running, 0, 'reduced motion: no animation runs')
    const moving = await animations('no-preference')
    assert(moving.strokes.every((name) => name === 'draw'), 'the highlighter and the arrows draw themselves in')
    assert(moving.notes.every((name) => name === 'appear'), 'the notes appear with them')
    assert(moving.counts.every((count) => count === '1'), 'once: nothing loops')
    assertEqual(moving.elsewhere, 0, 'nothing else on the page moves')
  })

  suite.test('landing: Tab goes through the page in order and focus is always visible', async () => {
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto(`${base}/`)
    await settled(page)
    const seen = []
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      const stop = await page.evaluate(() => {
        const node = document.activeElement
        if (!node || node === document.body) return null
        // A topic shows its focus around the whole topic: on the link's ::after.
        const outlined = (style) => style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
        const box = node.getBoundingClientRect()
        return {
          text: (node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 44),
          outline: outlined(getComputedStyle(node)) || outlined(getComputedStyle(node, '::after')),
          onScreen: box.bottom > 0 && box.top < window.innerHeight,
        }
      })
      // After the last stop the focus leaves the page, or starts again at the top.
      if (!stop || (seen.length > 0 && stop.text === seen[0].text)) break
      seen.push(stop)
    }
    assertEqual(
      seen.map((stop) => stop.text),
      [
        'Skip to the content',
        'Notebook Lab',
        'Playground',
        'For teachers',
        'Sign in',
        'Dark',
        'Try a notebook',
        'Create a teacher account',
        '01 Speech to text',
        '02 Text to speech',
        '03 A language model, one token at a time',
        '04 Attention from scratch',
        '05 Diffusion on toy data',
        '00 Check your setup',
        'Create a teacher account',
        'Create an account',
        'Sign in',
        'Privacy',
        'Playground',
      ],
      'tab order',
    )
    assert(seen.every((stop) => stop.outline), `every stop shows a focus outline (${JSON.stringify(seen.filter((stop) => !stop.outline))})`)
    assert(seen.every((stop) => stop.onScreen), 'the page scrolls to what has the focus')
    // The skip link leads to the content.
    await page.goto(`${base}/`)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    assertEqual(await page.evaluate(() => document.activeElement.id), 'content', 'the skip link moves the focus to the content')
    await ctx.close()
  })
}

/** A copy of the site without accounts: a deployment without a database, or files on a host without the API. */
export function registerWithoutAccounts(suite, env, site) {
  suite.test(`landing without accounts (${site.what}): no account control anywhere, and "Try a notebook" works`, async () => {
    const ctx = await env.browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    // Even a browser that still holds a session secret from another time is offered nothing that cannot work.
    await ctx.addInitScript((key) => localStorage.setItem(key, 'left-over'), SECRET_KEY)
    const page = await ctx.newPage()
    const problems = watch(page)
    await page.goto(`${site.url}/`)
    await settled(page)
    assertEqual(await accountControls(page), [], 'no sign-in, sign-up or "My courses" control')
    assertEqual(await page.getByRole('link', { name: /Sign in|Create an? .*account|My courses/ }).count(), 0, 'none that a screen reader finds either')
    assert(!(await page.locator('section.join').isVisible()), '"Got a join code?" is not shown where nobody can join')
    assert(await page.getByRole('link', { name: 'Try a notebook' }).isVisible(), 'the playground is offered')
    assert(await page.getByRole('heading', { name: 'How it works for a teacher' }).isVisible(), 'the page still says what the product does')
    assertEqual(problems.filter((line) => !site.expected.some((pattern) => pattern.test(line))), [], 'console problems')
    await page.getByRole('link', { name: 'Try a notebook' }).click()
    await page.waitForSelector('.cell')
    assertEqual(new URL(page.url()).pathname, '/playground', 'the playground')
    assertEqual(await page.locator('.site-tools').getByRole('button', { name: 'Sign in' }).count(), 0, 'no sign-in button there either')
    await ctx.close()
  })
}
