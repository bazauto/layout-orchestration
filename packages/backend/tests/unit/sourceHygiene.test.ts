/**
 * Repo hygiene: no source file may contain a raw control character that makes
 * git and ripgrep treat it as binary.
 *
 * ## Why this exists
 *
 * `services/gridGeometry.ts` keyed a map on `blockId` + NUL + `label` — a sound
 * separator, for the reason `domain/topology.ts` uses `^@`: it cannot occur in
 * an id or a label, so no name can forge a composite key. But the NUL was
 * written as a **literal byte** in the source rather than as an escape.
 *
 * One byte, and the whole module left circulation. git renders every diff of a
 * file containing a NUL as `Binary files differ`, so the changes to it in #78,
 * #91 and #104 all went through review unreadable. ripgrep skips such files
 * outright, so `findBlockRuns`, the opening derivation and the bearing
 * generator were invisible to every content search — including the ones
 * `CLAUDE.md` tells a new session to run.
 *
 * ## Why a test and not a code review note
 *
 * It came back within the hour. The separator is right and the pattern gets
 * copied when new code needs the same key, so the literal propagates by
 * imitation; the fix has to be mechanical. Writing an escape sequence produces a
 * byte-identical string at runtime, so there is never a reason to use the
 * literal.
 *
 * Scoped to source only. Binary fixtures, images and lockfiles are none of this
 * test's business.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve, sep } from 'path';

/** `packages/backend/tests/unit` → repo root. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

const SOURCE_ROOTS = ['packages', 'tests'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.sql', '.css', '.html'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'test-results', 'playwright-report', 'coverage']);

/**
 * Whether a code point is a control character with no business in source. Tab
 * (9), newline (10) and carriage return (13) are excluded — ordinary
 * whitespace, and this repo's files are CRLF.
 *
 * A character scan rather than a regex on purpose: ESLint's `no-control-regex`
 * rejects the equivalent pattern even when it is fully escaped. That rule is
 * also the reason the original defect survived — it polices control characters
 * in *regexes*, and says nothing about the ones in string and template
 * literals, which is exactly where this one lived.
 */
function isForbiddenControlChar(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return false;
  return code < 0x20 || code === 0x7f;
}

/** The index of the first forbidden character in `text`, or `-1`. */
function findControlChar(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (isForbiddenControlChar(text.charCodeAt(i))) return i;
  }
  return -1;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found; // a root that does not exist on this checkout is not a failure
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFiles(full, found);
    else if (SOURCE_EXTENSIONS.some((e) => entry.endsWith(e))) found.push(full);
  }
  return found;
}

describe('source hygiene', () => {
  it('contains no raw control characters that would make a file read as binary', () => {
    const offenders: string[] = [];

    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const text = readFileSync(file, 'utf8');
        const at = findControlChar(text);
        if (at === -1) continue;

        // Name the character and the line, because "this file is binary" is the
        // unhelpful message this test exists to replace.
        const codePoint = text.charCodeAt(at);
        const line = text.slice(0, at).split('\n').length;
        offenders.push(
          `${relative(REPO_ROOT, file).split(sep).join('/')}:${line} ` +
            `contains U+${codePoint.toString(16).padStart(4, '0').toUpperCase()} — ` +
            `write it as an escape sequence instead`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('actually scans a meaningful number of files, so a broken walk cannot pass vacuously', () => {
    // Without this, a wrong REPO_ROOT or an over-eager skip list turns the test
    // above into an assertion about the empty set.
    const count = SOURCE_ROOTS.reduce((n, r) => n + sourceFiles(join(REPO_ROOT, r)).length, 0);
    expect(count).toBeGreaterThan(100);
  });
});
