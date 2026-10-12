#!/usr/bin/env python3
"""Private POSIX filesystem RPC for the trusted translation publisher.

Every lookup is relative to an O_NOFOLLOW directory descriptor. Replacement is
journaled quarantine + validation + link(2) (which never replaces an entry).
No shell, third-party modules, network access, or credential access is used.
"""
import base64
import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import uuid

ROOT = os.path.realpath(sys.argv[1])
ROOT_FD = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
GUARD = None
HANDLES = {}
PENDING = {}


def parts(value):
    relative = os.path.relpath(value, ROOT) if os.path.isabs(value) else value
    if relative == '.':
        return []
    result = relative.split('/')
    if any(p in ('', '.', '..') for p in result):
        raise ValueError('Unsafe publisher filesystem path')
    return result


def directory(value):
    fd = os.dup(ROOT_FD)
    try:
        for component in parts(value):
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise


def parent(value):
    components = parts(value)
    if not components:
        raise ValueError('Root is not a publication artifact')
    return directory('/'.join(components[:-1]) or '.'), components[-1]


def read_at(fd, name):
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        if not stat.S_ISREG(os.fstat(handle).st_mode):
            raise ValueError('Publisher artifact is not a regular file')
        chunks = []
        while True:
            chunk = os.read(handle, 1024 * 1024)
            if not chunk:
                return b''.join(chunks)
            chunks.append(chunk)
    finally:
        os.close(handle)


def digest_at(fd, name):
    try:
        return hashlib.sha256(read_at(fd, name)).hexdigest()
    except FileNotFoundError:
        return None


def write_at(fd, name, data, exclusive=True):
    handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW |
                     (os.O_EXCL if exclusive else os.O_TRUNC), 0o600, dir_fd=fd)
    try:
        with os.fdopen(os.dup(handle), 'wb') as stream:
            stream.write(data)
            stream.flush()
        os.fsync(handle)
    finally:
        os.close(handle)


def save_intent(fd, name, intent):
    temporary = name + '.next'
    write_at(fd, temporary, json.dumps(intent, separators=(',', ':')).encode())
    os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)


def restore_quarantine(active, target, basename, intent):
    # Never remove a concurrently created pathname, even if its bytes match.
    os.link(intent['quarantine'], basename, src_dir_fd=active, dst_dir_fd=target,
            follow_symlinks=False)
    os.fsync(target)


def parent_identity(fd):
    state = os.fstat(fd)
    return dict(dev=state.st_dev, ino=state.st_ino)


def parent_matches(intent):
    try:
        current, _ = parent(intent['relative'])
        try:
            return parent_identity(current) == intent['parentIdentity']
        finally:
            os.close(current)
    except (OSError, ValueError):
        return False


def preserve_parent_conflict(target, basename, active, name, intent):
    # Record the conflict before attempting restitution. Recovery must never
    # infer success from a new directory that happens to contain the old bytes.
    intent['phase'] = 'conflict'
    save_intent(active, name, intent)
    current = digest_at(target, basename)
    if current is not None and intent['replacement'] is not None:
        candidate = os.stat(basename, dir_fd=target, follow_symlinks=False)
        replacement = os.stat(intent['temporary'], dir_fd=active, follow_symlinks=False)
        if (candidate.st_dev, candidate.st_ino) == (replacement.st_dev, replacement.st_ino):
            # Quarantine then verify the exact entry; the preliminary inode
            # check alone does not justify deleting or overwriting a pathname.
            os.rename(basename, intent['conflictFile'], src_dir_fd=target, dst_dir_fd=active)
            os.fsync(target)
            os.fsync(active)
            displaced = os.stat(intent['conflictFile'], dir_fd=active, follow_symlinks=False)
            if ((displaced.st_dev, displaced.st_ino) != (replacement.st_dev, replacement.st_ino) or
                    digest_at(active, intent['conflictFile']) != intent['replacement']):
                try:
                    os.link(intent['conflictFile'], basename, src_dir_fd=active,
                            dst_dir_fd=target, follow_symlinks=False)
                    os.fsync(target)
                except FileExistsError:
                    pass
                return
    if intent['expected'] is not None and digest_at(active, intent['quarantine']) == intent['expected']:
        try:
            restore_quarantine(active, target, basename, intent)
        except FileExistsError:
            pass


def check_parent(target, basename, active, name, intent):
    if parent_identity(target) != intent['parentIdentity'] or not parent_matches(intent):
        preserve_parent_conflict(target, basename, active, name, intent)
        raise ValueError('Publisher unsafe parent changed; conflict evidence preserved')


def validate_target(relative):
    if not (relative in ('.translation/manifest.json', '.translation/pages.json') or
            re.fullmatch(r'\.translation/reports/[A-Za-z0-9._-]+\.json', relative) or
            re.fullmatch(r'src/content/blog/(?:[A-Za-z0-9._-]+/)*(?:zh|ja|ko)\.mdx', relative)):
        raise ValueError('Not a permitted publication artifact')
    parts(relative)


