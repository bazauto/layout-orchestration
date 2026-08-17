---
name: pr
description: Open a pull request for the current work the way this repo requires — branch off origin/main, body passed by file, rebase not merge, then merge once CI is green. Use when asked to open, raise, or push up a PR, to land or ship a change, or when work is finished and needs to go to main.
---

# Opening a PR here

Everything reaches `main` through a PR. There are four hard-won mechanics below; each of
them has already gone wrong at least once.

## Before anything else

**Never commit to `main`, and never fast-forward it.** If work is already sitting on local
`main`, do not push it: rewind and move it to a branch.

```powershell
git branch feat/<slug>            # keep the commits
git reset --hard origin/main      # put main back
git checkout feat/<slug>
```

**Branch off `origin/main`, not local `main`.** PRs merge fast here and local `main` goes
stale within the hour, so always fetch first:

```powershell
git fetch origin
git checkout -b feat/<slug> origin/main
```

## Documentation is part of the PR, not a follow-up

Run the `/docs-sync` skill before opening. `CLAUDE.md` requires the docs to move with the
code in the same PR, and a PR that falsifies the index or `README.md` §Known Limits is
incomplete work, not a tidy-up for later.

## Verify, and quote real output

Run `npm test` and `npm run lint` **from the repo root** — inside `packages/backend`, `npm
test` succeeds while running only that workspace, so a green backend run reads as a full
pass while the frontend suite never executed. The `/verify` agent does the full sweep.

Never write a passing test count into a PR body without having run it in this session.

## Writing the body — pass it by file

**Never pass a multi-line body inline.** Backticks detonate in the shell, `>` silently
creates a junk file in the repo, and here-strings and heredocs both misbehave here. Write
the body to a file and pass the path:

```powershell
gh pr create --title "<title>" --body-file .git/pr-body.md
```

Put the file somewhere untracked — `.git/` is ideal, since nothing will ever stage it. Then
**check `git status --short` before any `git add`**, and never reach for `git add -A` with an
unexplained file in the tree.

Body shape — prose that explains the change, matching the repo's commit style rather than a
form. Read a recent one (`gh pr view <n>`) before writing:

- what the change does, and the problem it solves
- the design decisions worth knowing, and anything deliberately refused
- what is tested, with the real output
- doc updates included
- `Closes #<n>` where it applies

## Never merge `main` into the branch

Merge commits are disabled on this repo, and merging `main` in breaks the rebase button.
To take on upstream changes:

```powershell
git fetch origin
git rebase origin/main
```

## Merging

Paul does not review the diffs — PRs stand as change blocks, and **merging is yours once CI
is green**. Wait for the `CI` workflow to pass, then merge:

```powershell
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```

Do not merge on a red or still-running CI. If CI fails, fix it on the branch and push — a
failing check is not something to explain away in a comment.

Afterwards, `/branch-cleanup` removes the merged local branch and any stale worktree.

## Report

The PR URL, the title, whether CI passed, and whether you merged it. If you stopped short of
merging, say exactly why.
