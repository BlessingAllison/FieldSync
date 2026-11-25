/**
 * Layout-matching placeholders (ADD §16.4): each mirrors the real screen's structure so
 * nothing jumps when content arrives. Decorative to assistive tech; the container announces
 * busy state.
 */
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
    />
  );
}

function Busy({ children, className }: { children: React.ReactNode; className?: string }) {
  const { t } = useT();
  return (
    <div className={className} aria-busy="true">
      <span className="sr-only" role="status">
        {t('common.loading')}
      </span>
      {children}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <Busy className="mx-auto flex max-w-2xl flex-col gap-4">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </Busy>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Busy className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
      ))}
    </Busy>
  );
}

export function HomeSkeleton() {
  return (
    <Busy className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-5">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-6 w-40" />
        <ListSkeleton rows={3} />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    </Busy>
  );
}

export function DashboardSkeleton() {
  return (
    <Busy className="mx-auto flex max-w-6xl flex-col gap-5">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-56 rounded-lg" />
        ))}
      </div>
    </Busy>
  );
}
