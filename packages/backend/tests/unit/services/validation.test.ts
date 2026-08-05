import { describe, it, expect } from 'vitest';
import {
  parsePointConditions,
  parseBlockEdgeRow,
  BlockEdgeRowInvalidError,
  edgeCreateSchema,
  edgeUpdateSchema,
} from '../../../src/services/validation';

describe('parsePointConditions', () => {
  it('parses an empty array', () => {
    expect(parsePointConditions('[]')).toEqual([]);
  });

  it('parses a two-element array, preserving order and both fields', () => {
    const json = JSON.stringify([
      { pointId: 'p1', requiredPosition: 'normal' },
      { pointId: 'p2', requiredPosition: 'reverse' },
    ]);
    expect(parsePointConditions(json)).toEqual([
      { pointId: 'p1', requiredPosition: 'normal' },
      { pointId: 'p2', requiredPosition: 'reverse' },
    ]);
  });

  it('throws on malformed JSON', () => {
    expect(() => parsePointConditions('not json')).toThrow();
  });

  it('throws on a JSON object instead of an array', () => {
    expect(() => parsePointConditions('{}')).toThrow();
  });

  it('throws when requiredPosition is "unknown"', () => {
    expect(() =>
      parsePointConditions('[{"pointId":"p1","requiredPosition":"unknown"}]'),
    ).toThrow();
  });

  it('throws when pointId is empty', () => {
    expect(() =>
      parsePointConditions('[{"pointId":"","requiredPosition":"normal"}]'),
    ).toThrow();
  });
});

const validRow = {
  id: 'e1',
  layoutId: 'layout-1',
  fromBlockId: 'b1',
  fromEnd: 'north',
  toBlockId: 'b2',
  toEnd: 'south',
  pointConditions: '[]',
  lengthMm: 100,
};

describe('parseBlockEdgeRow', () => {
  it('parses a valid row into a domain BlockEdge', () => {
    expect(parseBlockEdgeRow(validRow)).toEqual({
      id: 'e1',
      layoutId: 'layout-1',
      fromBlockId: 'b1',
      fromEnd: 'north',
      toBlockId: 'b2',
      toEnd: 'south',
      pointConditions: [],
      lengthMm: 100,
    });
  });

  it('parses a NULL length_mm to null', () => {
    expect(parseBlockEdgeRow({ ...validRow, lengthMm: null }).lengthMm).toBeNull();
  });

  it('throws BlockEdgeRowInvalidError for an un-normalised from_end like "North"', () => {
    expect(() => parseBlockEdgeRow({ ...validRow, fromEnd: 'North' })).toThrow(
      BlockEdgeRowInvalidError,
    );
  });

  it('throws BlockEdgeRowInvalidError, not a bare error, for malformed point_conditions JSON', () => {
    expect(() => parseBlockEdgeRow({ ...validRow, pointConditions: 'not json' })).toThrow(
      BlockEdgeRowInvalidError,
    );
  });

  it('never coerces — a row missing a required column throws rather than defaulting', () => {
    const rowWithoutId: Record<string, unknown> = { ...validRow };
    delete rowWithoutId.id;
    expect(() => parseBlockEdgeRow(rowWithoutId)).toThrow(BlockEdgeRowInvalidError);
  });
});

describe('edgeCreateSchema', () => {
  const validInput = {
    fromBlockId: 'b1',
    fromEnd: 'north',
    toBlockId: 'b2',
    toEnd: 'south',
  };

  it('accepts a minimal valid input, defaulting pointConditions to [] and lengthMm to null', () => {
    const result = edgeCreateSchema.parse(validInput);
    expect(result.pointConditions).toEqual([]);
    expect(result.lengthMm).toBeNull();
  });

  it('trims and lower-cases fromEnd/toEnd', () => {
    const result = edgeCreateSchema.parse({ ...validInput, fromEnd: '  North ', toEnd: 'SOUTH' });
    expect(result.fromEnd).toBe('north');
    expect(result.toEnd).toBe('south');
  });

  it('rejects an unknown key such as layoutId (.strict())', () => {
    expect(() => edgeCreateSchema.parse({ ...validInput, layoutId: 'sneaky' })).toThrow();
  });

  it('rejects an unknown key such as id (.strict())', () => {
    expect(() => edgeCreateSchema.parse({ ...validInput, id: 'sneaky' })).toThrow();
  });

  it('rejects a non-positive lengthMm', () => {
    expect(() => edgeCreateSchema.parse({ ...validInput, lengthMm: 0 })).toThrow();
  });
});

describe('edgeUpdateSchema', () => {
  it('accepts a partial patch with a single field', () => {
    expect(edgeUpdateSchema.parse({ lengthMm: 500 })).toEqual({ lengthMm: 500 });
  });

  it('accepts an empty patch', () => {
    expect(edgeUpdateSchema.parse({})).toEqual({});
  });

  it('rejects an unknown key (.strict())', () => {
    expect(() => edgeUpdateSchema.parse({ layoutId: 'sneaky' })).toThrow();
  });
});
