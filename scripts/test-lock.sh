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
# Staleness is decided by holder *liveness*, not wall-clock age: the holder
# records its PID inside the lock dir, and a waiter reclaims the lock only when
# that PID is gone (kill -0). A legitimately long run is therefore never mistaken
# for a crashed one. A waiter steals a dead lock by renaming it aside (atomic, so
# two waiters can't both reclaim and end up running concurrently), and the
# release trap removes only a lock this process still owns (so a reclaimed lock
# is never deleted out from under its new holder).
#
# Usage: scripts/test-lock.sh <command> [args...]
set -e

# CI runners are single-tenant — no contention to guard against, and a stale
# lock from a killed job would only cause hangs. Skip the lock there.
if [ -n "$CI" ]; then
  exec "$@"
fi

LOCK_DIR="${TMPDIR:-/tmp}/dicewarsjs-test.lock"
PID_FILE="$LOCK_DIR/pid"
STALE_SECONDS=900 # fallback: reclaim a lock that never recorded a PID after 15 min
WAIT_TIMEOUT=1800 # give up queuing after 30 min
WAITED=0

# PID currently recorded in the lock (empty if none / unreadable).
lock_owner() { cat "$PID_FILE" 2>/dev/null || true; }

# True only if the lock records a PID and that process is still running.
holder_alive() {
  _pid=$(lock_owner)
  [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null
}

# Steal a dead lock atomically: whoever renames the dir away first wins; every
# other waiter's mv fails because the source is already gone, so no one can
# rmdir a lock that a new holder has meanwhile re-created.
steal_lock() {
  _aside="${LOCK_DIR}.dead.$$"
  rm -rf "$_aside" 2>/dev/null || true
  if mv "$LOCK_DIR" "$_aside" 2>/dev/null; then
    rm -rf "$_aside" 2>/dev/null || true
  fi
}

# Release only a lock we still own. Armed before the acquire loop so a signal in
# the gap between acquiring and arming can't leak the dir; the ownership check
# makes it a no-op until (and unless) this process holds the lock.
release_lock() {
  if [ "$(lock_owner)" = "$$" ]; then
    rm -f "$PID_FILE" 2>/dev/null || true
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap release_lock EXIT INT TERM

# mkdir is atomic, so it doubles as a cross-process mutex.
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if holder_alive; then
    : # genuine live holder — wait our turn below
  elif [ -n "$(lock_owner)" ]; then
    # PID recorded but that process is gone — crashed holder; reclaim it.
    echo "test-lock: reclaiming lock from dead holder (pid $(lock_owner))" >&2
    steal_lock
    continue
  else
    # No PID recorded: either a holder caught in the microsecond between mkdir
    # and writing its PID (give it a moment), or a dir orphaned before it could
    # write one. Fall back to wall-clock age so a truly abandoned lock clears.
    LOCK_MTIME=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
    LOCK_AGE=$(($(date +%s) - LOCK_MTIME))
    if [ "$LOCK_AGE" -gt "$STALE_SECONDS" ]; then
      echo "test-lock: reclaiming lock with no PID after ${LOCK_AGE}s" >&2
      steal_lock
      continue
    fi
  fi
  if [ "$WAITED" -ge "$WAIT_TIMEOUT" ]; then
    echo "test-lock: timed out after ${WAIT_TIMEOUT}s waiting for $LOCK_DIR" >&2
    exit 1
  fi
  [ "$WAITED" -eq 0 ] && echo "test-lock: another test run holds the lock; waiting..." >&2
  sleep 2
  WAITED=$((WAITED + 2))
done

# We own the lock now — record our PID so waiters can test our liveness.
echo "$$" >"$PID_FILE"

# Run the command as a CHILD (not exec) so the release trap still fires on exit.
# Capture its status and pass it through unchanged.
set +e
"$@"
status=$?
exit "$status"
