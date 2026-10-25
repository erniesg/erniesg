import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/agent-evidence-publisher.yml', 'utf8')
const gitEnvironment = {
  PATH: process.env.PATH,
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
const proofRefspecs = [
  '              "+refs/remotes/origin/*:refs/remotes/origin/*",\n',
  '              "+refs/tags/*:refs/tags/*",\n',
]

function bindRepository(source, dependencyRoot, candidateGitDir, expectedHead) {
  const start = source.indexOf('          const candidateOrigin = ')
  const end = source.indexOf('          candidateRepositoryPath = sealCandidateReadableTree(', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const bind = new Function(
    'runTrustedGit', 'path', 'candidateDependencyRoot', 'candidateGitDir',
    'expectedHead', 'expectedRepository', 'executionRoot',
    `let candidateRepositoryPath;\n${source.slice(start, end)}\nreturn candidateRepositoryPath;`,
  )
  return bind(
    (args) => execFileSync('git', args, { env: gitEnvironment, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
    path, dependencyRoot, candidateGitDir, expectedHead, 'OWNER/fixture', dependencyRoot,
  )
}

describe('trusted evidence revalidation', () => {
  it('fetches canonical history without changing trusted checkout, event binding or credential persistence', () => {
    const checkout = workflow.slice(
      workflow.indexOf('      - name: Check out candidate through base PR ref'),
      workflow.indexOf('      - name: Set up Python'),
    )
    expect(checkout).toContain('repository: ${{ github.repository }}')
    expect(checkout).toContain('ref: refs/pull/${{ github.event.workflow_run.pull_requests[0].number }}/head')
    expect(checkout).toContain('fetch-depth: 0')
    expect(checkout).toContain('persist-credentials: false')
    expect(checkout).toContain('if [ "$actual_head" != "$EXPECTED_CANDIDATE_HEAD" ]; then')
    expect(workflow).toContain('ref: ${{ github.workflow_sha }}')
  })

  it('binds the exact candidate plus parents, nonancestor proof refs and tags, not arbitrary source Git configuration', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'revalidation-git-'))
    try {
      const repository = path.join(root, 'canonical.git')
      const git = (...args) => execFileSync('git', ['--git-dir', repository, ...args], {
        env: gitEnvironment, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      execFileSync('git', ['init', '--bare', repository], { env: gitEnvironment, stdio: 'pipe' })
      const tree = git('mktree')
      const parent = git('commit-tree', tree, '-m', 'parent')
      const head = git('commit-tree', tree, '-p', parent, '-m', 'candidate')
      const proof = git('commit-tree', tree, '-p', parent, '-m', 'independent proof')
      git('update-ref', 'refs/heads/main', head)
      git('symbolic-ref', 'HEAD', 'refs/heads/main')
      git('update-ref', 'refs/remotes/origin/main', head)
      git('update-ref', 'refs/remotes/origin/proof', proof)
      git('update-ref', 'refs/tags/proof', proof)
      git('update-ref', `refs/replace/${head}`, proof)
      git('config', 'alias.not-for-candidates', 'unrelated-source-config')
      expect(spawnSync('git', ['--git-dir', repository, 'merge-base', '--is-ancestor', proof, head], {
        env: gitEnvironment,
      }).status).toBe(1)
      const oldSource = proofRefspecs.reduce((text, refspec) => {
        expect(text.split(refspec)).toHaveLength(2)
        return text.replace(refspec, '')
      }, workflow)
      const oldBinding = bindRepository(oldSource, path.join(root, 'old'), repository, head)
      expect(spawnSync('git', ['--git-dir', oldBinding, 'cat-file', '-e', proof], {
        env: gitEnvironment,
      }).status).not.toBe(0)
      const binding = bindRepository(workflow, path.join(root, 'fixed'), repository, head)
      const bound = (...args) => execFileSync('git', ['--git-dir', binding, ...args], {
        env: gitEnvironment, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      expect(bound('rev-parse', 'HEAD')).toBe(head)
      expect(bound('rev-parse', 'HEAD^')).toBe(parent)
      expect(bound('rev-parse', 'refs/remotes/origin/proof')).toBe(proof)
      expect(bound('rev-parse', 'refs/tags/proof')).toBe(proof)
      expect(bound('cat-file', '-t', proof)).toBe('commit')
      expect(bound('for-each-ref', '--format=%(refname)', 'refs/replace')).toBe('')
      expect(bound('config', 'remote.origin.url')).toBe('https://github.com/OWNER/fixture.git')
      expect(spawnSync('git', ['--git-dir', binding, 'config', '--get', 'alias.not-for-candidates'], {
        env: gitEnvironment,
      }).status).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reaps adopted children during execution without swallowing command failure, signals or deadlines', () => {
    const python = workflow.split("<<'RUCKSACK_CANDIDATE_RUNNER_PY'\n")[1]
      .split('\n          RUCKSACK_CANDIDATE_RUNNER_PY')[0]
    execFileSync('python3', ['-I', '-B', '-c', `
import ast, ctypes, os, subprocess, sys, textwrap, time
source = ast.parse(textwrap.dedent(sys.stdin.read()))
selected = {'become_child_subreaper', 'reap_orphans', 'wait_and_reap_candidate'}
nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in selected]
assert len(nodes) == len(selected)
namespace = dict(ctypes=ctypes, os=os, subprocess=subprocess, time=time,
                 refuse=lambda message: (_ for _ in ()).throw(RuntimeError(message)))
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<actual-candidate-runner>', 'exec'), namespace)
namespace['become_child_subreaper']()
command = '''
import os, sys, time
reader, writer = os.pipe()
intermediate = os.fork()
if intermediate == 0:
    os.close(reader)
    grandchild = os.fork()
    if grandchild == 0:
        os._exit(0)
    os.write(writer, str(grandchild).encode())
    os.close(writer)
    os._exit(0)
os.close(writer)
grandchild = int(os.read(reader, 32))
os.close(reader)
os.waitpid(intermediate, 0)
deadline = time.monotonic() + 1
while True:
    try:
        os.kill(grandchild, 0)
    except ProcessLookupError:
        sys.exit(23)
    if time.monotonic() >= deadline:
        sys.exit(71)
    time.sleep(0.01)
'''
def launch(code):
    return subprocess.Popen([sys.executable, '-I', '-B', '-c', code],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
old = launch(command)
assert old.wait(timeout=4) == 71, 'old wait should retain the adopted zombie'
namespace['reap_orphans']()
fixed = launch(command)
assert namespace['wait_and_reap_candidate'](fixed, 4) == 23
for code, expected in [('raise SystemExit(37)', 37),
                       ('import os, signal; os.kill(os.getpid(), signal.SIGTERM)', -15)]:
    child = launch(code)
    assert namespace['wait_and_reap_candidate'](child, 4) == expected
child = launch('import time; time.sleep(30)')
try:
    try:
        namespace['wait_and_reap_candidate'](child, 0.05)
    except subprocess.TimeoutExpired:
        pass
    else:
        raise AssertionError('candidate deadline was ignored')
finally:
    child.kill()
    child.wait(timeout=4)
    namespace['reap_orphans']()
`], { input: python, stdio: ['pipe', 'pipe', 'pipe'], timeout: 12_000 })
  })

  it('fits native Unix sockets at both run-ID bounds without moving the original cleanup lease', () => {
    const parent = workflow.match(/readonly execution_parent="([^"]+)"/)[1]
    const template = workflow.match(/isolation_template="([^"]+)"/)[1]
    const maximum = template
      .replace('$execution_parent', parent)
      .replace('${GITHUB_RUN_ID}', '9'.repeat(20))
      .replace('${GITHUB_RUN_ATTEMPT}', '9'.repeat(6))
      .replace('X'.repeat(12), 'a'.repeat(12)) + '/home/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket'
    expect(Buffer.byteLength(maximum)).toBeLessThanOrEqual(107)
    execFileSync('python3', ['-I', '-B', '-c', `
import os, shutil, socket, tempfile
root = tempfile.mkdtemp(prefix='rsk-unix-')
try:
    directory = root + '/' + 'd' * (107 - len(root) - 3)
    os.mkdir(directory)
    with socket.socket(socket.AF_UNIX) as sock:
        sock.bind(directory + '/s')
    try:
        with socket.socket(socket.AF_UNIX) as sock:
            sock.bind(directory + '/ss')
    except OSError:
        pass
    else:
        raise AssertionError('108-byte Unix socket unexpectedly accepted')
finally:
    shutil.rmtree(root)
`], { stdio: 'pipe' })
    expect(workflow).toContain('readonly isolation_parent="/var/lib/rucksack-revalidator"')
    expect(workflow).toContain('isolation_lock="$isolation_parent/.publisher-cleanup.lock"')
    expect(workflow.indexOf('"$RUCKSACK_TRUSTED_FLOCK" -n 9')).toBeLessThan(
      workflow.indexOf('cleanup_stale_isolation_roots "$isolation_parent"'),
    )
    expect(workflow).toContain('cleanup_stale_isolation_roots "$execution_parent"')
    expect(workflow).toContain('validate_isolation_ancestor 755 "$execution_parent"')
    expect(workflow).toContain('"$execution_parent/$cleanup_isolation_name"')
    expect(workflow).toContain('"$execution_parent/$isolation_name"')
    expect(workflow).toContain('cleanup_isolation_prefix="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-"')
    expect(workflow).toContain('isolation_prefix="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-"')
  })
})
