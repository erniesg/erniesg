import { describe, expect, it } from 'vitest'

import { createDebuggerModel } from './debugger.mjs'

describe('the chapter 9 debugger model', () => {
  it('shows the broken loop, can step into the call, and continues to the real wrong total', () => {
    const debuggerModel = createDebuggerModel()

    expect(debuggerModel.getState()).toMatchObject({ line: 11, frame: 'total_between', done: false })
    debuggerModel.command('p first_day, last_day')
    expect(debuggerModel.getState().output.at(-1)).toBe('(3, 7)')

    debuggerModel.command('n')
    expect(debuggerModel.getState()).toMatchObject({ line: 12, frame: 'total_between', day: 3, total: 0 })
    debuggerModel.command('s')
    expect(debuggerModel.getState()).toMatchObject({ line: 6, frame: 'steps_on', day: 3 })
    expect(debuggerModel.getState().output).toContain('--Call--')

    debuggerModel.command('c')
    expect(debuggerModel.getState()).toMatchObject({ done: true, total: 22985 })
    expect(debuggerModel.getState().output.at(-1)).toBe('22985')
  })

  it('only evaluates the small documented expression set and never crashes on a typo', () => {
    const debuggerModel = createDebuggerModel()

    debuggerModel.command('p readings[day]')
    expect(debuggerModel.getState().output.at(-1)).toBe('NameError: day is not set yet')
    debuggerModel.command('wat')
    expect(debuggerModel.getState().output.at(-1)).toContain('Try n, s, c, p, l, q')
    debuggerModel.command('')
    expect(debuggerModel.getState().output.at(-1)).toContain('Try n, s, c, p, l, q')
  })

  it('keeps local names in their own function and returns from a stepped-in call', () => {
    const debuggerModel = createDebuggerModel()
    debuggerModel.command('n')
    debuggerModel.command('s')
    debuggerModel.command('p total')
    expect(debuggerModel.getState().output.at(-1)).toContain("NameError: name 'total' is not defined")
    expect(debuggerModel.getState().output.at(-1)).toContain('Try day, readings[day], or len(readings).')
    debuggerModel.command('p readings[day]')
    expect(debuggerModel.getState().output.at(-1)).toBe("'6610'")

    debuggerModel.command('n')
    debuggerModel.command('n')
    expect(debuggerModel.getState()).toMatchObject({ line: 7, frame: 'steps_on', returnPhase: 'helper', total: 0 })
    expect(debuggerModel.getState().output.slice(-2)).toEqual(['--Return--', '6610'])
    debuggerModel.command('n')
    expect(debuggerModel.getState()).toMatchObject({ line: 11, frame: 'total_between', day: 3, total: 6610 })
  })

  it('next runs every broken loop turn before it returns the known wrong answer', () => {
    const debuggerModel = createDebuggerModel()
    for (let index = 0; index < 9; index += 1) debuggerModel.command('n')
    expect(debuggerModel.getState()).toMatchObject({ line: 13, total: 22985, done: false })
    debuggerModel.command('n')
    expect(debuggerModel.getState()).toMatchObject({ line: 13, returnPhase: 'main', done: false })
    expect(debuggerModel.getState().output.slice(-2)).toEqual(['--Return--', '22985'])
    debuggerModel.command('n')
    expect(debuggerModel.getState()).toMatchObject({ done: true, total: 22985 })
    expect(debuggerModel.getState().output.at(-1)).toBe('22985')
  })

  it('resets a quit session and bounds the console history', () => {
    const debuggerModel = createDebuggerModel()
    debuggerModel.command('q')
    expect(debuggerModel.getState()).toMatchObject({ done: true, status: 'Debugger stopped. Reset to try again.' })
    debuggerModel.reset()
    expect(debuggerModel.getState()).toMatchObject({ line: 11, done: false, output: [] })
    for (let index = 0; index < 120; index += 1) debuggerModel.command('l')
    expect(debuggerModel.getState().output.length).toBeLessThanOrEqual(100)
  })
})
