#!/usr/bin/env bash
# Prune merged branches and the stale agent worktrees holding them.
#
#   .claude/scripts/git-cleanup.sh          # dry run — show what would go
#   .claude/scripts/git-cleanup.sh --yes    # actually delete
#
# "Merged" is decided by asking GitHub for the set of merged PR head branches
# (one API call). Without gh, it falls back to a squash-aware tree comparison
# against the default branch, which is correct but misses branches that merged
# main into themselves before landing.
#
# Two passes: first remove agent worktrees under .claude/worktrees/ whose branch
# has merged, then delete local branches whose remote is gone. Worktrees are
# removed without --force, so one holding uncommitted or untracked work is
# reported and kept rather than discarded.
#
# Never touches: the current branch, the default branch, worktrees outside
# .claude/worktrees/, or any branch with unmerged work.
set -uo pipefail

APPLY=0
case "${1:-}" in --yes|-y) APPLY=1 ;; esac

ROOT=$(git rev-parse --show-toplevel) || exit 1
cd "$ROOT" || exit 1
AGENT_WT="$ROOT/.claude/worktrees/"

git fetch --prune --quiet origin || { echo "fetch failed — is origin reachable?"; exit 1; }
git worktree prune

MAIN=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

MERGED_PRS=$(gh pr list --state merged --limit 200 --json headRefName -q '.[].headRefName' 2>/dev/null)
[ -z "$MERGED_PRS" ] && echo "note: gh unavailable — falling back to local tree comparison"

merged() {
  printf '%s\n' "$MERGED_PRS" | grep -qx -- "$1" && return 0
  git merge-base --is-ancestor "$1" "$MAIN" 2>/dev/null && return 0
  # Squash-merge: compare the branch's tree against main as a synthetic commit.
  local base tree probe
  base=$(git merge-base "$MAIN" "$1" 2>/dev/null) || return 1
  tree=$(git rev-parse "$1^{tree}" 2>/dev/null) || return 1
  probe=$(git commit-tree "$tree" -p "$base" -m probe 2>/dev/null) || return 1
  [ -z "$(git cherry "$MAIN" "$probe" 2>/dev/null | grep '^+')" ]
}

# branch<TAB>path for every branch checked out in a worktree.
worktree_list() {
  git worktree list --porcelain | awk '
    /^worktree /{p=substr($0,10)}
    /^branch refs\/heads\//{print substr($0,19) "\t" p}'
}

wt_gone=(); wt_dirty=(); wt_foreign=(); freed=()

# Pass 1 — retire agent worktrees whose branch has already merged.
while IFS=$'\t' read -r branch path; do
  [ -n "$branch" ] || continue
  [ "$path" = "$ROOT" ] && continue
  merged "$branch" || continue
  case "$path" in
    "$AGENT_WT"*) ;;
    *) wt_foreign+=("$branch -> $path"); continue ;;
  esac
  if [ "$APPLY" = 0 ]; then
    wt_gone+=("$path"); freed+=("$branch")
  elif git worktree remove "$path" 2>/dev/null; then
    wt_gone+=("$path"); freed+=("$branch")
  else
    wt_dirty+=("$path")
  fi
done < <(worktree_list)

# Pass 2 — delete merged branches, including any just freed by pass 1.
HELD=$(worktree_list)
FREED=$(printf '%s\n' ${freed[@]+"${freed[@]}"})
held_by() {
  printf '%s\n' "$FREED" | grep -qx -- "$1" && return 0   # worktree already gone (or would be)
  printf '%s\n' "$HELD" | awk -F'\t' -v b="$1" '$1==b{print $2}'
}

del=(); keep_unmerged=(); keep_local=(); merged_live=(); held=(); skipped=0

while read -r branch upstream track; do
  [ -n "$branch" ] || continue
  [ "$branch" = "$CURRENT" ] || [ "$branch" = "${MAIN#origin/}" ] && { skipped=$((skipped+1)); continue; }

  wt=$(held_by "$branch")
  if [ -n "$wt" ]; then
    merged "$branch" && held+=("$branch -> $wt")
    skipped=$((skipped+1)); continue
  fi

  if [ -n "$upstream" ] && [ "$track" = "[gone]" ]; then
    if merged "$branch"; then del+=("$branch"); else keep_unmerged+=("$branch"); fi
  elif [ -z "$upstream" ]; then
    if merged "$branch"; then del+=("$branch"); else keep_local+=("$branch"); fi
  elif merged "$branch"; then
    merged_live+=("$branch")
  else
    skipped=$((skipped+1))
  fi
done < <(git for-each-ref --format='%(refname:short) %(upstream) %(upstream:track)' refs/heads)

if [ ${#wt_gone[@]} -gt 0 ]; then
  [ "$APPLY" = 1 ] && echo "Removed ${#wt_gone[@]} merged agent worktree(s):" \
                   || echo "Would remove ${#wt_gone[@]} merged agent worktree(s):"
  printf '  %s\n' "${wt_gone[@]#$AGENT_WT}"
fi

if [ ${#del[@]} -eq 0 ]; then
  echo "No branches to delete."
elif [ "$APPLY" = 1 ]; then
  echo "Deleted ${#del[@]} branch(es):"
  for b in "${del[@]}"; do git branch -D "$b" >/dev/null 2>&1 && echo "  $b"; done
else
  echo "Would delete ${#del[@]} branch(es) (re-run with --yes):"
  printf '  %s\n' "${del[@]}"
fi

[ ${#keep_unmerged[@]} -gt 0 ] && { echo "Kept — remote gone but NOT merged (check before deleting):"; printf '  %s\n' "${keep_unmerged[@]}"; }
[ ${#keep_local[@]} -gt 0 ] && { echo "Kept — local only, unmerged work:"; printf '  %s\n' "${keep_local[@]}"; }
[ ${#merged_live[@]} -gt 0 ] && { echo "Merged, but the remote branch still exists (kept — delete it on GitHub first):"; printf '  %s\n' "${merged_live[@]}"; }
[ ${#wt_dirty[@]} -gt 0 ] && { echo "Worktree kept — uncommitted or untracked files inside:"; printf '  %s\n' "${wt_dirty[@]#$AGENT_WT}"; }
[ ${#wt_foreign[@]} -gt 0 ] && { echo "Merged, but held by a worktree outside .claude/worktrees/ (yours to remove):"; printf '  %s\n' "${wt_foreign[@]}"; }
[ ${#held[@]} -gt 0 ] && { echo "Merged, but still held by a worktree:"; printf '  %s\n' "${held[@]}"; }
[ "$skipped" -gt 0 ] && echo "Skipped $skipped (current / default / active remote / in a worktree)."
exit 0
