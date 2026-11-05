/**
 * A deliberately small, safe simulation of the chapter 9 pdb example. It is
 * not a Python interpreter: the few expressions below are the ones readers
 * meet in the chapter, and every program state is known ahead of time.
 */

const SOURCE = [
  'readings = [',
  '    "3120", "4890", "2075", "6610", "5240",',
  '    "3980", "7155", "4400", "2990", "5105",',
  ']',
  '',
  'def steps_on(day):',
  '    return int(readings[day])',
  '',
  'def total_between(first_day, last_day):',
  '    total = 0',
  '    for day in range(first_day, last_day):',
  '        total += steps_on(day)',
  '    return total',
  '',
  'print(total_between(3, 7))',
]

const NOTES = {
  6: 'This helper looks up one day’s reading.',
  7: 'It turns that reading into a number and returns it.',
  9: 'The main function receives the first and last days.',
  10: 'The running total starts at zero.',
  11: 'The loop stops before the last number. That is the bug.',
  12: 'This adds the current day’s reading to the total.',
  13: 'This sends the finished total back.',
  15: 'This prints the answer from the function.',
}

const READINGS = [3120, 4890, 2075, 6610, 5240, 3980, 7155, 4400, 2990, 5105]
const MAX_OUTPUT_LINES = 100

const freshState = () => ({
  line: 11,
  frame: 'total_between',
  day: undefined,
  total: 0,
  returnPhase: null,
  done: false,
  status: 'Stopped at the loop. Look around, then move one line at a time.',
  output: [],
  lastCommand: '',
})

const listLines = line => SOURCE.map((source, index) => {
  const number = index + 1
  return `${number === line ? '->' : '  '} ${String(number).padStart(2)}  ${source}`
})

/** Returns a simulation model for tests and for the page wiring below. */
export function createDebuggerModel() {
  let state = freshState()

  const append = (...lines) => {
    state.output.push(...lines)
    if (state.output.length > MAX_OUTPUT_LINES) state.output.splice(0, state.output.length - MAX_OUTPUT_LINES)
  }

  const finish = () => {
    // Continue runs every remaining loop turn. The broken range covers days
    // 3, 4, 5 and 6 only: 6610 + 5240 + 3980 + 7155.
    state.total = 22985
    state.done = true
    state.line = null
    state.frame = 'finished'
    state.status = 'The program finished. It skipped day 7, worth 4400.'
    append('22985')
  }

  const valueFor = expression => {
    const expressionText = expression.trim()
    const dayExists = Number.isInteger(state.day)
    const helperFrame = state.frame === 'steps_on'
    const helperHelp = 'Try day, readings[day], or len(readings).'
    const outerName = /\btotal\b/.test(expressionText) ? 'total'
      : expressionText.includes('first_day') ? 'first_day'
        : expressionText.includes('last_day') ? 'last_day' : null
    if (helperFrame && outerName) return `NameError: name '${outerName}' is not defined. ${helperHelp}`
    const values = {
      first_day: '3',
      last_day: '7',
      'first_day, last_day': '(3, 7)',
      total: String(state.total),
      'len(readings)': String(READINGS.length),
    }
    if (Object.hasOwn(values, expressionText)) return values[expressionText]
    if (expressionText === 'day') return dayExists ? String(state.day) : 'NameError: day is not set yet'
    if (expressionText === 'readings[day]') return dayExists ? `'${READINGS[state.day]}'` : 'NameError: day is not set yet'
    if (expressionText === 'total + steps_on(day)') {
      return dayExists ? String(state.total + READINGS[state.day]) : 'NameError: day is not set yet'
    }
    return helperFrame
      ? helperHelp
      : 'Try day, total, readings[day], len(readings), first_day, last_day, or total + steps_on(day).'
  }

  const next = () => {
    if (state.frame === 'steps_on') {
      if (state.returnPhase === 'helper') {
        state.returnPhase = null
        state.frame = 'total_between'
        state.line = 11
        state.total += READINGS[state.day]
        state.status = `Day ${state.day} added ${READINGS[state.day]}. The loop will check the next day.`
        return
      }
      if (state.line === 6) {
        state.line = 7
        state.status = 'The helper will return this day’s reading.'
      } else {
        state.returnPhase = 'helper'
        state.status = `steps_on is returning ${READINGS[state.day]}. Press Next to go back to the loop.`
        append('--Return--', String(READINGS[state.day]))
      }
      return
    }
    if (state.returnPhase === 'main') {
      state.returnPhase = null
      finish()
      return
    }
    if (state.line === 11) {
      if (state.day === undefined) state.day = 3
      else if (state.day < 6) state.day += 1
      else {
        state.line = 13
        state.status = 'The loop is over. Day 7 was never included.'
        return
      }
      state.line = 12
      state.status = `The loop chose day ${state.day}. It is about to add that reading.`
      return
    }
    if (state.line === 12) {
      state.total += READINGS[state.day]
      state.line = 11
      state.status = `Day ${state.day} added ${READINGS[state.day]}. The loop will check the next day.`
      return
    }
    if (state.line === 13) {
      state.returnPhase = 'main'
      state.status = 'total_between is returning 22985. Press Next to finish the program.'
      append('--Return--', '22985')
    }
  }

  const command = rawCommand => {
    let commandText = String(rawCommand || '').trim()
    if (!commandText) commandText = state.lastCommand
    if (!commandText) {
      append('Try n, s, c, p, l, q, or Reset.')
      return getState()
    }
    if (state.done) {
      append('This demo has finished. Reset to start again.')
      return getState()
    }
    state.lastCommand = commandText
    append(`(Pdb) ${commandText}`)
    if (commandText === 'n') next()
    else if (commandText === 's') {
      if (state.frame === 'total_between' && state.line === 12) {
        state.frame = 'steps_on'
        state.line = 6
        state.status = 'You stepped into steps_on for day ' + state.day + '.'
        append('--Call--')
      } else next()
    } else if (commandText === 'c') finish()
    else if (commandText === 'l') append(...listLines(state.line))
    else if (commandText === 'q') {
      state.done = true
      state.line = null
      state.frame = 'finished'
      state.status = 'Debugger stopped. Reset to try again.'
    } else if (commandText === 'p') append('Type an expression after p, for example: p day')
    else if (commandText.startsWith('p ')) append(valueFor(commandText.slice(2)))
    else append('Try n, s, c, p, l, q, or Reset.')
    return getState()
  }

  const reset = () => { state = freshState(); return getState() }
  const getState = () => ({ ...state, output: [...state.output] })
  return { command, getState, reset }
}

