import { describe, expect, it } from 'vitest';

import { classifyLink, type LinkInputs, SAMPLE_FRESH_MS, smoothRtt, statusFromRtt } from './link-quality';

const base: LinkInputs = {
  online: true,
  netInfo: null,
  serverRttMs: null,
  lastSampleAt: null,
  consecutiveFailures: 0,
  now: 1_000_000,
};

describe('network meter classification', () => {
  it('offline wins over everything', () => {
    expect(classifyLink({ ...base, online: false, serverRttMs: 50, lastSampleAt: base.now })).toBe(
      'offline',
    );
  });

  it('online but the server never answers = no server (captive Wi-Fi, dead cell)', () => {
    expect(classifyLink({ ...base, consecutiveFailures: 1, serverRttMs: 100, lastSampleAt: base.now })).toBe('excellent');
    expect(classifyLink({ ...base, consecutiveFailures: 2, netInfo: { effectiveType: '4g' } })).toBe(
      'no_server',
    );
  });

  it('a fresh measured round trip beats the browser estimate', () => {
    const fresh = { ...base, lastSampleAt: base.now - 10_000, netInfo: { effectiveType: '4g' } };
    expect(classifyLink({ ...fresh, serverRttMs: 2_500 })).toBe('poor');
    expect(classifyLink({ ...fresh, serverRttMs: 1_200 })).toBe('fair');
    expect(classifyLink({ ...fresh, serverRttMs: 450 })).toBe('good');
    expect(classifyLink({ ...fresh, serverRttMs: 120 })).toBe('excellent');
  });

  it('a stale sample falls back to the browser estimate, then to "checking"', () => {
    const stale = { ...base, serverRttMs: 120, lastSampleAt: base.now - SAMPLE_FRESH_MS - 1 };
    expect(classifyLink({ ...stale, netInfo: { effectiveType: '2g' } })).toBe('poor');
    expect(classifyLink({ ...stale, netInfo: { effectiveType: '3g' } })).toBe('fair');
    expect(classifyLink({ ...stale, netInfo: { effectiveType: '4g', rttMs: 300 } })).toBe('good');
    expect(
      classifyLink({ ...stale, netInfo: { effectiveType: '4g', rttMs: 50, downlinkMbps: 10 } }),
    ).toBe('excellent');
    expect(classifyLink({ ...stale, netInfo: { rttMs: 1_500 } })).toBe('fair');
    expect(classifyLink(stale)).toBe('checking');
  });

  it('thresholds and smoothing', () => {
    expect([299, 300, 799, 800, 1_999, 2_000].map(statusFromRtt)).toEqual([
      'excellent',
      'good',
      'good',
      'fair',
      'fair',
      'poor',
    ]);
    expect(smoothRtt(null, 400)).toBe(400);
    expect(smoothRtt(400, 1_400)).toBe(700); // one slow request moves it, but does not own it
  });
});
