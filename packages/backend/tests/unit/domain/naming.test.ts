import { describe, it, expect } from 'vitest';
import {
  EMPTY_NAME_BOOK,
  MAX_LABEL_CHARS,
  buildEdgeLabel,
  label,
  locoLabel,
  pluralise,
  shortId,
  truncateLabel,
} from '../../../src/domain/naming';
import { NameBook } from '../../../src/domain/types';

function bookWith(overrides: Partial<NameBook>): NameBook {
  return { ...EMPTY_NAME_BOOK, ...overrides };
}

describe('label', () => {
  it('renders a quoted name with a short id when a name is known', () => {
    expect(label('3c1dab82-d0db-4271-b695-62b599db0f88', 'Down Platform')).toBe(
      '"Down Platform" (3c1dab82)',
    );
  });

  it('degrades to the full raw id, byte-for-byte, when no name is known (D8)', () => {
    const id = '3c1dab82-d0db-4271-b695-62b599db0f88';
    expect(label(id, undefined)).toBe(id);
  });
});

describe('shortId', () => {
  it('returns an id shorter than SHORT_ID_CHARS whole', () => {
    expect(shortId('b1')).toBe('b1');
  });

  it('truncates a longer id to 8 characters', () => {
    expect(shortId('3c1dab82-d0db-4271-b695-62b599db0f88')).toBe('3c1dab82');
  });
});

describe('truncateLabel', () => {
  it('leaves a value at exactly MAX_LABEL_CHARS unchanged', () => {
    const value = 'a'.repeat(MAX_LABEL_CHARS);
    expect(truncateLabel(value)).toBe(value);
    expect(truncateLabel(value).length).toBe(MAX_LABEL_CHARS);
  });

  it('cuts a value one character over to 39 chars plus an ellipsis', () => {
    const value = 'a'.repeat(MAX_LABEL_CHARS + 1);
    const result = truncateLabel(value);
    expect(result).toBe(`${'a'.repeat(MAX_LABEL_CHARS - 1)}…`);
    expect(result.length).toBe(MAX_LABEL_CHARS);
  });
});

describe('buildEdgeLabel', () => {
  it('joins the endpoint names with their ends', () => {
    const result = buildEdgeLabel(
      { fromBlockId: 'b1', fromEnd: 'north', toBlockId: 'b2', toEnd: 'south' },
      (id) => (id === 'b1' ? 'Down Platform' : id === 'b2' ? 'Up Loop' : undefined),
    );
    expect(result).toBe('Down Platform:north → Up Loop:south');
  });

  it('falls back to the raw block id when an endpoint is unknown (the unknown-block violation case)', () => {
    const result = buildEdgeLabel(
      { fromBlockId: 'b1', fromEnd: 'north', toBlockId: 'block-ghost', toEnd: 'south' },
      (id) => (id === 'b1' ? 'Down Platform' : undefined),
    );
    expect(result).toBe('Down Platform:north → block-ghost:south');
  });
});

describe('locoLabel', () => {
  it('renders a named loco', () => {
    const book = bookWith({ locos: new Map([[3, 'Jinty']]) });
    expect(locoLabel(3, book)).toBe('"Jinty" (3)');
  });

  it('degrades to the bare address, byte-for-byte, with no book', () => {
    expect(locoLabel(3)).toBe('3');
  });
});

describe('pluralise', () => {
  it('uses the singular for 1', () => {
    expect(pluralise(1, 'reason')).toBe('1 reason');
  });

  it('appends an s for 0', () => {
    expect(pluralise(0, 'reason')).toBe('0 reasons');
  });

  it('appends an s for n > 1', () => {
    expect(pluralise(2, 'violation')).toBe('2 violations');
  });

  it('uses an explicit plural when given one', () => {
    expect(pluralise(2, 'edge', 'edges')).toBe('2 edges');
  });
});
