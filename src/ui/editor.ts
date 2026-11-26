/** A CodeMirror 6 editor for one cell: Python highlighting for code, plain wrapped text for Markdown. */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { drawSelection, EditorView, highlightSpecialChars, keymap, placeholder } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'

export interface EditorOptions {
  doc: string
  language: 'python' | 'markdown'
  label: string
  onChange(doc: string): void
  /** Shift+Enter (advance = true) and Ctrl/Cmd+Enter (advance = false). */
  onRun(advance: boolean): void
  /** Escape: leave the editor, so that Tab moves through the page again. */
  onEscape(): void
}

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorView {
  const run = (advance: boolean) => () => {
    options.onRun(advance)
    return true
  }
  const extensions = [
    Prec.highest(
      keymap.of([
        { key: 'Shift-Enter', run: run(true) },
        { key: 'Mod-Enter', run: run(false) },
        {
          key: 'Escape',
          run: () => {
            options.onEscape()
            return true
          },
        },
      ]),
    ),
    history(),
    drawSelection(),
    highlightSpecialChars(),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.contentAttributes.of({
      'aria-label': options.label,
      'aria-description': 'Shift+Enter runs the cell. Escape leaves the editor.',
      spellcheck: options.language === 'markdown' ? 'true' : 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    }),
    // Typing over a selection that spans several lines. Normally CodeMirror lets the browser change
    // the page and reads the result back; in the Chromium used for the end-to-end tests that left
    // an empty line behind (also in a bare CodeMirror editor). Replacing the selection ourselves
    // gives the same result in every browser. Composed input (IME) is left to the browser.
    EditorView.domEventHandlers({
      beforeinput(event, view) {
        if (event.inputType !== 'insertText' || event.data == null || view.composing) return false
        const { from, to, empty } = view.state.selection.main
        if (empty || view.state.selection.ranges.length > 1) return false
        if (view.state.doc.lineAt(from).number === view.state.doc.lineAt(to).number) return false
        event.preventDefault()
        view.dispatch(view.state.update(view.state.replaceSelection(event.data), { userEvent: 'input.type', scrollIntoView: true }))
        return true
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString())
    }),
  ]
  if (options.language === 'python') {
    extensions.push(python(), syntaxHighlighting(classHighlighter), bracketMatching(), indentOnInput())
  } else {
    extensions.push(EditorView.lineWrapping, placeholder('Write Markdown here. $x^2$ is a formula.'))
  }
  return new EditorView({ parent, state: EditorState.create({ doc: options.doc, extensions }) })
}
