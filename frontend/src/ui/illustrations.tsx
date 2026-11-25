/**
 * Theme-aware spot illustrations (inline SVG, ~1 KB each, decorative → aria-hidden).
 * Colours come from design tokens via Tailwind fill/stroke utilities, so they follow the
 * Light, Dark and Outdoor themes automatically. No raster images (ADD §4).
 */
import type { SVGProps } from 'react';

import { cn } from '@/lib/cn';

type Props = SVGProps<SVGSVGElement> & { className?: string };

function Frame({ className, children, ...rest }: Props) {
  return (
    <svg
      viewBox="0 0 160 120"
      aria-hidden
      focusable="false"
      className={cn('h-auto w-40', className)}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** A phone holding saved forms (saving works offline). */
export function PhoneFormsArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="52" ry="6" className="fill-muted" />
      <rect
        x="52"
        y="10"
        width="56"
        height="96"
        rx="10"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      <rect x="70" y="16" width="20" height="4" rx="2" className="fill-muted-foreground" />
      {[30, 50, 70].map((y, i) => (
        <g key={y}>
          <rect
            x="60"
            y={y}
            width="40"
            height="14"
            rx="4"
            className={i === 2 ? 'fill-secondary' : 'fill-muted'}
          />
          <rect x="65" y={y + 5} width="20" height="4" rx="2" className="fill-muted-foreground" />
          <circle
            cx="93"
            cy={y + 7}
            r="3.5"
            className={i === 2 ? 'fill-status-pending' : 'fill-status-sent'}
          />
        </g>
      ))}
      <circle cx="116" cy="28" r="14" className="fill-primary" />
      <path
        d="M109 28l5 5 9-10"
        fill="none"
        className="stroke-primary-foreground"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Frame>
  );
}

/** No network: the cloud is unreachable but forms stay safe on the phone. */
export function OfflineArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="52" ry="6" className="fill-muted" />
      <path
        d="M44 52a18 18 0 0 1 34-8 14 14 0 0 1 24 10 12 12 0 0 1-2 24H48a14 14 0 0 1-4-26z"
        className="fill-muted stroke-muted-foreground"
        strokeWidth="2.5"
        strokeDasharray="6 5"
      />
      <path
        d="M58 40l46 46"
        className="stroke-status-failed"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <rect
        x="96"
        y="56"
        width="34"
        height="50"
        rx="7"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      <rect x="103" y="66" width="20" height="5" rx="2.5" className="fill-status-pending" />
      <rect x="103" y="76" width="20" height="5" rx="2.5" className="fill-status-pending" />
      <path
        d="M108 92h10M113 87v10"
        className="stroke-primary"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </Frame>
  );
}

/** Forms travelling from phone to server (sending / sent). */
export function SyncArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="60" ry="6" className="fill-muted" />
      <rect
        x="14"
        y="40"
        width="34"
        height="58"
        rx="7"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      <rect x="21" y="52" width="20" height="6" rx="3" className="fill-status-sent" />
      <rect x="21" y="64" width="20" height="6" rx="3" className="fill-status-pending" />
      <rect
        x="108"
        y="44"
        width="40"
        height="54"
        rx="6"
        className="fill-secondary stroke-foreground"
        strokeWidth="3"
      />
      <rect x="116" y="56" width="24" height="5" rx="2.5" className="fill-primary" />
      <rect x="116" y="68" width="24" height="5" rx="2.5" className="fill-primary" />
      <rect x="116" y="80" width="24" height="5" rx="2.5" className="fill-primary" />
      <path
        d="M56 62c14-16 34-16 46 0"
        fill="none"
        className="stroke-primary"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray="2 7"
      />
      <path
        d="M96 54l7 8-10 3"
        fill="none"
        className="stroke-primary"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="68" y="44" width="16" height="12" rx="3" className="fill-status-sending" />
    </Frame>
  );
}

/** Labels/colours: the five sync states as chips. */
export function LabelsArt(props: Props) {
  const chips = [
    'fill-status-pending',
    'fill-status-sending',
    'fill-status-sent',
    'fill-status-failed',
    'fill-status-conflict',
  ];
  return (
    <Frame {...props}>
      {chips.map((cls, i) => (
        <g key={cls}>
          <rect
            x={22 + (i % 2) * 62}
            y={14 + Math.floor(i / 2) * 32}
            width="54"
            height="22"
            rx="11"
            className="fill-card stroke-border"
            strokeWidth="2"
          />
          <circle cx={36 + (i % 2) * 62} cy={25 + Math.floor(i / 2) * 32} r="6" className={cls} />
          <rect
            x={47 + (i % 2) * 62}
            y={22 + Math.floor(i / 2) * 32}
            width="22"
            height="6"
            rx="3"
            className="fill-muted-foreground"
          />
        </g>
      ))}
    </Frame>
  );
}

