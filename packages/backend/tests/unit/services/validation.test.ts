import { describe, it, expect } from 'vitest';
import { parsePointConditions } from '../../../src/services/validation';

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
