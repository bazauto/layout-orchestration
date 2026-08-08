/**
 * Vitest global setup, loaded once via vite.config.ts `test.setupFiles`.
 *
 * `@testing-library/react` auto-registers an `afterEach(cleanup)` when it
 * detects a global test framework, which `globals: true` (vite.config.ts)
 * provides — this call is here to make that explicit rather than rely on
 * the auto-detection, and is harmless to call twice.
 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
