#!/usr/bin/env bash
#
# SessionStart hook — make a `claude -w <name>` worktree usable immediately.
#
# A fresh linked worktree has no node_modules, so npm/npx, the husky pre-commit
# hook and the editor tooling all fail until you install or link deps by hand.
# This symlinks the main checkout's node_modules into the worktree root,
# replacing the manual `ln -s <repo>/node_modules <worktree>/node_modules` step.
#
# Silent no-op (exit 0) when run in the main checkout, when node_modules is
# already present, when there is nothing to link to, or outside a git repo.
# Always exits 0 — a session must never fail to start because of this.

set -u

# Claude Code pipes the session JSON in on stdin. Drain it so the writer never
# sees a broken pipe; its .cwd is the directory we are already running in, so
# there is nothing worth parsing (and no jq dependency).
cat >/dev/null 2>&1 || true

# Echo an existing directory as an absolute, symlink-resolved path.
abs_dir() {
  [ -d "$1" ] || return 1
  (cd -- "$1" 2>/dev/null && pwd -P) || return 1
}

# Root of the checkout this session is in. Not a git repo => not a worktree.
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
top=$(abs_dir "$top") || exit 0

# Root of the MAIN checkout. Claude Code keeps CLAUDE_PROJECT_DIR pinned to the
# original project root (it does not follow the worktree); git's common dir --
# the main .git -- is the fallback when the hook is run outside Claude Code.
main=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  main=$(abs_dir "$CLAUDE_PROJECT_DIR") || main=""
fi
if [ -z "$main" ]; then
  common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
  main=$(abs_dir "$(dirname -- "$common")") || exit 0
fi

# Same root => the main checkout, not a worktree.
[ "$top" != "$main" ] || exit 0

# Already there (directory, file, or symlink -- even a dangling one): hands off.
if [ -e "$top/node_modules" ] || [ -L "$top/node_modules" ]; then
  exit 0
fi

# Nothing installed in the main checkout yet; `npm install` is the user's call.
[ -d "$main/node_modules" ] || exit 0

if ln -s "$main/node_modules" "$top/node_modules" 2>/dev/null; then
  echo "linked node_modules -> $main/node_modules"
fi

exit 0
