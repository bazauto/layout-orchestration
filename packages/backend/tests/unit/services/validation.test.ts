import { describe, it, expect } from 'vitest';
import {
  parsePointConditions,
  parseBlockEdgeRow,
  BlockEdgeRowInvalidError,
  edgeCreateSchema,
  edgeUpdateSchema,
  parseUserRow,
  UserRowInvalidError,
  parseSessionRow,
  SessionRowInvalidError,
  parseSensorRow,
  SensorRowInvalidError,
  userCreateSchema,
  userRoleUpdateSchema,
  passwordResetSchema,
  changePasswordSchema,
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

const validUserRow = {
  id: 'u1',
  username: 'alice',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$salt$digest',
  role: 'admin',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('parseUserRow', () => {
  it('parses a valid row into a UserRecord', () => {
    expect(parseUserRow(validUserRow)).toEqual(validUserRow);
  });

  it('parses a NULL passwordHash to null (reserved for a future WebAuthn-only account)', () => {
    expect(parseUserRow({ ...validUserRow, passwordHash: null }).passwordHash).toBeNull();
  });

  it('throws UserRowInvalidError for an invalid role', () => {
    expect(() => parseUserRow({ ...validUserRow, role: 'superadmin' })).toThrow(
      UserRowInvalidError,
    );
  });

  it('throws UserRowInvalidError for an empty passwordHash string', () => {
    expect(() => parseUserRow({ ...validUserRow, passwordHash: '' })).toThrow(
      UserRowInvalidError,
    );
  });

  it('never coerces — a row missing a required column throws rather than defaulting', () => {
    const rowWithoutRole: Record<string, unknown> = { ...validUserRow };
    delete rowWithoutRole.role;
    expect(() => parseUserRow(rowWithoutRole)).toThrow(UserRowInvalidError);
  });
});

const validSessionRow = {
  id: 's1',
  userId: 'u1',
  tokenHash: 'a'.repeat(64),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-31T00:00:00.000Z'),
};

describe('parseSessionRow', () => {
  it('parses a valid row into a SessionRecord', () => {
    expect(parseSessionRow(validSessionRow)).toEqual(validSessionRow);
  });

  it('throws SessionRowInvalidError for a row missing a required column', () => {
    const rowWithoutUserId: Record<string, unknown> = { ...validSessionRow };
    delete rowWithoutUserId.userId;
    expect(() => parseSessionRow(rowWithoutUserId)).toThrow(SessionRowInvalidError);
  });
});

const validSensorRow = {
  id: 's1',
  layoutId: 'layout-1',
  name: 'Sensor 1',
  type: 'block_detection',
  blockId: 'b1',
  mqttTopic: 'layout/layout-1/sensor/s1/reading',
  inService: true,
};

describe('parseSensorRow', () => {
  it('parses a valid row into a SensorRecord', () => {
    expect(parseSensorRow(validSensorRow)).toEqual(validSensorRow);
  });

  it('parses a NULL blockId to null', () => {
    expect(parseSensorRow({ ...validSensorRow, blockId: null }).blockId).toBeNull();
  });

  it('throws SensorRowInvalidError for an invalid type such as "magnetic"', () => {
    expect(() => parseSensorRow({ ...validSensorRow, type: 'magnetic' })).toThrow(
      SensorRowInvalidError,
    );
  });

  it('throws SensorRowInvalidError for a null inService — the column is NOT NULL and must never be read as "safe"', () => {
    expect(() => parseSensorRow({ ...validSensorRow, inService: null })).toThrow(
      SensorRowInvalidError,
    );
  });

  it('throws SensorRowInvalidError for an empty mqttTopic', () => {
    expect(() => parseSensorRow({ ...validSensorRow, mqttTopic: '' })).toThrow(
      SensorRowInvalidError,
    );
  });

  it('never coerces — a row missing a required column throws rather than defaulting', () => {
    const rowWithoutInService: Record<string, unknown> = { ...validSensorRow };
    delete rowWithoutInService.inService;
    expect(() => parseSensorRow(rowWithoutInService)).toThrow(SensorRowInvalidError);
  });
});

describe('userCreateSchema', () => {
  const validInput = { username: 'alice', password: 'a-good-password', role: 'operator' };

  it('accepts a valid payload', () => {
    expect(userCreateSchema.parse(validInput)).toEqual(validInput);
  });

  it('rejects an unknown extra field (.strict())', () => {
    expect(() => userCreateSchema.parse({ ...validInput, isAdmin: true })).toThrow();
  });

  it('rejects a blank/whitespace username', () => {
    expect(() => userCreateSchema.parse({ ...validInput, username: '   ' })).toThrow();
  });

  it('rejects a short password', () => {
    expect(() => userCreateSchema.parse({ ...validInput, password: '1234567' })).toThrow();
  });

  it('rejects a role outside the enum', () => {
    expect(() => userCreateSchema.parse({ ...validInput, role: 'superadmin' })).toThrow();
  });

  it('requires role rather than defaulting it', () => {
    const withoutRole = { username: validInput.username, password: validInput.password };
    expect(() => userCreateSchema.parse(withoutRole)).toThrow();
  });
});

describe('userRoleUpdateSchema', () => {
  it('accepts a valid payload', () => {
    expect(userRoleUpdateSchema.parse({ role: 'admin' })).toEqual({ role: 'admin' });
  });

  it('rejects an unknown extra field (.strict())', () => {
    expect(() => userRoleUpdateSchema.parse({ role: 'admin', username: 'sneaky' })).toThrow();
  });

  it('rejects a role outside the enum', () => {
    expect(() => userRoleUpdateSchema.parse({ role: 'superadmin' })).toThrow();
  });
});

describe('passwordResetSchema', () => {
  it('accepts a valid payload', () => {
    expect(passwordResetSchema.parse({ password: 'a-good-password' })).toEqual({
      password: 'a-good-password',
    });
  });

  it('rejects an unknown extra field (.strict())', () => {
    expect(() => passwordResetSchema.parse({ password: 'a-good-password', role: 'admin' })).toThrow();
  });

  it('rejects a short password', () => {
    expect(() => passwordResetSchema.parse({ password: '1234567' })).toThrow();
  });
});

describe('changePasswordSchema', () => {
  const validInput = { currentPassword: 'old-password', newPassword: 'a-good-password' };

  it('accepts a valid payload', () => {
    expect(changePasswordSchema.parse(validInput)).toEqual(validInput);
  });

  it('rejects an unknown extra field (.strict())', () => {
    expect(() => changePasswordSchema.parse({ ...validInput, role: 'admin' })).toThrow();
  });

  it('rejects an empty currentPassword', () => {
    expect(() => changePasswordSchema.parse({ ...validInput, currentPassword: '' })).toThrow();
  });

  it('rejects a short newPassword', () => {
    expect(() => changePasswordSchema.parse({ ...validInput, newPassword: '1234567' })).toThrow();
  });
});
