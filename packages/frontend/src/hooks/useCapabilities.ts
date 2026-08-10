/**
 * useCapabilities
 *
 * Reads `GET /api/capabilities` once on mount (#65 D3/R3). Alongside
 * `useAuth`, not folded into `useLayoutConfig` — `useLayoutConfig` is keyed
 * on `layoutId`, re-fetches whenever it changes, and collapses every failure
 * into one shared `error` string, none of which has anything to do with a
 * capabilities read.
 *
 * Fails closed: state starts `{ sensorSimulation: false }` and is only ever
 * set true on `res.ok && body.sensorSimulation === true`. Every other
 * outcome — non-2xx, a thrown fetch, a non-boolean field, an unmounted race —
 * leaves it false. There is deliberately no `loading` flag: "not yet known"
 * and "not available" must render identically, so a gated panel never
 * flashes into existence after the rest of the app has already painted.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { Capabilities } from '../types';

const CLOSED: Capabilities = { sensorSimulation: false };

export function useCapabilities(): Capabilities {
  const [capabilities, setCapabilities] = useState<Capabilities>(CLOSED);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/capabilities')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as { sensorSimulation?: unknown };
        if (!cancelled && body.sensorSimulation === true) {
          setCapabilities({ sensorSimulation: true });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}
