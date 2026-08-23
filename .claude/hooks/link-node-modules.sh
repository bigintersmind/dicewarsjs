#!/usr/bin/env bash
#
# SessionStart hook — make a `claude -w <name>` worktree usable immediately.
#
# A fresh linked worktree has no node_modules, so npm/npx and the husky
# pre-commit hook fail until you install or link deps by hand. This symlinks
# the main checkout's node_modules into the worktree root, replacing the manual
# `ln -s <repo>/node_modules <worktree>/node_modules` step.
#
# The link is shared, not copied: `npm install <pkg>` inside the worktree writes
# into the MAIN checkout's node_modules, and a plain `npm install`/`npm ci` in
# the worktree replaces the symlink with a real directory (npm warns about it).
#
# Silent no-op (exit 0) when run in the main checkout, when node_modules is
# already present, when there is nothing to link to, or outside a git repo.
# Prints one line when it links, and one line when it finds node_modules in a
# state it won't touch but that will break the worktree (a dangling symlink),
# or when the link itself fails. Always exits 0 — a session must never fail to
# start because of this.
#
# Works by hand too: `bash .claude/hooks/link-node-modules.sh` from anywhere
# inside the worktree.

set -u

# Claude Code pipes the session JSON in on stdin; it is deliberately not read.
# Its .cwd is the directory we are already running in, so there is nothing
# worth parsing (no jq dependency), and reading stdin at all would block a
# by-hand or tool-driven run whose stdin is a pipe nobody closes.

# Echo an existing directory as an absolute, symlink-resolved path.
abs_dir() {
  [ -d "$1" ] || return 1
  (cd -- "$1" 2>/dev/null && pwd -P) || return 1
}

# Root of the checkout this session is in. Not a git repo => not a worktree.
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
top=$(abs_dir "$top") || exit 0

# Root of the MAIN checkout: the parent of git's common dir (the main .git),
# which every linked worktree of this repo shares. Derived from git, not from
# CLAUDE_PROJECT_DIR: inside a `claude -w` session that variable follows the
# worktree (observed on Claude Code 2.1.241), so comparing against it would
# make this a permanent no-op -- and by hand it could name an unrelated repo.
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
main=$(abs_dir "$(dirname -- "$common")") || exit 0

# Same root => the main checkout, not a worktree.
[ "$top" != "$main" ] || exit 0

# Already there. A real directory, file, or healthy symlink is left alone.
# A dangling symlink is left alone too, but say so -- it breaks the worktree.
if [ -e "$top/node_modules" ]; then
  exit 0
fi
if [ -L "$top/node_modules" ]; then
  echo "node_modules is a dangling symlink -> $(readlink -- "$top/node_modules"); remove it and this hook will relink on the next session"
  exit 0
fi

# Nothing installed in the main checkout yet; `npm install` is the user's call.
[ -d "$main/node_modules" ] || exit 0

if ln -s "$main/node_modules" "$top/node_modules" 2>/dev/null; then
  echo "linked node_modules -> $main/node_modules"
else
  echo "could not link node_modules -> $main/node_modules; npx, lint and husky will fail here until you run: ln -s $main/node_modules $top/node_modules"
fi

exit 0
