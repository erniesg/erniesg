import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const servicePath = new URL(
  '../infra/vm/systemd/erniesg-struct-typeset-queue.service',
  import.meta.url,
)
const service = readFileSync(servicePath, 'utf8')

describe('STRUCT queue pulse contract', () => {
  it('does not start another drain while a repository worker is active', () => {
    const workerGuard = service.indexOf(
      'session_marker=rucksack-erniesg-erniesg-issue',
    )
    const workerProbe = service.indexOf('pgrep -af "tmux -L"')
    const drainStart = service.indexOf('systemctl --user start --wait "$target"')

    expect(workerGuard).toBeGreaterThan(-1)
    expect(workerProbe).toBeGreaterThan(workerGuard)
    expect(drainStart).toBeGreaterThan(workerProbe)
  })

  it('keeps the operator hold and active-drain checks ahead of dispatch', () => {
    const holdCheck = service.indexOf('if [ -e "$hold" ]')
    const activeDrainCheck = service.indexOf('active|activating')
    const drainStart = service.indexOf('systemctl --user start --wait "$target"')

    expect(holdCheck).toBeGreaterThan(-1)
    expect(activeDrainCheck).toBeGreaterThan(holdCheck)
    expect(drainStart).toBeGreaterThan(activeDrainCheck)
  })
})