/** Two versions of one form: a conflict to resolve. */
export function ConflictArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="52" ry="6" className="fill-muted" />
      <rect
        x="22"
        y="22"
        width="50"
        height="70"
        rx="6"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      <rect
        x="88"
        y="22"
        width="50"
        height="70"
        rx="6"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      {[36, 50, 64].map((y) => (
        <g key={y}>
          <rect x="30" y={y} width="34" height="5" rx="2.5" className="fill-muted-foreground" />
          <rect
            x="96"
            y={y}
            width="34"
            height="5"
            rx="2.5"
            className={y === 50 ? 'fill-status-conflict' : 'fill-muted-foreground'}
          />
        </g>
      ))}
      <rect x="30" y="50" width="34" height="5" rx="2.5" className="fill-status-conflict" />
      <circle cx="80" cy="96" r="12" className="fill-primary" />
      <path
        d="M74 96h12M80 90v12"
        className="stroke-primary-foreground"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </Frame>
  );
}

/** A locked phone (encryption, lost phone). */
export function LockedPhoneArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="52" ry="6" className="fill-muted" />
      <rect
        x="52"
        y="10"
        width="56"
        height="96"
        rx="10"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      <rect x="64" y="52" width="32" height="26" rx="5" className="fill-primary" />
      <path
        d="M70 52v-8a10 10 0 0 1 20 0v8"
        fill="none"
        className="stroke-primary"
        strokeWidth="4"
      />
      <circle cx="80" cy="63" r="3.5" className="fill-primary-foreground" />
      <rect x="78.5" y="64" width="3" height="8" rx="1.5" className="fill-primary-foreground" />
    </Frame>
  );
}

/** Two people, one phone, separate locks. */
export function SharedPhoneArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="60" ry="6" className="fill-muted" />
      <circle
        cx="34"
        cy="44"
        r="12"
        className="fill-secondary stroke-foreground"
        strokeWidth="2.5"
      />
      <path
        d="M16 92a18 18 0 0 1 36 0"
        className="fill-secondary stroke-foreground"
        strokeWidth="2.5"
      />
      <circle cx="126" cy="44" r="12" className="fill-muted stroke-foreground" strokeWidth="2.5" />
      <path
        d="M108 92a18 18 0 0 1 36 0"
        className="fill-muted stroke-foreground"
        strokeWidth="2.5"
      />
      <rect
        x="64"
        y="30"
        width="32"
        height="62"
        rx="7"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      <rect x="70" y="44" width="9" height="12" rx="2" className="fill-primary" />
      <rect x="81" y="44" width="9" height="12" rx="2" className="fill-muted-foreground" />
    </Frame>
  );
}

/** Install to home screen. */
export function InstallArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="52" ry="6" className="fill-muted" />
      <rect
        x="52"
        y="10"
        width="56"
        height="96"
        rx="10"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect
          key={i}
          x={62 + (i % 3) * 13}
          y={26 + Math.floor(i / 3) * 14}
          width="9"
          height="9"
          rx="2.5"
          className="fill-muted"
        />
      ))}
      <rect x="62" y="56" width="22" height="22" rx="5" className="fill-primary" />
      <path
        d="M73 61v12M67 68l6 6 6-6"
        fill="none"
        className="stroke-primary-foreground"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Frame>
  );
}

/** Empty clipboard: nothing here yet. */
export function EmptyArt(props: Props) {
  return (
    <Frame {...props}>
      <ellipse cx="80" cy="110" rx="46" ry="6" className="fill-muted" />
      <rect
        x="48"
        y="16"
        width="64"
        height="88"
        rx="8"
        className="fill-card stroke-foreground"
        strokeWidth="3"
      />
      <rect
        x="64"
        y="10"
        width="32"
        height="14"
        rx="5"
        className="fill-secondary stroke-foreground"
        strokeWidth="3"
      />
      <rect x="60" y="40" width="40" height="5" rx="2.5" className="fill-muted" />
      <rect x="60" y="52" width="30" height="5" rx="2.5" className="fill-muted" />
      <rect x="60" y="64" width="36" height="5" rx="2.5" className="fill-muted" />
      <circle cx="104" cy="84" r="14" className="fill-primary" />
      <path
        d="M98 84h12M104 78v12"
        className="stroke-primary-foreground"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </Frame>
  );
}

export function EmptyState({
  Art = EmptyArt,
  title,
  body,
  children,
}: {
  Art?: (props: Props) => JSX.Element;
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/60 px-5 py-8 text-center">
      <Art className="w-32" />
      <p className="text-lg font-semibold">{title}</p>
      {body && <p className="max-w-sm text-muted-foreground">{body}</p>}
      {children}
    </div>
  );
}
