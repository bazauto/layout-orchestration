---
name: docs-sync
description: Bring the documentation into line with the code on the current branch, before the PR opens. Use after landing a change and before opening a PR, or when asked whether the docs still match the code, whether a change falsifies CLAUDE.md, or to update the index / current-state / README / decision record for work just done.
---

# Doc sync

`CLAUDE.md` requires documentation to move **with** the code, in the same PR — never as a
follow-up. This skill is that pass. It is not a summary of the diff: it is a check of four
specific places, each of which the diff may have falsified.

Work from the branch diff, not from memory of what you did:

```powershell
git diff main...HEAD --stat
git diff main...HEAD
```

## The five places, in order

**1. `docs/mqtt-contract.md` — first, and differently.** The contract is binding against the
ESP firmware in `bazauto/esp-layout-controller`, and it changes *before* the code, not after.
So this is not a sync step but a **check**: if the diff adds or changes a topic, payload
field, QoS or retention setting that the contract does not already describe, the process was
violated. Say so plainly and stop — do not quietly write the contract to match the code that
already shipped. Use the `/mqtt-check` skill for the detail.

**2. `docs/<area>.md` — the decision record.** If the change made a design decision, it needs
a numbered entry (D-, B-, A-, P-, M- per that file's existing scheme). Find the highest
existing id (`grep -n "^### D" docs/<area>.md | tail -3`) and add the next one. A decision
records the **question, the options, the choice, and why** — including options refused, which
is the part that stops the same ground being re-litigated later. If the change *supersedes* an
earlier decision, amend that decision in place and note what changed; do not leave two records
disagreeing.

**3. `docs/current-state.md` — what the area now consists of.** This is the long form of
CLAUDE.md's index. Update the section for the area touched, in the present tense, describing
what exists now — not what changed.

**4. `CLAUDE.md` — the index line, and only the index line.** One row in the "What has landed"
table per area: enough to know whether this is what you are touching, plus the record that
explains it. Then check the two lists below the table:

- **Traps** — did this change create something that now *looks* like a bug and is not? A
  deliberately narrow `catch`, an asymmetry between two similar paths, a missing-looking
  migration. Add one line, with the record id.
- **Open limits** — did this change **close** one? Then delete it, rather than leaving a
  stale limit that sends the next reader chasing a fixed problem. Did it create a new
  accepted gap? Add one line.

Remember what this file costs: it loads into **every session and every subagent**, so a line
here is paid for by tasks that never touch the area. One line, pointing at the record. Reasoning
belongs in step 2.

**5. `README.md`.** Three sections drift: **Current Status**, **Known Limits** (the long form
of CLAUDE.md's open limits — a limit leaves this list only when the decision behind it
changes, not when someone hopes it has), and **Next Milestones** (does the change complete or
reorder one?).

## Rules

- **Rewrite, never append.** When a later change supersedes an earlier one, the entry is
  rewritten. `CLAUDE.md` says this explicitly, and the failure mode is a document that reads
  as a changelog with the current truth buried at the bottom.
- **Present tense, no history.** These documents describe the system as it is. "Now uses" and
  "was changed to" both mean the reader has to work out what is true today.
- **Do not invent a limit or a decision to fill a section.** Most changes touch two or three
  of the five places, not all five. Say which you checked and found already correct.
- **Verify before you delete an open limit.** A limit closed in the code is different from a
  limit closed in coverage — a beam that has not been fitted yet does not close `braking.md`
  B4. If the model half landed and the coverage half did not, the limit is rewritten, not
  removed.

## Output

A short list: file, what you changed, and why the diff required it. Then, explicitly, the
places you checked and left alone. If step 1 found the contract was changed after the code
rather than before, that goes first and is flagged as a process violation, not a doc edit.