const element = (document, name, className, text) => {
  const node = document.createElement(name)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function wireOne(section) {
  if (section.dataset.pdbWired) return null
  section.dataset.pdbWired = '1'
  const document = section.ownerDocument
  const code = section.querySelector('[data-pdb-code]')
  const controls = section.querySelector('[data-pdb-controls]')
  const form = section.querySelector('form[data-pdb-command-form]')
  const input = form?.querySelector('[data-pdb-command]')
  const output = section.querySelector('pre[data-pdb-output]')
  const status = section.querySelector('p[data-pdb-status]')
  const resetButton = section.querySelector('button[data-pdb-reset]')
  if (!code || !controls || !form || !input || !output || !status || !resetButton) return null

  const debuggerModel = createDebuggerModel()
  const lineButtons = new Map()
  let shownNote = null
  let pinnedNote = null
  const showNote = note => {
    if (shownNote && shownNote !== note) shownNote.hidden = true
    shownNote = note
    if (note) note.hidden = false
  }

  SOURCE.forEach((source, index) => {
    const line = index + 1
    const row = element(document, 'div', 'pdb-code-line')
    const button = element(document, 'button', 'pdb-code-button', `${String(line).padStart(2)}  ${source || ' '}`)
    button.type = 'button'
    const note = NOTES[line]
    if (note) {
      button.title = note
      button.setAttribute('aria-label', `Line ${line}: ${source}. ${note}`)
      const annotation = element(document, 'span', 'pdb-line-note', note)
      annotation.hidden = true
      button.addEventListener('focus', () => { if (!pinnedNote) showNote(annotation) })
      button.addEventListener('blur', () => {
        if (!pinnedNote && shownNote === annotation) showNote(null)
      })
      button.addEventListener('mouseenter', () => { if (!pinnedNote) showNote(annotation) })
      button.addEventListener('mouseleave', () => {
        if (!pinnedNote && shownNote === annotation) showNote(null)
      })
      button.addEventListener('click', () => {
        if (pinnedNote === annotation) {
          pinnedNote = null
          showNote(null)
        } else {
          pinnedNote = annotation
          showNote(annotation)
        }
      })
      row.append(button, annotation)
    } else row.append(button)
    lineButtons.set(line, button)
    code.append(row)
  })

  code.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !pinnedNote) return
    event.preventDefault()
    pinnedNote = null
    showNote(null)
  })

  for (const [command, label] of [['n', 'Next'], ['s', 'Step in'], ['c', 'Continue'], ['p', 'Inspect'], ['l', 'List'], ['q', 'Quit']]) {
    const button = element(document, 'button', 'pdb-command-button', `${command} — ${label}`)
    button.type = 'button'
    button.dataset.pdbQuickCommand = command
    button.addEventListener('click', () => {
      if (command === 'p') {
        input.value = 'p '
        input.focus()
      } else run(command)
    })
    controls.append(button)
  }

  const paint = state => {
    output.textContent = state.output.join('\n')
    status.textContent = state.status
    lineButtons.forEach((button, line) => {
      const current = line === state.line
      button.classList.toggle('is-current', current)
      if (current) button.setAttribute('aria-current', 'step')
      else button.removeAttribute('aria-current')
    })
    input.disabled = state.done
    form.querySelector('button[type="submit"]')?.toggleAttribute('disabled', state.done)
    controls.querySelectorAll('button').forEach(button => { button.disabled = state.done })
  }
  const run = command => paint(debuggerModel.command(command))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const command = input.value
    input.value = ''
    run(command)
  })
  resetButton.addEventListener('click', () => {
    paint(debuggerModel.reset())
    input.focus()
  })
  paint(debuggerModel.getState())
  return { model: debuggerModel, section }
}

/** Wires every interactive debugger placed by the chapter renderer. */
export function wireDebugger(root = document) {
  return [...root.querySelectorAll('[data-pdb-demo]')].map(wireOne).filter(Boolean)
}

export { READINGS, SOURCE }
