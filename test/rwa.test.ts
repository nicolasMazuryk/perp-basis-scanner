import { describe, expect, it } from 'vitest';
import { RWA_SYMBOLS } from '../src/rwa.js';

describe('RWA_SYMBOLS', () => {
  it('is a non-empty list', () => {
    expect(RWA_SYMBOLS.length).toBeGreaterThan(0);
  });

  it('are all upper-case USDT perps in normalized form', () => {
    for (const sym of RWA_SYMBOLS) {
      expect(sym).toBe(sym.toUpperCase());
      expect(sym).toMatch(/^[A-Z0-9]+USDT$/);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(RWA_SYMBOLS).size).toBe(RWA_SYMBOLS.length);
  });
});
