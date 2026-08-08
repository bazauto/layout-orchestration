---
name: branch-cleanup
description: Delete local git branches whose PR has been merged and whose remote branch has been deleted, and remove the stale agent worktrees holding them. Use when the user asks to clean up, prune, or tidy local branches or worktrees.
---

Run exactly this one command and report its output:

```bash
bash .claude/scripts/git-cleanup.sh --yes
```

That is the whole task. Do not run any other git commands, do not inspect
branches individually, and do not summarise beyond the script's own output —
the script already fetches, prunes, and decides. Reply with its output and stop.

Only if the user asks about a specific branch under "NOT merged" should you
investigate further.
