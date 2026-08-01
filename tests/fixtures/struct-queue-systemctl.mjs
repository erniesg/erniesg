#!/usr/bin/env node

import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
appendFileSync(
  process.env.STRUCT_QUEUE_FAKE_SYSTEMCTL_CALLS,
  `${JSON.stringify(args)}\n`,
)

const command = args[1]
const unit = args[2]
const state = process.env.STRUCT_QUEUE_FAKE_SYSTEMCTL_STATE ?? 'healthy'

if (command === 'list-timers') {
  if (state === 'masked-timer') {
    process.stdout.write(
      'n/a n/a n/a n/a erniesg-struct-typeset-queue.timer erniesg-struct-typeset-queue.service\n',
    )
  } else {
    process.stdout.write(
      'Sat 2026-08-01 12:30:00 UTC 25min Sat 2026-08-01 12:00:00 UTC 5min ago erniesg-struct-typeset-queue.timer erniesg-struct-typeset-queue.service\n',
    )
  }
  process.exit(0)
}

if (command === 'show' && unit === 'erniesg-struct-typeset-queue.timer') {
  if (state === 'masked-timer') {
    process.stdout.write(
      'LoadState=masked\nUnitFileState=masked\nActiveState=inactive\nSubState=dead\n',
    )
  } else {
    process.stdout.write(
      'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nSubState=waiting\n',
    )
  }
  process.exit(0)
}

if (command === 'show' && unit === 'erniesg-struct-typeset-queue.service') {
  process.stdout.write('TimeoutStartUSec=30min\nTimeoutStopUSec=5min\n')
  process.exit(0)
}

if (command === 'show' && unit?.endsWith('-drain.service')) {
  process.stdout.write(
    'LoadState=loaded\nActiveState=inactive\nSubState=dead\n',
  )
  process.exit(0)
}

if (command === 'start') process.exit(0)

process.stderr.write(`unexpected fake systemctl call: ${args.join(' ')}\n`)
process.exit(1)
