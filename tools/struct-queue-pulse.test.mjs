import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const servicePath = new URL(
  '../infra/vm/systemd/erniesg-struct-typeset-queue.service',
  import.meta.url,
)
const service = readFileSync(servicePath, 'utf8')

describe('STRUCT queue pulse contract', () => {
  it('does not start another drain while any VM issue worker is active', () => {
    const workerGuard = service.indexOf('issue_marker=-issue-')
    const workerProbe = service.indexOf('pgrep -af "[t]mux -L"')
    const drainStart = service.indexOf('systemctl --user start --wait "$target"')

    expect(workerGuard).toBeGreaterThan(-1)
    expect(workerProbe).toBeGreaterThan(workerGuard)
    expect(drainStart).toBeGreaterThan(workerProbe)
  })

  it('does not leave shell-variable expansion for systemd to consume', () => {
    expect(service).not.toContain('${session_marker}')
    expect(service).not.toContain('session_marker=rucksack-erniesg-erniesg')
    expect(service).toContain('issue_marker=-issue-')
  })

  it('excludes the pulse shell itself from the tmux process probe', () => {
    expect(service).not.toContain('pgrep -af "tmux -L"')
    expect(service).toContain('pgrep -af "[t]mux -L"')
  })

  it('waits for direct Codex workers outside tmux', () => {
    const directWorkerProbe = service.indexOf(
      'pgrep -af "[/]codex .* exec "',
    )
    const drainStart = service.indexOf('systemctl --user start --wait "$target"')

    expect(directWorkerProbe).toBeGreaterThan(-1)
    expect(drainStart).toBeGreaterThan(directWorkerProbe)
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
