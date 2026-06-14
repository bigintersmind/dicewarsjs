#!/usr/bin/env sh
#
# Machine-wide serialization lock for the test suite.
#
# Vitest forks one worker per ~core; running several suites at once (e.g. several
# Claude Code subagents each calling `npm test`) multiplies jsdom workers until
# the machine runs out of RAM and freezes. This wrapper lets at most one vitest
# invocation run at a time: concurrent callers queue and run in turn, so peak
# memory stays bounded no matter how many runs are launched.
#
# Usage: scripts/test-lock.sh <command> [args...]
set -e

# CI runners are single-tenant — no contention to guard against, and a stale
# lock from a killed job would only cause hangs. Skip the lock there.
if [ -n "$CI" ]; then
  exec "$@"
fi

LOCK_DIR="${TMPDIR:-/tmp}/dicewarsjs-test.lock"
STALE_SECONDS=900 # break a lock held longer than 15 min (assume crashed holder)
WAIT_TIMEOUT=1800 # give up queuing after 30 min
WAITED=0

# mkdir is atomic, so it doubles as a cross-process mutex.
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  # Reclaim a stale lock left behind by a crashed/killed run.
  LOCK_MTIME=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
  LOCK_AGE=$(($(date +%s) - LOCK_MTIME))
  if [ "$LOCK_AGE" -gt "$STALE_SECONDS" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    continue
  fi
  if [ "$WAITED" -ge "$WAIT_TIMEOUT" ]; then
    echo "test-lock: timed out after ${WAIT_TIMEOUT}s waiting for $LOCK_DIR" >&2
    exit 1
  fi
  [ "$WAITED" -eq 0 ] && echo "test-lock: another test run holds the lock; waiting..." >&2
  sleep 2
  WAITED=$((WAITED + 2))
done

# Release the lock however we exit (success, failure, or signal). Must NOT exec
# the command — exec replaces this shell and would discard the trap, leaking the
# lock. Run it as a child, capture its status, and pass that status through.
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

set +e
"$@"
status=$?
exit "$status"
