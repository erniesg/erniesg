#!/usr/bin/env python3
"""Root administrator installation and verification of the reviewed VM runner.

Installation is separate from content publishing. Publishing calls only verify.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import tempfile

ROOT = pathlib.Path('/opt/erniesg-translation-publisher/v1')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def secure(path, directory=False):
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or path.resolve() != path:
        raise ValueError(f'Untrusted runner ownership or path: {path}')
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError(f'Unexpected runner entry type: {path}')


def inventory(root):
    return {str(path.relative_to(root)): digest(path)
            for path in sorted(root.rglob('*')) if path.is_file()}


def verify(root=ROOT, expected_hashes=None):
    for component in reversed([root, *root.parents]):
        secure(component, directory=True)
    secure(root / 'manifest.json')
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest.get('version') != 1 or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('reviewedCommit', '')):
        raise ValueError('Invalid runner release identity')
    expected = manifest['files']
    for entry in root.rglob('*'):
        secure(entry, directory=entry.is_dir())
    actual = inventory(root)
    actual.pop('manifest.json', None)
    if actual != expected:
        raise ValueError('Pinned runner content does not match its immutable manifest')
    source_manifest = json.loads((root / 'source-manifest.json').read_text())
    if source_manifest.get('reviewedCommit') != manifest['reviewedCommit']:
        raise ValueError('Runner source and installed release identities differ')
    source_files = source_manifest['files']
    if expected_hashes is not None and source_files != expected_hashes:
        raise ValueError('Installed runner differs from the reviewed publisher code')
    if any(actual.get(name) != value for name, value in source_files.items()):
        raise ValueError('Installed source files differ from their reviewed hashes')
    return manifest['reviewedCommit']


def install(source, commit):
    if os.geteuid() != 0:
        raise ValueError('Only a root administrator can install the reviewed runner')
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Provide the immutable reviewed commit SHA')
    if ROOT.exists():
        if verify() != commit:
            raise ValueError('An immutable runner already exists; use a new version')
        return
    source_manifest = json.loads((source / 'source-manifest.json').read_text())
    actual = inventory(source)
    actual.pop('source-manifest.json', None)
    if actual != source_manifest['files'] or source_manifest['reviewedCommit'] != commit:
        raise ValueError('Reviewed source bundle changed before installation')
    ROOT.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(prefix='.install-', dir=ROOT.parent))
    try:
        for relative in source_manifest['files']:
            if pathlib.PurePosixPath(relative).is_absolute() or '..' in pathlib.PurePosixPath(relative).parts:
                raise ValueError('Unsafe source bundle path')
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)
        shutil.copyfile(source / 'source-manifest.json', staging / 'source-manifest.json')
        # Public, version-pinned dependencies. No package lifecycle code runs.
        subprocess.run([
            '/usr/bin/node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'ci',
            '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev',
        ], cwd=staging, check=True, env={
            'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
        })
        # npm creates bin links; these tools are not used by this runtime.
        for entry in staging.rglob('*'):
            if entry.is_symlink():
                entry.unlink()
        for entry in [staging, *staging.rglob('*')]:
            os.chown(entry, 0, 0)
            os.chmod(entry, 0o755 if entry.is_dir() else 0o644)
        manifest = {'version': 1, 'reviewedCommit': commit, 'files': inventory(staging)}
        (staging / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True) + '\n')
        os.chmod(staging / 'manifest.json', 0o644)
        os.rename(staging, ROOT)
        verify()
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['verify', 'install'])
    parser.add_argument('--source', type=pathlib.Path)
    parser.add_argument('--commit')
    parser.add_argument('--expected-hashes')
    args = parser.parse_args()
    if args.command == 'install':
        if not args.source or not args.commit:
            raise ValueError('Install requires an approved source bundle and commit')
        install(args.source.resolve(), args.commit)
    expected_hashes = None
    if args.expected_hashes:
        expected_hashes = json.loads(base64.b64decode(args.expected_hashes, validate=True))
        if not isinstance(expected_hashes, dict) or not expected_hashes or any(
            not isinstance(name, str) or not isinstance(value, str)
            or not re.fullmatch(r'[0-9a-f]{64}', value)
            or pathlib.PurePosixPath(name).is_absolute()
            or '..' in pathlib.PurePosixPath(name).parts
            for name, value in expected_hashes.items()
        ):
            raise ValueError('Invalid reviewed runner source hashes')
    print('Verified pinned translation runner:', verify(expected_hashes=expected_hashes))


if __name__ == '__main__':
    main()
