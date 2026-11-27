/**
 * End-to-end tests of accounts, courses, assignments and submissions: a teacher and students in
 * separate browser contexts, against the real Worker under `wrangler dev` with a local D1 database
 * (or against the Node server, see run.mjs).
 */
import { strFromU8, unzipSync } from 'fflate'
import { assert, assertEqual, assertExcludes, assertIncludes, cell, notebook, outputText, runAll, runCell, waitIdle } from './helpers.mjs'

const SECRET_KEY = 'notebook-lab:session-secret'
const SESSION_HEADER = 'x-session-secret'

/** NumPy cannot be downloaded where these tests usually run. Everything else on the console is a failure. */
const ALWAYS_EXPECTED = [/numpy/i]

function watch(page) {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return problems
}

function unexpected(problems, allowed = []) {
  return problems.filter((line) => ![...ALWAYS_EXPECTED, ...allowed].some((pattern) => pattern.test(line)))
}

async function download(page, click) {
  const [file] = await Promise.all([page.waitForEvent('download'), click()])
  const chunks = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk)
  return { name: file.suggestedFilename(), data: Buffer.concat(chunks) }
}

async function waitSave(page, state, timeout = 30_000) {
  await page.waitForFunction((wanted) => document.querySelector('.save-state')?.dataset.save === wanted, state, { timeout })
}

async function noSidewaysScroll(page, what) {
  const sizes = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    wide: Array.from(document.querySelectorAll('#app *'))
      .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1 && !node.closest('.cm-scroller, .output-rich, .cell-rendered, pre, .table-wrap'))
      .map((node) => `${node.tagName.toLowerCase()}.${node.className}`)
      .slice(0, 5),
  }))
  assert(sizes.scrollWidth <= sizes.innerWidth, `${what}: no sideways scrolling at ${sizes.innerWidth} px (${sizes.scrollWidth}; ${sizes.wide.join(', ')})`)
  assertEqual(sizes.wide, [], `${what}: nothing sticks out at ${sizes.innerWidth} px`)
}

/** Replace the text of a code cell by typing, the way a person does. */
async function typeInCell(page, index, text) {
  await cell(page, index).locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type(text)
}