def validate_intent(name, intent):
    match = re.fullmatch(r'operation-([0-9a-f]{32})\.json', name)
    if not match or not isinstance(intent, dict):
        raise ValueError('Invalid publisher operation journal')
    token = match.group(1)
    validate_target(intent['relative'])
    if (intent['quarantine'] != 'displaced-' + token + '.bin' or
            intent['temporary'] != 'replacement-' + token + '.bin' or
            intent['conflictFile'] != 'conflict-' + token + '.bin' or
            not isinstance(intent.get('parentIdentity'), dict) or
            set(intent['parentIdentity']) != {'dev', 'ino'} or
            any(type(value) is not int for value in intent['parentIdentity'].values()) or
            intent['phase'] not in ('prepared', 'quarantined', 'installed', 'conflict') or
            any(value is not None and not re.fullmatch(r'[0-9a-f]{64}', value)
                for value in (intent['expected'], intent['replacement']))):
        raise ValueError('Invalid publisher operation journal')


def operation_start(request):
    validate_target('/'.join(parts(request['target'])))
    target, basename = parent(request['target'])
    active = directory(request['active'])
    token = uuid.uuid4().hex
    intent_name = 'operation-' + token + '.json'
    intent = dict(relative='/'.join(parts(request['target'])),
                  expected=request['expected'], replacement=request['replacement'],
                  quarantine='displaced-' + token + '.bin',
                  temporary='replacement-' + token + '.bin',
                  conflictFile='conflict-' + token + '.bin',
                  parentIdentity=parent_identity(target), phase='prepared')
    try:
        if os.fstat(target).st_dev != os.fstat(active).st_dev:
            raise ValueError('Publisher target and transaction must share a filesystem')
        # Validate source before the target can be displaced.
        if request['replacement'] is not None:
            if not re.fullmatch(r'(?:before|after)-[0-9]+\.bin', request['source']):
                raise ValueError('Publisher prepared artifact source is invalid')
            try:
                source = read_at(active, request['source'])
            except OSError as error:
                raise ValueError('Publisher prepared artifact is unsafe') from error
            if hashlib.sha256(source).hexdigest() != request['replacement']:
                raise ValueError('Publisher prepared artifact digest does not match')
            write_at(active, intent['temporary'], source)
        save_intent(active, intent_name, intent)
        PENDING[token] = (target, basename, active, intent_name, intent)
        return token
    except BaseException:
        os.close(target)
        os.close(active)
        raise


def operation_quarantine(token):
    target, basename, active, name, intent = PENDING[token]
    check_parent(target, basename, active, name, intent)
    if intent['expected'] is not None:
        os.rename(basename, intent['quarantine'], src_dir_fd=target, dst_dir_fd=active)
        os.fsync(target)
        os.fsync(active)
    check_parent(target, basename, active, name, intent)
    intent['phase'] = 'quarantined'
    save_intent(active, name, intent)
    return None


def operation_install(token):
    target, basename, active, name, intent = PENDING[token]
    try:
        check_parent(target, basename, active, name, intent)
        if intent['expected'] is not None:
            try:
                displaced_hash = digest_at(active, intent['quarantine'])
            except (OSError, ValueError):
                try:
                    restore_quarantine(active, target, basename, intent)
                except FileExistsError:
                    pass
                raise
            if displaced_hash != intent['expected']:
                try:
                    restore_quarantine(active, target, basename, intent)
                except FileExistsError:
                    pass
                raise ValueError('Publisher target changed during quarantine; evidence preserved')
        if intent['replacement'] is not None:
            if digest_at(active, intent['temporary']) != intent['replacement']:
                if intent['expected'] is not None:
                    try:
                        restore_quarantine(active, target, basename, intent)
                    except FileExistsError:
                        pass
                raise ValueError('Publisher prepared artifact changed; evidence preserved')
            # linkat is atomic NOREPLACE on Linux and macOS.
            os.link(intent['temporary'], basename, src_dir_fd=active, dst_dir_fd=target,
                    follow_symlinks=False)
            os.fsync(target)
        elif digest_at(target, basename) is not None:
            raise ValueError('Publisher target changed during removal; evidence preserved')
        check_parent(target, basename, active, name, intent)
        intent['phase'] = 'installed'
        save_intent(active, name, intent)
    except BaseException:
        # Keep descriptors until recovery or EOF can preserve a relocation
        # conflict without looking up a different directory by pathname.
        raise


def operation_finish(token):
    target, basename, active, name, intent = PENDING[token]
    try:
        check_parent(target, basename, active, name, intent)
    finally:
        os.close(target)
        os.close(active)
        del PENDING[token]


