export type Health = 'stale' | 'degraded' | 'unknown' | 'healthy';

/** Display order everywhere: worst first, "no data" before "healthy". */
export const HEALTH_ORDER: readonly Health[] = ['stale', 'degraded', 'unknown', 'healthy'];