export function register(suite, env) {
  const { site } = env
  const base = site.url

  const context = (options = {}) =>
    env.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, locale: 'en-GB', timezoneId: 'Europe/Sofia', ...options })

  const shot = async (page, name, options = {}) => {
    if (!env.screenshotDir) return
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${env.screenshotDir}/${name}.png`, fullPage: true, ...options })
  }

  /** "Sign in" in the header: a link on the landing page, a button in the app. */
  const signInControl = (page) => page.locator('.site-tools :is(a, button)', { hasText: 'Sign in' })

  /** Sign up through the dialog, as a person does: from the landing page. Ends on "My courses". */
  async function signUp(page, who) {
    await page.goto(`${base}/`)
    await signInControl(page).click()
    const dialog = page.locator('dialog[open]')
    await dialog.getByRole('button', { name: 'Create an account' }).click()
    await dialog.getByLabel('Your name').fill(who.name)
    await dialog.getByLabel('Email').fill(who.email)
    await dialog.getByLabel('Password').fill(who.password)
    await dialog.locator(`input[type=radio][value=${who.role}]`).check()
    await dialog.getByRole('button', { name: 'Create account' }).click()
    await page.waitForURL('**/courses')
    await page.getByRole('heading', { name: 'My courses' }).waitFor()
  }

  async function signIn(page, who) {
    await signInControl(page).click()
    const dialog = page.locator('dialog[open]')
    await dialog.getByLabel('Email').fill(who.email)
    await dialog.getByLabel('Password').fill(who.password)
    await dialog.getByRole('button', { name: 'Sign in' }).click()
  }

  /**
   * A student who does not use the page at all: sign-up, joining, saving and submitting through
   * the API, the way somebody who wants to cheat or attack would.
   */
  async function apiStudent(who, joinCode) {
    const ctx = await context()
    let secret = ''
    const call = async (method, path, body, raw) => {
      const response = await ctx.request.fetch(`${base}/api${path}`, {
        method,
        headers: { ...(method !== 'GET' && { 'content-type': 'application/json' }), ...(secret && { [SESSION_HEADER]: secret }) },
        data: raw ?? (method === 'GET' ? undefined : JSON.stringify(body ?? {})),
      })
      const json = await response.json()
      if (json.sessionSecret) secret = json.sessionSecret
      return { status: response.status(), body: json }
    }
    const signedUp = await call('POST', '/auth/register', who)
    assertEqual(signedUp.status, 201, `sign-up of ${who.email}`)
    const joined = await call('POST', '/courses/join', { code: joinCode })
    assertEqual(joined.status, 201, `${who.email} joins`)
    return { ctx, call, id: signedUp.body.user.id }
  }

  const teacher = { name: 'Tess Teacher', email: 'tess@lab.test', password: 'teacher password', role: 'teacher' }
  const sam = { name: 'Sam Student', email: 'sam@lab.test', password: 'student password', role: 'student' }
  const twin = { name: 'Sam Student', email: 'samuel.two@lab.test', password: 'student password', role: 'student' }
  const mallory = { name: '=HYPERLINK("http://evil.example","Mallory")', email: 'mallory@lab.test', password: 'student password', role: 'student' }

  const starter = notebook([
    { md: '# Homework 1\n\nComplete `double` so that the check passes.', id: 'intro' },
    { code: 'def double(x):\n    return x  # TODO', id: 'task' },
    { code: 'assert double(2) == 4\nprint("check ok")', tags: ['check'], id: 'check' },
    { code: 'print("extra")', id: 'extra' },
  ])

  // What the long test below sets up, for the tests after it.
  const made = {}

  suite.test('signed out: the playground works, with a Sign in button; course pages ask to sign in; the brand leads to the landing page', async () => {
    const ctx = await context()
    const page = await ctx.newPage()
    const problems = watch(page)
    await page.goto(`${base}/playground`)
    await page.waitForSelector('.cell')
    await page.waitForFunction(() => document.title.startsWith('00-check-your-setup.ipynb'))
    await page.getByRole('button', { name: 'Sign in' }).waitFor()
    assertEqual(await page.locator('.site-nav a').count(), 0, 'no course navigation while signed out')
    assertEqual(await page.locator('.brand').getAttribute('href'), '/', 'the brand leads to the landing page')
    await runCell(page, 1)
    assertIncludes(await outputText(page, 1), 'emscripten', 'Python runs for a visitor who is not signed in')
    await waitSave(page, 'saved')
    assertEqual(await page.locator('.save-state').innerText(), 'Saved in this browser', 'the playground saves in the browser only')
    assertEqual(await page.evaluate(() => document.cookie), '', 'no cookie is set for a visitor')

    await page.goto(`${base}/courses`)
    await page.getByRole('heading', { name: 'Sign in to continue' }).waitFor()
    await page.goto(`${base}/course?id=aaaaaaaaaaaaaaaaaaaa`)
    await page.getByRole('heading', { name: 'Sign in to continue' }).waitFor()
    await page.goto(`${base}/playground`)
    await page.waitForSelector('.cell')
    assertEqual(unexpected(problems), [], 'console problems')

    // Every view is a real file; anything else is a real 404.
    for (const path of ['/courses', '/course', '/assignment', '/starter', '/submission', '/account', '/privacy', '/reset', '/playground']) {
      assertEqual((await ctx.request.get(`${base}${path}`)).status(), 200, `${path} is a page`)
    }
    const missing = await page.goto(`${base}/no-such-page`)
    assertEqual(missing.status(), 404, 'an unknown address is a real 404')
    assertIncludes(await page.locator('body').innerText(), 'Page not found', 'the 404 page')
    const apiMissing = await ctx.request.get(`${base}/api/no-such-route`)
    assertEqual(apiMissing.status(), 404, 'an unknown API address')
    assertIncludes(apiMissing.headers()['content-type'], 'application/json', 'the API answers JSON, also for 404')
    await page.goto(`${base}/course`)
    await page.getByRole('heading', { name: 'Page not found' }).waitFor()
    assertEqual(await page.locator('main svg.doodle-not-found').count(), 1, 'with its drawing')
    // From there, and from the brand, the start is the landing page: a document of its own.
    await page.getByRole('link', { name: 'Go to the start' }).click()
    await page.waitForURL(`${base}/`)
    await page.getByRole('heading', { level: 1, name: /Course notebooks/ }).waitFor()
    await ctx.close()
  })

  suite.test('a teacher sets an assignment, a student does it and submits, the teacher grades and releases, the student sees the grade', async () => {
    // --- The teacher signs up, makes a course and an assignment ------------------------------------
    const teacherCtx = await context()
    const tp = await teacherCtx.newPage()
    const teacherProblems = watch(tp)
    await signUp(tp, teacher)
    assertEqual(await tp.locator('.site-nav a').allInnerTexts(), ['My courses', 'Playground'], 'navigation for somebody who is signed in')
    assertEqual(await tp.locator('.brand').getAttribute('href'), '/courses', 'signed in, the brand leads to "My courses"')
    assertEqual(await tp.locator('main svg.doodle-no-courses').count(), 1, 'a new teacher sees the drawing of an empty notebook, once')
    assertEqual(await tp.locator('.account-link').innerText(), 'Tess Teacher', 'the account link shows the name')
    assert(typeof (await tp.evaluate((key) => localStorage.getItem(key), SECRET_KEY)) === 'string', 'the session secret is in localStorage')
    assertEqual(await tp.evaluate(() => document.cookie), '', 'the session cookie is HttpOnly: scripts do not see it')
    const cookies = await teacherCtx.cookies()
    assertEqual(cookies.map((c) => [c.name, c.httpOnly, c.sameSite, c.path]), [['notebook_lab_session', true, 'Strict', '/api']], 'one cookie: the session')

    await tp.getByLabel('Course name').fill('NLP 101')
    await tp.getByLabel('Term (optional)').fill('Autumn 2026')
    await tp.getByLabel('Description (optional)').fill('Speech, language models and diffusion.')
    await tp.getByRole('button', { name: 'Create course' }).click()
    await tp.waitForURL('**/course?id=*')
    await tp.getByRole('heading', { name: 'NLP 101' }).waitFor()
    made.courseId = new URL(tp.url()).searchParams.get('id')
    const joinCode = await tp.locator('.join-code').innerText()
    assert(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(joinCode), `the join code has unambiguous characters (${joinCode})`)
    made.joinCode = joinCode

    const due = new Date(Date.now() + 3 * 86_400_000)
    const pad = (n) => String(n).padStart(2, '0')
    // Typed as local time (Europe/Sofia in this browser), stored as UTC.
    const dueLocal = `${due.getUTCFullYear()}-${pad(due.getUTCMonth() + 1)}-${pad(due.getUTCDate())}T18:30`
    await tp.getByLabel('Title').fill('Homework 1')
    await tp.getByLabel('Instructions (Markdown, optional)').fill('Complete **double**.\n\n<script>window.__pwned = "instructions"</script><img src="data:image/png;base64,AA==" onerror="window.__pwned = \'img\'">')
    await tp.getByLabel('Due date and time (optional)').fill(dueLocal)
    await tp.getByLabel('Points (optional)').fill('10')
    await tp.locator('.choice-row input[type=file]').setInputFiles({ name: 'homework-1.ipynb', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(starter)) })
    await tp.getByRole('button', { name: 'Create draft' }).click()
    await tp.waitForURL('**/assignment?id=*')
    await tp.getByRole('heading', { name: 'Homework 1' }).waitFor()
    made.assignmentId = new URL(tp.url()).searchParams.get('id')
    assertIncludes(await tp.locator('.page-message').innerText(), 'Draft created', 'the page says what happened')
    assertEqual(await tp.locator('.page-head .badge').innerText(), 'Draft', 'a new assignment is a draft')
    assertIncludes(await tp.locator('.page-meta').first().innerText(), '18:30', 'the due time is shown in local time')
    const stored = await tp.evaluate(
      async ({ id, key, header }) => (await (await fetch(`/api/assignments/${id}`, { headers: { [header]: localStorage.getItem(key) } })).json()).assignment.dueAt,
      { id: made.assignmentId, key: SECRET_KEY, header: SESSION_HEADER },
    )
    // 18:30 in Sofia is 16:30 UTC in winter and 15:30 UTC in summer.
    assert([15, 16].includes(new Date(stored).getUTCHours()) && new Date(stored).getUTCMinutes() === 30, `the due time is stored as UTC (${new Date(stored).toISOString()})`)

    // Before publishing, the starter is edited in the normal editor and saved on the server.
    await tp.getByRole('link', { name: 'Edit starter' }).click()
    await tp.waitForURL('**/starter?id=*')
    await tp.waitForSelector('.cell-code')
    assertIncludes(await tp.locator('.assignment-panel').innerText(), 'Starter notebook: Homework 1', 'the starter editor says what it edits')
    await typeInCell(tp, 3, 'print("starter edited")')
    await waitSave(tp, 'saved')
    assertEqual(await tp.locator('.save-state').innerText(), 'Saved on the server', 'the starter is saved on the server')
    await shot(tp, 'starter-editor-1280')
    await tp.locator('.crumbs').getByRole('link', { name: 'Homework 1' }).click()
    await tp.getByRole('button', { name: 'Publish' }).waitFor()

    // --- A student who has not been told the code yet cannot see anything ------------------------
    const samCtx = await context()
    const sp = await samCtx.newPage()
    const samProblems = watch(sp)
    await signUp(sp, sam)
    assertIncludes(await sp.locator('main').innerText(), 'You are not in a course yet', 'a new student has no courses')
    await sp.getByLabel('Join code').fill(joinCode.toLowerCase())
    await sp.getByRole('button', { name: 'Join course' }).click()
    await sp.waitForURL('**/course?id=*')
    await sp.getByRole('heading', { name: 'NLP 101' }).waitFor()
    assertIncludes(await sp.locator('main').innerText(), 'Teacher: Tess Teacher', 'the student sees who teaches')
    assertIncludes(await sp.locator('main').innerText(), 'No assignments yet', 'a draft is not shown to students')
    assertExcludes(await sp.locator('main').innerText(), joinCode, 'the student page does not show the join code')

    await tp.getByRole('button', { name: 'Publish' }).click()
    await tp.locator('.page-head .badge[data-state=published]').waitFor()
    assertIncludes(await tp.locator('main').innerText(), 'replacing the starter affects only students who have not opened the assignment yet', 'the page says what replacing the starter does after publishing')
    assertEqual(await tp.getByRole('link', { name: 'Edit starter' }).count(), 0, 'after publishing the starter is replaced, not edited in place')

    // --- The student opens the assignment: their own copy of the starter ---------------------------
    await sp.reload()
    await sp.getByRole('link', { name: 'Homework 1' }).click()
    await sp.waitForURL('**/assignment?id=*')
    await sp.waitForSelector('.cell-code')
    const panel = sp.locator('.assignment-panel')
    assertEqual(await panel.locator('h1').innerText(), 'Homework 1', 'the assignment title')
    assertIncludes(await panel.innerText(), '18:30', 'the due time in the student\'s time zone')
    assertIncludes(await panel.innerText(), '10 points', 'the points')
    assertEqual(await panel.locator('.instructions strong').innerText(), 'double', 'instructions are rendered as Markdown')
    assertEqual(await panel.locator('.instructions script, .instructions img[onerror]').count(), 0, 'instructions are sanitized')
    assertEqual(await sp.evaluate(() => window.__pwned), undefined, 'nothing from the instructions ran')
    assertIncludes(await panel.locator('.panel-status').innerText(), 'Not submitted yet', 'status before submitting')
    assertEqual(await cell(sp, 3).locator('.cm-content').innerText(), 'print("starter edited")', 'the copy comes from the edited starter')
    assertEqual(await sp.locator('.save-state').innerText(), 'Saved on the server', 'the copy is on the server')
    assertEqual(await sp.getByRole('button', { name: 'Open', exact: true }).count(), 0, 'no "Open file" in an assignment')

    // Work: solve the task, run everything, and see it saved on the server.
    await typeInCell(sp, 1, 'double = lambda x: 2 * x')
    assertEqual(await sp.locator('.save-state').getAttribute('data-save'), 'pending', 'unsaved state is visible')
    await runAll(sp)
    assertIncludes(await outputText(sp, 2), 'check ok', 'the check cell ran')
    assertEqual(await sp.locator('.checks-summary').innerText(), 'Checks: 1 of 1 passed', 'the checks summary')
    await waitSave(sp, 'saved')
    assertEqual(await sp.locator('.save-state').innerText(), 'Saved on the server', 'saved state text')
    const localCopy = await sp.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('notebook-lab:remote:work:')).map(([, value]) => JSON.parse(value)))
    assertEqual(localCopy.length, 1, 'one local copy of the work')
    assertEqual([localCopy[0].dirty, localCopy[0].text.includes('2 * x')], [false, true], 'the local autosave has the work and is in sync')
    await shot(sp, 'student-assignment-1280')

    // The work is on the server, and survives a reload.
    const onServer = await sp.evaluate(
      async ({ id, key, header }) => (await (await fetch(`/api/assignments/${id}/work`, { method: 'POST', headers: { 'content-type': 'application/json', [header]: localStorage.getItem(key) } })).json()).notebook.cells[1].source.join(''),
      { id: made.assignmentId, key: SECRET_KEY, header: SESSION_HEADER },
    )
    assertEqual(onServer, 'double = lambda x: 2 * x', 'the server has the work')
    await sp.reload()
    await sp.waitForSelector('.cell-code')
    assertEqual(await cell(sp, 1).locator('.cm-content').innerText(), 'double = lambda x: 2 * x', 'the edit survived the reload')
    assertIncludes(await outputText(sp, 2), 'check ok', 'the output survived the reload')
    assertEqual(await sp.locator('.checks-summary').innerText(), 'Checks: 1 of 1 passed', 'the check state survived the reload')

    // Submit.
    await sp.getByRole('button', { name: 'Submit', exact: true }).click()
    const confirm = sp.locator('dialog[open]')
    assertIncludes(await confirm.innerText(), '1 of 1 check passed', 'the dialog says what is reported')
    await confirm.getByRole('button', { name: 'Submit', exact: true }).click()
    await sp.locator('.panel-status[data-status=submitted]').waitFor()
    assertIncludes(await sp.locator('.panel-status').innerText(), 'Submitted ', 'the status shows the submission time')
    assertIncludes(await sp.locator('.panel-status').innerText(), 'your browser reported 1 of 1 check passed', 'the reported checks are labelled as a report')
    await sp.getByRole('button', { name: 'Submit again' }).waitFor()
    assertEqual(await sp.locator('.panel-grade').isVisible(), false, 'no grade yet')

    // The student can always download their notebook.
    const mine = await download(sp, () => sp.getByRole('button', { name: 'Download' }).click())
    assertEqual(mine.name, 'homework-1.ipynb', 'the download keeps the file name')
    assertIncludes(JSON.parse(mine.data.toString('utf8')).cells[1].source.join(''), '2 * x', 'the downloaded notebook has the work')
    assertEqual(unexpected(samProblems), [], 'console problems of the student')

    // --- The teacher sees the submission ------------------------------------------------------------
    await tp.reload()
    await tp.getByRole('heading', { name: 'Homework 1' }).waitFor()
    assertEqual(await tp.locator('.counts').innerText().then((t) => t.replace(/\s+/g, ' ')), '1 enrolled 0 not started 0 in progress 1 submitted 0 submitted late 0 graded', 'counts at the top')
    const row = tp.locator('table.submissions tbody tr').first()
    assertIncludes(await row.innerText(), 'Sam Student', 'the student is in the table')
    assertIncludes(await row.innerText(), 'sam@lab.test', 'with the email')
    assertEqual(await row.locator('.badge').innerText(), 'Submitted', 'status')
    assertEqual(await row.locator('td[data-label=Checks]').innerText(), '1 of 1', 'reported checks')
    assertIncludes(await tp.locator('main').innerText(), "reported by the student's browser, not proof", 'the checks are labelled as a report, not proof')
    await shot(tp, 'assignment-table-1280')

    await row.getByRole('link', { name: 'Open and grade' }).click()
    await tp.waitForURL('**/submission?id=*')
    await tp.waitForSelector('.cell-code')
    made.samId = new URL(tp.url()).searchParams.get('student')
    assertEqual(await tp.locator('.review-panel h1').innerText(), 'Sam Student', 'the review names the student')
    assertIncludes(await tp.locator('.review-panel').innerText(), "1 of 1 check passed (reported by the student's browser, not proof)", 'reported checks in the review')
    assertEqual(await cell(tp, 1).locator('.cm-content').innerText(), 'double = lambda x: 2 * x', 'the submitted code')
    assertIncludes(await outputText(tp, 2), 'check ok', 'stored outputs are shown as submitted, before anything runs')
    assertEqual(await cell(tp, 2).locator('.cell-count').innerText(), '[2]', 'with the execution counts of the student')
    assertEqual(await tp.locator('.save-state').innerText(), 'Review copy: changes are not saved', 'the review says that nothing is saved')

    // The teacher can run cells and change code. None of it reaches the submission.
    await typeInCell(tp, 3, 'print("run by the teacher", double(21))')
    await runAll(tp)
    assertIncludes(await outputText(tp, 3), 'run by the teacher 42', 'the teacher ran the student\'s code')
    assertEqual(await tp.locator('.save-state').innerText(), 'Review copy: changes are not saved', 'still not saved')
    await shot(tp, 'submission-review-1280')

    await tp.getByLabel('Grade (of 10 points)').fill('8.5')
    await tp.getByLabel('Feedback (plain text or Markdown, optional)').fill('Good **work**.\n\n<img src="data:image/png;base64,AA==" onerror="window.__pwned = \'feedback\'">')
    await tp.getByRole('button', { name: 'Save grade' }).click()
    await tp.locator('.grade-form .form-status:not(:empty)').waitFor()
    assertIncludes(await tp.locator('.grade-form').innerText(), 'not released yet', 'the form says that the student does not see the grade yet')

    await tp.reload()
    await tp.waitForSelector('.cell-code')
    assertEqual(await cell(tp, 3).locator('.cm-content').innerText(), 'print("starter edited")', 'the submission is as the student handed it in')
    assertExcludes(await outputText(tp, 3), 'run by the teacher', 'the teacher\'s run was not stored')
    assertEqual(await tp.getByLabel('Grade (of 10 points)').inputValue(), '8.5', 'the grade was stored')
    const reviewed = await download(tp, () => tp.getByRole('button', { name: 'Download' }).click())
    assertEqual(reviewed.name, 'Sam_Student.ipynb', 'one submission downloads under the student\'s name')
    assertIncludes(JSON.parse(reviewed.data.toString('utf8')).cells[1].source.join(''), '2 * x', 'the downloaded submission')

    // --- Grades are hidden until they are released -----------------------------------------------------
    await sp.reload()
    await sp.waitForSelector('.cell-code')
    assertEqual(await sp.locator('.panel-grade').isVisible(), false, 'the student does not see the grade before the release')
    assertExcludes(await sp.locator('.assignment-panel').innerText(), '8.5', 'no grade in the panel')

    await tp.locator('.crumbs').getByRole('link', { name: 'Homework 1' }).click()
    await tp.getByRole('button', { name: 'Release grades to students' }).click()
    await tp.locator('dialog[open]').getByRole('button', { name: 'Release', exact: true }).click()
    await tp.locator('.release-state[data-released=true]').waitFor()
    assertEqual(await tp.locator('table.submissions tbody tr').first().locator('td[data-label=Grade]').innerText(), '8.5 of 10', 'the grade in the table')

    await sp.reload()
    await sp.waitForSelector('.cell-code')
    await sp.locator('.panel-grade').waitFor()
    assertIncludes(await sp.locator('.panel-grade').innerText(), 'Grade: 8.5 of 10', 'the student sees the grade after the release')
    assertEqual(await sp.locator('.panel-grade .feedback strong').innerText(), 'work', 'feedback is rendered as Markdown')
    assertEqual(await sp.locator('.panel-grade img[onerror], .panel-grade script').count(), 0, 'feedback is sanitized')
    assertEqual(await sp.evaluate(() => window.__pwned), undefined, 'nothing from the feedback ran')
    await shot(sp, 'student-assignment-graded-1280')
    await sp.goto(`${base}/course?id=${made.courseId}`)
    await sp.locator('table.data-table').waitFor()
    assertIncludes(await sp.locator('table.data-table tbody tr').first().innerText(), '8.5 of 10', 'the grade in the student\'s list of assignments')

    assertEqual(unexpected(teacherProblems), [], 'console problems of the teacher')
    assertEqual(unexpected(samProblems), [], 'console problems of the student')
    made.teacherCtx = teacherCtx
    made.samCtx = samCtx
  })

  suite.test('a second tab cannot silently overwrite newer work: "keep mine" or "load the newer one"', async () => {
    assert(made.samCtx, 'needs the test above')
    const url = `${base}/assignment?id=${made.assignmentId}`
    const one = await made.samCtx.newPage()
    const two = await made.samCtx.newPage()
    await one.goto(url)
    await one.waitForSelector('.cell-code')
    await two.goto(url)
    await two.waitForSelector('.cell-code')

    await typeInCell(two, 3, 'print("from tab two")')
    await waitSave(two, 'saved')
    await typeInCell(one, 3, 'print("from tab one")')
    await waitSave(one, 'conflict')
    assertIncludes(await one.locator('.notice').innerText(), 'saved somewhere else', 'the conflict is explained')
    assertEqual(await one.locator('.save-state').innerText(), 'Not saved on the server: a newer version exists', 'the save state says so')
    await one.locator('.notice').getByRole('button', { name: 'Load the newer one' }).click()
    await one.waitForFunction(() => document.querySelectorAll('.cell')[3]?.querySelector('.cm-content')?.innerText === 'print("from tab two")')
    await waitSave(one, 'saved')

    // The other way round: tab two is now behind, and keeps its own version.
    await typeInCell(one, 3, 'print("tab one again")')
    await waitSave(one, 'saved')
    await typeInCell(two, 3, 'print("tab two wins")')
    await waitSave(two, 'conflict')
    await two.locator('.notice').getByRole('button', { name: 'Keep mine' }).click()
    await waitSave(two, 'saved')
    await one.reload()
    await one.waitForSelector('.cell-code')
    assertEqual(await cell(one, 3).locator('.cm-content').innerText(), 'print("tab two wins")', '"keep mine" stored that version')
    await one.close()
    await two.close()
  })

  suite.test('work survives being offline: it stays in the browser and is saved on the server when the connection is back', async () => {
    assert(made.samCtx, 'needs the tests above')
    const page = await made.samCtx.newPage()
    await page.goto(`${base}/assignment?id=${made.assignmentId}`)
    await page.waitForSelector('.cell-code')

    await made.samCtx.setOffline(true)
    await typeInCell(page, 3, 'print("written offline")')
    await waitSave(page, 'offline')
    assertIncludes(await page.locator('.save-state').innerText(), 'Saved in this browser. The server cannot be reached', 'the state says where the work is')
    const copy = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith('notebook-lab:remote:work:'))[1]))
    assertEqual([copy.dirty, copy.text.includes('written offline')], [true, true], 'the local autosave holds the unsynced work')
    await made.samCtx.setOffline(false)
    await waitSave(page, 'saved', 20_000)
    assertEqual(await page.locator('.save-state').innerText(), 'Saved on the server', 'synced when the connection is back')

    // The tab is closed while the server cannot be reached: the next visit restores the work and saves it.
    await page.route('**/api/assignments/*/work*', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()))
    await typeInCell(page, 3, 'print("only in this browser")')
    await waitSave(page, 'offline')
    await page.unroute('**/api/assignments/*/work*')
    await page.reload()
    await page.waitForSelector('.cell-code')
    assertEqual(await cell(page, 3).locator('.cm-content').innerText(), 'print("only in this browser")', 'the unsaved work was restored from this browser')
    assertIncludes(await page.locator('.notice').innerText(), 'were restored', 'the page says so')
    await waitSave(page, 'saved')
    const server = await page.evaluate(
      async ({ id, key, header }) => (await (await fetch(`/api/assignments/${id}/work`, { method: 'POST', headers: { 'content-type': 'application/json', [header]: localStorage.getItem(key) } })).json()).notebook.cells[3].source.join(''),
      { id: made.assignmentId, key: SECRET_KEY, header: SESSION_HEADER },
    )
    assertEqual(server, 'print("only in this browser")', 'and it is on the server now')
    await page.close()
  })

  suite.test('a notebook over 1 MB: the largest binary outputs are left out of the server copy, and the student is told which', async () => {
    assert(made.samCtx, 'needs the tests above')
    const page = await made.samCtx.newPage()
    await page.goto(`${base}/assignment?id=${made.assignmentId}`)
    await page.waitForSelector('.cell-code')
    // A picture of about 1.5 MB (as base64), made by plain Python: no NumPy needed.
    await typeInCell(
      page,
      3,
      'import base64, os, lab; lab._bridge.emit({"output_type": "display_data", "data": {"image/png": base64.b64encode(os.urandom(1_100_000)).decode(), "text/plain": "<a big picture>"}, "metadata": {}}); print("text stays")',
    )
    await runCell(page, 3)
    await waitSave(page, 'saved', 60_000)
    assertEqual(await page.locator('.save-state').innerText(), 'Saved on the server without 1 large output', 'the save state says that something was left out')
    const notice = await page.locator('.notice').innerText()
    assertIncludes(notice, 'the image of cell 4 (1.5 MB)', 'the notice names the output')
    assertIncludes(notice, 'code and text are always saved', 'and says what is never dropped')
    const server = await page.evaluate(
      async ({ id, key, header }) => (await (await fetch(`/api/assignments/${id}/work`, { method: 'POST', headers: { 'content-type': 'application/json', [header]: localStorage.getItem(key) } })).json()).notebook.cells[3],
      { id: made.assignmentId, key: SECRET_KEY, header: SESSION_HEADER },
    )
    const display = server.outputs.find((o) => o.output_type === 'display_data')
    assertEqual(Object.keys(display.data), ['text/plain'], 'the picture is not in the server copy')
    assertIncludes([].concat(display.data['text/plain']).join(''), 'was not saved on the server', 'a note stands in its place')
    assertIncludes(JSON.stringify(server.outputs), 'text stays', 'text output is kept')
    assertIncludes(server.source.join(''), 'os.urandom', 'code is kept')
    assertEqual(await cell(page, 3).locator('.cell-outputs img').count(), 1, 'the picture is still on the page')
    const file = await download(page, () => page.getByRole('button', { name: 'Download' }).click())
    assert(file.data.length > 1_400_000, 'and in the downloaded file')
    // Put the cell back, so that the next tests start from a small notebook.
    await typeInCell(page, 3, 'print("final answer")')
    await page.getByRole('button', { name: 'Clear outputs' }).click()
    await runAll(page)
    await waitSave(page, 'saved')
    await page.getByRole('button', { name: 'Submit again' }).click()
    await page.locator('dialog[open]').getByRole('button', { name: 'Submit', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.panel-status')?.textContent.includes('submissions'))
    assertIncludes(await page.locator('.panel-status').innerText(), 'the latest one counts', 'submitting again is counted')
    await page.close()
  })

  suite.test('code in a submission cannot use the teacher\'s session: every API call from a cell gets 401 and changes nothing', async () => {
    assert(made.teacherCtx, 'needs the tests above')
    // Mallory never opens the page. Her submission is made through the API: a stored output that
    // tries to run script, and a cell that calls the API with the cookies of whoever runs it.
    const attacker = await apiStudent(mallory, made.joinCode)
    made.malloryId = attacker.id
    const { courseId, assignmentId, samId } = made
    const targets = {
      session: ['GET', '/api/auth/session'],
      courses: ['GET', '/api/courses'],
      course: ['GET', `/api/courses/${courseId}`],
      assignment: ['GET', `/api/assignments/${assignmentId}`],
      starter: ['GET', `/api/assignments/${assignmentId}/starter`],
      otherSubmission: ['GET', `/api/assignments/${assignmentId}/submissions/${samId}`],
      rename: ['PATCH', `/api/courses/${courseId}`, { name: 'Owned by Mallory' }],
      newCode: ['POST', `/api/courses/${courseId}/code`, {}],
      grade: ['PUT', `/api/assignments/${assignmentId}/submissions/${attacker.id}/grade`, { grade: 10, feedback: 'Perfect.' }],
      release: ['PATCH', `/api/assignments/${assignmentId}`, { gradesReleased: false, title: 'Owned' }],
      removeSam: ['DELETE', `/api/courses/${courseId}/students/${samId}`],
      deleteCourse: ['DELETE', `/api/courses/${courseId}`],
      password: ['POST', '/api/auth/password', { currentPassword: 'x', newPassword: 'owned owned' }],
      deleteAccount: ['POST', '/api/auth/delete', { password: 'x' }],
    }
    // Signing out with the cookie alone answers 200 and does nothing (checked further down: the teacher stays signed in).
    const harmless = { logout: ['POST', '/api/auth/logout', {}] }
    const attack = `
import json, js
from pyodide.ffi import to_js

TARGETS = json.loads(${JSON.stringify(JSON.stringify({ ...targets, ...harmless }))})

async def call(method, path, body=None):
    options = {"method": method, "credentials": "include", "headers": {"Content-Type": "application/json"}}
    if body is not None:
        options["body"] = json.dumps(body)
    response = await js.fetch(path, to_js(options, dict_converter=js.Object.fromEntries))
    return [response.status, response.headers.get("content-type"), (await response.text())[:300]]

results = {}
for name, target in TARGETS.items():
    results[name] = await call(*target)
# The page's storage, where the session secret lives, does not exist in a worker.
results["localStorage"] = hasattr(js, "localStorage")
results["document"] = hasattr(js, "document")
# Messages that the page never asked for.
js.postMessage(to_js({"type": "host-request", "id": 4242, "method": "api", "params": {"path": "/api/courses"}}, dict_converter=js.Object.fromEntries))
js.postMessage(to_js({"type": "host-request", "id": "x", "method": "inference"}, dict_converter=js.Object.fromEntries))
js.postMessage("give me the secret")
js.postMessage(None)
print("RESULTS" + json.dumps(results))
`
    const evil = notebook([
      { md: '# My homework\n\n<img src="data:image/png;base64,AA==" onerror="window.__pwned = \'markdown\'"><a href="javascript:window.__pwned=1">click me</a>' },
      {
        code: 'print("looks harmless")',
        execution_count: 1,
        outputs: [
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'text/html': `<script>window.__pwned = 'output'; fetch('/api/courses/${courseId}', {method: 'DELETE'})</script><img src="data:image/png;base64,AA==" onerror="window.__pwned = 'onerror'"><form action="/api/auth/logout" method="post"><button>Click</button></form><b>stored output</b>`,
            },
          },
        ],
      },
      { code: attack },
    ])
    assertEqual((await attacker.call('POST', `/assignments/${assignmentId}/work`)).status, 201, 'Mallory opens the assignment')
    assertEqual((await attacker.call('PUT', `/assignments/${assignmentId}/work?version=1`, null, JSON.stringify(evil))).status, 200, 'Mallory saves her notebook')
    assertEqual((await attacker.call('POST', `/assignments/${assignmentId}/submit`, { version: 2, checksPassed: 99, checksTotal: 99 })).status, 200, 'Mallory submits')

    // The teacher opens the submission, signed in, and runs it.
    const page = await made.teacherCtx.newPage()
    const problems = watch(page)
    const requests = []
    page.on('request', (request) => requests.push(request))
    // Record everything the page sends to its workers.
    await page.addInitScript(() => {
      window.__toWorker = []
      const original = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (message, ...rest) {
        try {
          window.__toWorker.push(JSON.stringify(message))
        } catch {
          window.__toWorker.push(String(message))
        }
        return original.call(this, message, ...rest)
      }
    })
    await page.goto(`${base}/submission?id=${assignmentId}&student=${attacker.id}`)
    await page.waitForSelector('.cell-code')
    const secret = await page.evaluate((key) => localStorage.getItem(key), SECRET_KEY)
    assert(secret && secret.length >= 40, 'the teacher is signed in on this page')
    assertEqual(await cell(page, 1).locator('.output-html b').innerText(), 'stored output', 'the stored output is shown')
    assertEqual(await page.locator('.cells script, .cells form, .cells button:not([class]), .cells [onerror], .cells a[href^="javascript"]').count(), 0, 'stored HTML and Markdown are sanitized')
    assertIncludes(await page.locator('.review-panel').innerText(), '99 of 99 checks passed (reported by the student\'s browser, not proof)', 'made-up check counts are shown as a report, not as a fact')

    await runCell(page, 2)
    const output = await outputText(page, 2)
    assertIncludes(output, 'RESULTS', `the attack cell ran:\n${output}`)
    const results = JSON.parse(output.slice(output.indexOf('RESULTS') + 'RESULTS'.length))
    assertEqual(results.session, [200, 'application/json', '{"user":null}'], 'the worker is nobody to the API')
    for (const name of Object.keys(targets).filter((n) => n !== 'session')) {
      assertEqual(results[name], [401, 'application/json', '{"error":"Please sign in."}'], `${name}: ${targets[name][0]} ${targets[name][1]} from a notebook cell`)
    }
    assertEqual(results.logout, [200, 'application/json', '{"ok":true}'], 'signing out from a cell is answered, and ignored')
    assertEqual([results.localStorage, results.document], [false, false], 'the worker has neither localStorage nor the document')
    assertEqual(await page.evaluate(() => window.__pwned), undefined, 'no script from the notebook ran on the page')

    // The requests really carried the teacher's cookie, and still were refused: the header is what was missing.
    const fromCell = requests.filter((r) => r.url() === `${base}/api/courses/${courseId}` && r.method() === 'DELETE')
    assertEqual(fromCell.length, 1, 'the DELETE from the cell was sent once (the one in the stored output never ran)')
    const sent = await fromCell[0].allHeaders()
    assertIncludes(sent.cookie ?? '', 'notebook_lab_session=', 'the browser attached the session cookie to the request from the worker')
    assertEqual(sent[SESSION_HEADER], undefined, 'but the worker has no session secret to send')

    // The secret is nowhere a worker can look: not in a message, an address, IndexedDB, Cache Storage or a cookie.
    const places = await page.evaluate(async () => ({
      toWorker: window.__toWorker.join('\n'),
      databases: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [],
      caches: await caches.keys(),
      cookie: document.cookie,
      storageKeys: Object.keys(localStorage),
      sessionStorage: JSON.stringify(sessionStorage),
    }))
    assert(places.toWorker.length > 0, 'messages to the worker were recorded')
    assertExcludes(places.toWorker, secret, 'the secret is in no message to the worker')
    assertEqual([places.databases, places.caches, places.cookie], [[], [], ''], 'nothing in IndexedDB, Cache Storage or script-readable cookies')
    assertExcludes(places.sessionStorage, secret, 'not in sessionStorage either')
    for (const request of requests) assertExcludes(request.url(), secret, 'the secret is in no address')
    const withSecret = []
    for (const request of requests) if ((await request.allHeaders())[SESSION_HEADER]) withSecret.push(new URL(request.url()))
    assert(withSecret.length > 0, 'the page itself sends the secret')
    assert(withSecret.every((u) => u.origin === base && u.pathname.startsWith('/api/')), 'and only to this site\'s API')

    // Nothing was read or changed: the course, the grades and the accounts are as they were.
    const state = await page.evaluate(
      async ({ courseId, assignmentId, key, header }) => {
        const get = async (path) => (await fetch(path, { headers: { [header]: localStorage.getItem(key) } })).json()
        return { course: await get(`/api/courses/${courseId}`), assignment: await get(`/api/assignments/${assignmentId}`), session: await get('/api/auth/session') }
      },
      { courseId, assignmentId, key: SECRET_KEY, header: SESSION_HEADER },
    )
    assertEqual(state.course.course.name, 'NLP 101', 'the course was not renamed or deleted')
    assertEqual(state.course.course.joinCode.replace('-', ''), made.joinCode.replace('-', ''), 'the join code is the same')
    assertEqual(state.course.roster.map((s) => s.email).sort(), ['mallory@lab.test', 'sam@lab.test'], 'nobody was removed')
    assertEqual([state.assignment.assignment.title, state.assignment.assignment.gradesReleased], ['Homework 1', true], 'the assignment is unchanged')
    assertEqual(state.assignment.students.find((s) => s.email === 'mallory@lab.test').grade, null, 'Mallory did not grade herself')
    assertEqual(state.session.user.email, 'tess@lab.test', 'the teacher is still signed in')

    // The same with the cookie alone, outside any browser page.
    const cookieOnly = await made.teacherCtx.request.get(`${base}/api/courses`)
    assertEqual(cookieOnly.status(), 401, 'the cookie without the header is refused')
    const both = await made.teacherCtx.request.get(`${base}/api/courses`, { headers: { [SESSION_HEADER]: secret } })
    assertEqual(both.status(), 200, 'cookie and header together are accepted')

    assertEqual(unexpected(problems, [/status of 401/]), [], 'console problems (the refused requests are expected)')
    await page.close()
    made.attacker = attacker
  })

  suite.test('downloads: all submissions as one zip with safe, unique file names; the table as CSV that a spreadsheet will not run', async () => {
    assert(made.attacker, 'needs the tests above')
    const { assignmentId } = made
    // A second student with the same name as the first.
    const second = await apiStudent(twin, made.joinCode)
    await second.call('POST', `/assignments/${assignmentId}/work`)
    await second.call('PUT', `/assignments/${assignmentId}/work?version=1`, null, JSON.stringify(notebook(['print("the other Sam")'])))
    assertEqual((await second.call('POST', `/assignments/${assignmentId}/submit`, { version: 2 })).status, 200, 'the second Sam submits')
    // And one who only started.
    const idle = await apiStudent({ name: 'Ida Idle', email: 'ida@lab.test', password: 'student password', role: 'student' }, made.joinCode)
    await idle.call('POST', `/assignments/${assignmentId}/work`)

    const page = await made.teacherCtx.newPage()
    const problems = watch(page)
    await page.goto(`${base}/assignment?id=${assignmentId}`)
    await page.locator('table.submissions').waitFor()
    assertEqual(await page.locator('.counts').innerText().then((t) => t.replace(/\s+/g, ' ')), '4 enrolled 0 not started 1 in progress 3 submitted 0 submitted late 1 graded', 'counts')
    assertEqual(await page.locator('table.submissions tbody tr').count(), 4, 'all enrolled students are in the table')
    assertEqual(await page.locator('table.submissions tbody tr .badge').allInnerTexts(), ['Submitted', 'In progress', 'Submitted', 'Submitted'], 'statuses, sorted by name')

    const zip = await download(page, () => page.getByRole('button', { name: 'Download all (.zip)' }).click())
    assertEqual(zip.name, 'Homework_1-submissions.zip', 'the zip file name')
    const files = unzipSync(new Uint8Array(zip.data))
    assertEqual(Object.keys(files).sort(), ['HYPERLINK_http_evil.example_Mallory.ipynb', 'Sam_Student-2.ipynb', 'Sam_Student.ipynb'], 'file names from student names: sanitized and unique')
    const sources = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, JSON.parse(strFromU8(data)).cells.map((c) => [].concat(c.source).join('')).join('\n')]))
    assertIncludes(sources['Sam_Student.ipynb'], 'print("final answer")', 'the first Sam\'s latest submission')
    assertIncludes(sources['Sam_Student-2.ipynb'], 'the other Sam', 'the second Sam\'s submission')
    assertIncludes(sources['HYPERLINK_http_evil.example_Mallory.ipynb'], 'looks harmless', 'Mallory\'s submission')
    assertEqual(JSON.parse(strFromU8(files['Sam_Student.ipynb'])).nbformat, 4, 'the files are notebooks')

    const csv = await download(page, () => page.getByRole('button', { name: 'Export table (.csv)' }).click())
    assertEqual(csv.name, 'Homework_1-grades.csv', 'the CSV file name')
    const text = csv.data.toString('utf8')
    assert(text.startsWith('\uFEFFStudent,Email,Status,Submitted at (UTC),Late,Submissions,'), 'the CSV has a header row')
    const lines = text.trim().split('\r\n')
    assertEqual(lines.length, 5, 'a header and one row per enrolled student')
    assert(lines[1].startsWith('"\'=HYPERLINK(""http://evil.example"",""Mallory"")",mallory@lab.test,Submitted,'), `a name that starts with "=" is escaped: ${lines[1]}`)
    assertIncludes(lines[1], ',no,1,99,99,,10,', 'Mallory: not late, one submission, the reported checks, no grade, 10 points')
    assert(lines[2].startsWith('Ida Idle,ida@lab.test,In progress,,,0,,,,10,'), `somebody who did not submit: ${lines[2]}`)
    assert(/^Sam Student,sam@lab\.test,Submitted,\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z,no,\d+,1,1,8\.5,10,/.test(lines[3]), `Sam with grade and feedback: ${lines[3]}`)
    assertIncludes(text, 'Good **work**.', 'the feedback is in the CSV')
    for (const line of lines.slice(1)) assert(!/(^|,)"?[=+\-@]/.test(line), `no cell starts with a formula character: ${line}`)
    assertEqual(unexpected(problems), [], 'console problems')
    await page.close()
    await second.ctx.close()
    await idle.ctx.close()
  })

  suite.test('layout at 1280 and 390 px, light and dark, keyboard and focus: teacher and student pages', async () => {
    assert(made.teacherCtx, 'needs the tests above')
    const teacherPage = await made.teacherCtx.newPage()
    const studentPage = await made.samCtx.newPage()
    const teacherProblems = watch(teacherPage)
    const studentProblems = watch(studentPage)
    const { courseId, assignmentId, samId } = made
    const pages = [
      [teacherPage, 'teacher-home', '/courses', '.course-card'],
      [teacherPage, 'course', `/course?id=${courseId}`, 'table.roster'],
      [teacherPage, 'assignment-table', `/assignment?id=${assignmentId}`, 'table.submissions'],
      [teacherPage, 'submission-review', `/submission?id=${assignmentId}&student=${samId}`, '.cell-code'],
      [teacherPage, 'account', '/account', 'form'],
      [teacherPage, 'privacy', '/privacy', 'h2'],
      [studentPage, 'student-home', '/courses', '.course-card'],
      [studentPage, 'student-course', `/course?id=${courseId}`, 'table.data-table'],
      [studentPage, 'student-assignment', `/assignment?id=${assignmentId}`, '.cell-code'],
    ]
    for (const [page, name, path, ready] of pages) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: 'light' })
        await page.goto(`${base}${path}`)
        await page.locator(ready).first().waitFor()
        await noSidewaysScroll(page, `${name} (${path})`)
        await shot(page, `${name}-${width}`)
        if (name === 'assignment-table' || name === 'student-assignment') {
          await page.emulateMedia({ colorScheme: 'dark' })
          const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
          const [r, g, b] = background.match(/\d+/g).map(Number)
          assert(r + g + b < 150, `${name}: dark background (${background})`)
          await shot(page, `${name}-${width}-dark`)
        }
      }
    }
    assertEqual(unexpected(teacherProblems), [], 'console problems of the teacher')
    assertEqual(unexpected(studentProblems), [], 'console problems of the student')

    // Keyboard: Tab goes through the page in order, starting with the skip link, and focus is visible.
    await teacherPage.setViewportSize({ width: 1280, height: 900 })
    await teacherPage.emulateMedia({ colorScheme: 'light' })
    await teacherPage.goto(`${base}/course?id=${courseId}`)
    await teacherPage.locator('table.roster').waitFor()
    const seen = []
    for (let i = 0; i < 9; i++) {
      await teacherPage.keyboard.press('Tab')
      seen.push(
        await teacherPage.evaluate(() => {
          const node = document.activeElement
          const style = getComputedStyle(node)
          return { text: (node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 40), outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0, tag: node.tagName }
        }),
      )
    }
    assertEqual(seen.map((s) => s.text), ['Skip to the content', 'Notebook Lab', 'My courses', 'Playground', 'Tess Teacher', 'Dark', 'My courses', 'Copy', 'New code'], 'tab order')
    assert(seen.every((s) => s.outline), `every focused element shows a focus outline (${JSON.stringify(seen.filter((s) => !s.outline))})`)
    // A dialog takes the keyboard, and Escape closes it.
    await teacherPage.getByRole('button', { name: 'New code' }).click()
    assert(await teacherPage.locator('dialog[open]').evaluate((dialog) => dialog.contains(document.activeElement)), 'focus is inside the dialog')
    await teacherPage.keyboard.press('Escape')
    assertEqual(await teacherPage.locator('dialog[open]').count(), 0, 'Escape closes the dialog')
    assertEqual((await teacherPage.locator('.join-code').innerText()).replace('-', ''), made.joinCode.replace('-', ''), 'and nothing happened')
    await teacherPage.close()
    await studentPage.close()
  })

  suite.test('course housekeeping: new join code, joining off, removing a student, closing an assignment, leaving', async () => {
    assert(made.teacherCtx, 'needs the tests above')
    const { courseId, assignmentId } = made
    const tp = await made.teacherCtx.newPage()
    const sp = await made.samCtx.newPage()
    const allowed = [/status of 404/, /status of 409/]
    const problems = watch(tp)
    await tp.goto(`${base}/course?id=${courseId}`)
    await tp.locator('table.roster').waitFor()
    assertEqual(await tp.locator('table.roster tbody tr').count(), 4, 'the roster lists every student')
    assertIncludes(await tp.locator('table.roster tbody tr').nth(2).innerText(), 'sam@lab.test', 'with name, email and the date they joined')

    // A new code replaces the old one.
    await tp.getByRole('button', { name: 'New code' }).click()
    await tp.locator('dialog[open]').getByRole('button', { name: 'Make a new code' }).click()
    await tp.waitForFunction((old) => document.querySelector('.join-code')?.textContent !== old, made.joinCode)
    const newCode = await tp.locator('.join-code').innerText()
    const late = await context()
    const lp = await late.newPage()
    const lateProblems = watch(lp)
    await signUp(lp, { name: 'Lena Late', email: 'lena@lab.test', password: 'student password', role: 'student' })
    await lp.getByLabel('Join code').fill(made.joinCode)
    await lp.getByRole('button', { name: 'Join course' }).click()
    await lp.locator('.join-form .form-error:not(:empty)').waitFor()
    assertIncludes(await lp.locator('.join-form .form-error').innerText(), 'No course can be joined with this code', 'the old code no longer works')

    // Joining switched off: the new code does not work either, and the page says why.
    await tp.getByRole('button', { name: 'Switch joining off' }).click()
    await tp.locator('.page-section[data-join-open=false]').waitFor()
    await lp.getByLabel('Join code').fill(newCode)
    await lp.getByRole('button', { name: 'Join course' }).click()
    await lp.waitForFunction(() => document.querySelector('.join-form button[type=submit]')?.disabled === false)
    assertIncludes(await lp.locator('.join-form .form-error').innerText(), 'No course can be joined with this code', 'joining is off')
    await tp.getByRole('button', { name: 'Switch joining on' }).click()
    await tp.locator('.page-section[data-join-open=true]').waitFor()
    await lp.getByRole('button', { name: 'Join course' }).click()
    await lp.waitForURL('**/course?id=*')
    await lp.getByRole('heading', { name: 'NLP 101' }).waitFor()
    assertEqual(unexpected(lateProblems, allowed), [], 'console problems of the late student')

    // The teacher removes that student: their access ends at once.
    await tp.reload()
    await tp.locator('table.roster').waitFor()
    const lena = tp.locator('table.roster tbody tr', { hasText: 'lena@lab.test' })
    await lena.getByRole('button', { name: 'Remove' }).click()
    const dialog = tp.locator('dialog[open]')
    assertIncludes(await dialog.innerText(), 'deletes the work, the submissions and the grades of Lena Late in this course', 'the dialog says exactly what is deleted')
    await dialog.getByRole('button', { name: 'Remove and delete their work' }).click()
    await tp.waitForFunction(() => !document.querySelector('table.roster')?.textContent.includes('lena@lab.test'))
    await lp.reload()
    await lp.getByRole('heading', { name: 'Not found' }).waitFor()
    await late.close()

    // Closing the assignment: no more submissions.
    await tp.goto(`${base}/assignment?id=${assignmentId}`)
    await tp.getByRole('button', { name: 'Close', exact: true }).click()
    await tp.locator('.page-head .badge[data-state=closed]').waitFor()
    await sp.goto(`${base}/assignment?id=${assignmentId}`)
    await sp.waitForSelector('.cell-code')
    assertIncludes(await sp.locator('.panel-head').innerText(), 'Closed', 'the student sees that it is closed')
    assert(await sp.getByRole('button', { name: 'Submit again' }).isDisabled(), 'Submit is off')
    await tp.getByRole('button', { name: 'Open again' }).click()
    await tp.locator('.page-head .badge[data-state=published]').waitFor()

    // The student leaves: the dialog says what goes, and the teacher's table no longer has them.
    await sp.goto(`${base}/course?id=${courseId}`)
    await sp.getByRole('button', { name: 'Leave course' }).click()
    assertIncludes(await sp.locator('dialog[open]').innerText(), 'deletes your work, your submissions and your grades in this course', 'leaving says what is deleted')
    await sp.locator('dialog[open]').getByRole('button', { name: 'Leave and delete my work' }).click()
    await sp.waitForURL('**/courses')
    assertIncludes(await sp.locator('.page-message').innerText(), 'You left NLP 101', 'the page confirms')
    await tp.reload()
    await tp.locator('table.submissions').waitFor()
    assertExcludes(await tp.locator('table.submissions').innerText(), 'sam@lab.test', 'the student who left is gone from the table')
    assertEqual(unexpected(problems, allowed), [], 'console problems of the teacher')
    await tp.close()
    await sp.close()
  })

  suite.test('account: change the name, sign out and in, forgotten password, change password, delete the account', async () => {
    assert(made.teacherCtx, 'needs the tests above')
    const page = await made.samCtx.newPage()
    const problems = watch(page)
    await page.goto(`${base}/account`)
    await page.getByLabel('Name').fill('Samuel Student')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.account-link')?.textContent === 'Samuel Student')

    // Sign out: the session, the secret and the local copies of course notebooks are gone from this browser.
    // Signed out, home is the landing page.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL(`${base}/`)
    await signInControl(page).waitFor()
    const left = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('session') || key.includes('remote')))
    assertEqual(left, [], 'no session secret and no course notebooks are left in this browser')
    assertEqual((await made.samCtx.cookies()).length, 0, 'the session cookie is gone')

    // Forgotten password.
    await signInControl(page).click()
    await page.locator('dialog[open]').getByRole('button', { name: 'Forgot your password?' }).click()
    let link
    if (site.passwordReset) {
      await page.locator('dialog[open]').getByLabel('Email').fill(sam.email)
      await page.locator('dialog[open]').getByRole('button', { name: 'Send reset link' }).click()
      await page.locator('dialog[open] .form-status:not(:empty)').waitFor()
      assertIncludes(await page.locator('dialog[open] .form-status').innerText(), 'a reset link is on its way', 'the dialog confirms without saying whether the account exists')
      link = await site.resetLink(sam.email)
      await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click()
    } else {
      // No email binding: the dialog says whom to write to, and the owner makes a link with `npm run reset-link`.
      assertIncludes(await page.locator('dialog[open]').innerText(), 'Write to privacy@lab.test from the email address of your account', 'without email, the dialog names the contact')
      assertEqual(await page.locator('dialog[open]').getByRole('button', { name: 'Send reset link' }).count(), 0, 'and offers no button that cannot work')
      await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click()
      link = await site.resetLink(sam.email)
    }
    await page.goto(link)
    await page.getByLabel('New password').fill('a brand new password')
    assertEqual(new URL(page.url()).hash, '', 'the token does not stay in the address bar')
    await page.getByRole('button', { name: 'Set password and sign in' }).click()
    await page.waitForURL('**/courses')
    assertIncludes(await page.locator('.page-message').innerText(), 'Your password is changed', 'the page confirms')
    // The link works once.
    const again = await made.samCtx.newPage()
    await again.goto(link)
    await again.getByLabel('New password').fill('yet another password')
    await again.getByRole('button', { name: 'Set password and sign in' }).click()
    await again.locator('.form-error:not(:empty)').waitFor()
    assertIncludes(await again.locator('.form-error').innerText(), 'expired or was already used', 'a used link is refused')
    await again.close()

    // Change the password on the account page; the old one stops working.
    await page.goto(`${base}/account`)
    await page.getByLabel('Current password').fill('a brand new password')
    await page.getByLabel('New password').fill('the final password')
    await page.getByRole('button', { name: 'Change password' }).click()
    await page.waitForFunction(() => document.querySelector('.page-message')?.textContent.includes('Password changed'))
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL(`${base}/`)
    await signInControl(page).waitFor()
    await signIn(page, { email: sam.email, password: 'a brand new password' })
    await page.locator('dialog[open] .form-error:not(:empty)').waitFor()
    assertIncludes(await page.locator('dialog[open] .form-error').innerText(), 'do not match', 'the old password is refused')
    await page.locator('dialog[open]').getByLabel('Password').fill('the final password')
    await page.locator('dialog[open]').getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL('**/courses')

    // Delete the account: the page says exactly what goes, and asks for the password.
    await page.goto(`${base}/account`)
    await page.getByRole('button', { name: 'Delete my account' }).click()
    const dialog = page.locator('dialog[open]')
    assertIncludes(await dialog.innerText(), 'your name, your email address (sam@lab.test), your password and your sessions', 'the dialog lists the account')
    assertIncludes(await dialog.innerText(), 'No course work: you are not a student in any course.', 'and the course work (none: Sam left the course)')
    await dialog.getByLabel('Your password').fill('wrong password')
    await dialog.getByRole('button', { name: 'Delete my account' }).click()
    await dialog.locator('.form-error:not(:empty)').waitFor()
    await dialog.getByLabel('Your password').fill('the final password')
    await dialog.getByRole('button', { name: 'Delete my account' }).click()
    await page.waitForSelector('.cell')
    assertIncludes(await page.locator('.site-banner').innerText(), 'Your account and its data were deleted', 'the page confirms')
    await signIn(page, { email: sam.email, password: 'the final password' })
    await page.locator('dialog[open] .form-error:not(:empty)').waitFor()
    assertEqual(unexpected(problems, [/status of 40[013]/]), [], 'console problems (refused passwords are expected)')
    await made.samCtx.close()
    await made.attacker.ctx.close()
    await made.teacherCtx.close()
  })
}

/** A deployment without a database (a pull-request preview): the playground only, no sign-in. */
export function registerWithoutDatabase(suite, env) {
  suite.test('without a database the API answers 503 and the app is the playground only, with no sign-in button', async () => {
    const base = env.noDatabase.url
    const ctx = await env.browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await ctx.newPage()
    const problems = watch(page)
    const responses = []
    page.on('response', (response) => responses.push([new URL(response.url()).pathname, response.status()]))
    await page.goto(`${base}/playground`)
    await page.waitForSelector('.cell')
    await page.waitForFunction(() => document.title.startsWith('00-check-your-setup.ipynb'))
    await page.waitForLoadState('networkidle')
    assertEqual(responses.filter(([path]) => path.startsWith('/api/')), [['/api/config', 200]], 'the page asks the API one thing: what this deployment offers')
    assertEqual(await page.getByRole('button', { name: 'Sign in' }).count(), 0, 'no sign-in button that cannot work')
    assertEqual(await page.locator('.site-nav a').count(), 0, 'no course navigation')
    await runCell(page, 1)
    assertIncludes(await outputText(page, 1), 'emscripten', 'the playground works')
    await waitIdle(page)
    assertEqual(unexpected(problems), [], 'console problems')

    for (const [method, path] of [['GET', '/api/auth/session'], ['GET', '/api/courses'], ['POST', '/api/auth/register'], ['POST', '/api/auth/login'], ['GET', '/api/anything']]) {
      const response = await ctx.request.fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, data: method === 'GET' ? undefined : '{}' })
      assertEqual(response.status(), 503, `${method} ${path} without a database`)
      assertIncludes(response.headers()['content-type'], 'application/json', 'as JSON')
    }
    await page.goto(`${base}/courses`)
    await page.getByRole('heading', { name: 'Accounts are not available here' }).waitFor()
    await page.goto(`${base}/privacy`)
    await page.getByRole('heading', { name: 'Privacy' }).waitFor()
    assertIncludes(await page.locator('main').innerText(), 'This deployment has no accounts', 'the privacy page fits the deployment')
    assertIncludes(await page.locator('main').innerText(), 'NOT SET', 'and marks the missing data controller')
    await ctx.close()
  })
}