def operation_recover(active_path, entries):
    active = directory(active_path)
    try:
        operations = []
        for name in sorted(os.listdir(active)):
            if not name.startswith('operation-') or not name.endswith('.json'):
                continue
            intent = json.loads(read_at(active, name))
            validate_intent(name, intent)
            entry = next((e for e in entries if e['relative'] == intent['relative']), None)
            if entry is None or (intent['expected'], intent['replacement']) not in (
                    (entry['beforeHash'], entry['afterHash']),
                    (entry['afterHash'], entry['beforeHash'])):
                raise ValueError('Publisher operation does not match transaction journal')
            # Validate all parent identities before any recovery mutation.
            if intent['phase'] == 'conflict' or not parent_matches(intent):
                pending = next((record for record in PENDING.values() if record[3] == name), None)
                if intent['phase'] != 'conflict':
                    if pending is not None:
                        preserve_parent_conflict(*pending)
                    else:
                        intent['phase'] = 'conflict'
                        save_intent(active, name, intent)
                raise ValueError('Publisher unsafe parent changed; conflict evidence preserved')
            operations.append((name, intent))
        # Resolve unfinished quarantines first: an earlier completed install
        # may legitimately have a missing path while its rollback is pending.
        for name, intent in sorted(operations, key=lambda item: item[1]['phase'] == 'installed'):
            target, basename = parent(intent['relative'])
            try:
                displaced = digest_at(active, intent['quarantine'])
                current = digest_at(target, basename)
                # A writer changed the displaced object: keep all evidence.
                if displaced is not None and displaced != intent['expected']:
                    if current is None:
                        check_parent(target, basename, active, name, intent)
                        restore_quarantine(active, target, basename, intent)
                        check_parent(target, basename, active, name, intent)
                    raise ValueError('Publisher recovery found changed target in quarantine')
                # An interrupted quarantine is restored before ordinary journal
                # recovery decides between the complete before/after generation.
                if current is None and displaced is not None and intent['phase'] != 'installed':
                    check_parent(target, basename, active, name, intent)
                    restore_quarantine(active, target, basename, intent)
                    check_parent(target, basename, active, name, intent)
                elif current not in (intent['expected'], intent['replacement']):
                    raise ValueError('Publisher recovery found changed target; evidence preserved')
            finally:
                os.close(target)
    finally:
        os.close(active)


def dispatch(r):
    global GUARD
    op = r['op']
    if op == 'guard':
        fd, name = parent('generated/tmp/.translation-publisher.guard')
        try:
            GUARD = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            if not stat.S_ISREG(os.fstat(GUARD).st_mode):
                raise ValueError('Publisher lease guard is unsafe')
            fcntl.flock(GUARD, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return None
        finally:
            os.close(fd)
    if op == 'replaceStart':
        return operation_start(r)
    if op == 'replaceQuarantine':
        return operation_quarantine(r['token'])
    if op == 'replaceInstall':
        return operation_install(r['token'])
    if op == 'replaceFinish':
        return operation_finish(r['token'])
    if op == 'recoverOperations':
        return operation_recover(r['path'], r['entries'])
    if op == 'closeHandle':
        os.close(HANDLES.pop(r['handle']))
        return None
    if op == 'syncHandle':
        os.fsync(HANDLES[r['handle']])
        return None
    if op == 'writeHandle':
        data = base64.b64decode(r['data'])
        fd = HANDLES[r['handle']]
        while data:
            data = data[os.write(fd, data):]
        return None
    if op in ('list', 'sync'):
        fd = directory(r['path'])
        try:
            return os.listdir(fd) if op == 'list' else os.fsync(fd)
        finally:
            os.close(fd)
    fd, name = parent(r['path'])
    try:
        if op == 'stat':
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            return dict(mode=s.st_mode, size=s.st_size, ino=s.st_ino, dev=s.st_dev)
        if op == 'read':
            return base64.b64encode(read_at(fd, name)).decode()
        if op == 'mkdir':
            return os.mkdir(name, r.get('mode', 0o777), dir_fd=fd)
        if op == 'unlink':
            return os.unlink(name, dir_fd=fd)
        if op == 'rmdir':
            return os.rmdir(name, dir_fd=fd)
        if op == 'rename':
            other, other_name = parent(r['to'])
            try:
                return os.rename(name, other_name, src_dir_fd=fd, dst_dir_fd=other)
            finally:
                os.close(other)
        if op == 'open':
            flags = {'wx': os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                     'w': os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                     'r': os.O_RDONLY}[r['flags']] | os.O_NOFOLLOW
            handle = uuid.uuid4().hex
            HANDLES[handle] = os.open(name, flags, r.get('mode', 0o600), dir_fd=fd)
            return handle
        raise ValueError('Unknown publisher filesystem operation')
    finally:
        os.close(fd)


for line in sys.stdin:
    try:
        request = json.loads(line)
        result = dispatch(request)
        response = dict(id=request['id'], result=result)
    except Exception as error:
        code = errno.errorcode.get(getattr(error, 'errno', None), 'EINVAL')
        message = str(error)
        if code in ('ELOOP', 'ENOTDIR'):
            message = 'Refusing symbolic-link or unsafe publisher path: ' + message
        response = dict(id=request.get('id'), error=message, code=code)
    print(json.dumps(response, separators=(',', ':')), flush=True)

# Parent termination closes stdin. Pending directory descriptors still let us
# restore an observed relocation without following the replacement pathname.
for record in list(PENDING.values()):
    try:
        check_parent(*record)
    except Exception:
        pass
