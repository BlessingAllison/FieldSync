/**
 * Facilities by sync health — a tall segmented bar (dataviz spec: ≤ 28 px, 4 px corners,
 * 2 px surface gap, share printed inside only when it fits, legend in block order with
 * icon + label so state is never colour alone; hover/focus tooltip; click filters).
 * Fill colours are the validated --viz-* tokens, not the darker --status-* text tokens.
 */
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

import { HEALTH_ORDER, type Health } from './health';

const VIZ: Record<Health, { fill: string; ink: string; Icon: LucideIcon }> = {
  stale: { fill: 'var(--viz-critical)', ink: 'var(--viz-critical-ink)', Icon: XCircle },
  degraded: { fill: 'var(--viz-warning)', ink: 'var(--viz-warning-ink)', Icon: AlertTriangle },
  unknown: { fill: 'var(--viz-unknown)', ink: 'var(--viz-unknown-ink)', Icon: CircleHelp },
  healthy: { fill: 'var(--viz-good)', ink: 'var(--viz-good-ink)', Icon: CheckCircle2 },
};

/** Minimum block share that leaves room for an inside label like "33%". */
const LABEL_MIN_SHARE = 0.12;

export function HealthBar({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<Health, number>;
  selected: Health | 'all';
  onSelect: (health: Health | 'all') => void;
}) {
  const { t } = useT();
  const [active, setActive] = useState<Health | null>(null);
  const total = HEALTH_ORDER.reduce((sum, h) => sum + counts[h], 0);
  if (total === 0) return null;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  const label = (h: Health) => t(`dash.health.${h}`);
  const describe = (h: Health) =>
    t('dash.segment', { label: label(h), count: counts[h], total, share: pct(counts[h]) });

  return (
    <figure className="flex flex-col gap-3" aria-labelledby="health-bar-title">
      <figcaption id="health-bar-title" className="font-semibold">
        {t('dash.distribution')}
      </figcaption>
      <div className="relative">
        <div className="flex h-7 w-full gap-0.5" role="group" aria-label={t('dash.distribution')}>
          {HEALTH_ORDER.filter((h) => counts[h] > 0).map((h) => {
            const share = counts[h] / total;
            const { fill, ink } = VIZ[h];
            return (
              <button
                key={h}
                type="button"
                aria-label={`${describe(h)}. ${t('dash.segmentAction')}`}
                aria-pressed={selected === h}
                onClick={() => onSelect(selected === h ? 'all' : h)}
                onMouseEnter={() => setActive(h)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(h)}
                onBlur={() => setActive(null)}
                style={{ flexGrow: counts[h], backgroundColor: fill, color: ink }}
                className={cn(
                  'flex min-w-2 basis-0 items-center rounded px-2 text-sm font-bold',
                  // Selection = outline ring; never dim the others (opacity would fail label contrast).
                  selected === h && 'ring-[3px] ring-foreground ring-offset-2 ring-offset-card',
                )}
              >
                {share >= LABEL_MIN_SHARE && <span aria-hidden>{pct(counts[h])}</span>}
              </button>
            );
          })}
        </div>
        {active && (
          <p
            role="tooltip"
            className="pointer-events-none absolute -top-11 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border bg-card px-3 py-1.5 text-sm font-medium shadow-md"
          >
            {describe(active)}
          </p>
        )}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {HEALTH_ORDER.map((h) => {
          const { fill, Icon } = VIZ[h];
          return (
            <li key={h} className="flex items-center gap-1.5">
              <span aria-hidden className="size-3 rounded-sm" style={{ backgroundColor: fill }} />
              <Icon aria-hidden className="size-4 text-muted-foreground" />
              <span className="font-medium">{label(h)}</span>
              <span className="text-muted-foreground">{counts[h]}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
