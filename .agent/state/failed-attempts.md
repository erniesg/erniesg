# Failed Attempts

## 2026-08-01: multiline transient watcher over SSH

- Attempt: pass a multiline PR-watcher shell program directly through SSH to
  `systemd-run ... /bin/sh -lc`.
- Failure: remote argument quoting collapsed the command to `set`; the shell
  printed its inherited environment into the private VM user journal. One
  Claude Code OAuth credential was included. The unit did not perform its
  intended watch.
- Containment: removed the credential from the user systemd manager
  environment, ran Claude logout, moved the persistent
  `~/.config/claude-token.env` source into a mode-`0600` quarantine outside
  active configuration, replaced all watchers with file-backed scripts plus
  `UnsetEnvironment=`, and made the #88 hold persistent. No Codex worker or
  repository process received the credential from this watcher.
- Remaining action: rotate and re-authenticate the VM Claude Code OAuth
  credential. Do not reuse the exposed value.
- Rule: never pass multiline watcher programs through nested SSH/systemd shell
  quoting. Install a validated file-backed script and unit, explicitly clear
  provider/GitHub secrets, and inspect only bounded service properties rather
  than journald output.
