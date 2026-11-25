import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m } from 'framer-motion';
import { RefreshCw, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useLocation, useOutlet } from 'react-router-dom';

import { LinkIndicator } from '@/app/LinkIndicator';
import { NoticeBar } from '@/app/NoticeBar';
import { RouteAnnouncer } from '@/app/RouteAnnouncer';
import { isFocusRoute, navItems } from '@/app/nav';
import { useIdleLock } from '@/app/useIdleLock';
import { LockScreen } from '@/features/auth/LockScreen';
import { type MessageKey, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { APP_VERSION } from '@/core/version';
import { OfflineReadyStrip } from '@/pwa/OfflineReadyStrip';
import { UpdatePrompt } from '@/pwa/UpdatePrompt';
import { useApp } from '@/stores/app';
import { useNetwork } from '@/stores/network';
import { needsActionCount, useSync, waitingCount } from '@/stores/sync';

/** Keeps the exiting route's element on screen during its exit transition. */
function FrozenOutlet() {
  const outlet = useOutlet();
  const [frozen] = useState(outlet);
  return frozen;
}

function Badge({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <m.span
      key={count}
      initial={{ scale: 0.6 }}
      animate={{ scale: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 20 }}
      aria-hidden
      className={cn(
        'min-w-5 rounded-full bg-status-pending px-1.5 text-center text-xs font-bold leading-5 text-white dark:text-black',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </m.span>
  );
}

export function AppShell() {
  const { t } = useT();
  const online = useNetwork((s) => s.online);
  const { status, profile } = useApp();
  const counts = useSync((s) => s.counts);
  const location = useLocation();
  useIdleLock();

  const unlocked = status === 'unlocked';
  const focus = isFocusRoute(location.pathname);
  const queue = waitingCount(counts) + needsActionCount(counts);
  const items = navItems(profile?.role);

  return (
    <LazyMotion features={domAnimation} strict>
      {/* Honour the OS "reduce motion" setting (Motion ignores it by default). */}
      <MotionConfig reducedMotion="user">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:p-3"
        >
          {t('app.skipToContent')}
        </a>

        <header className="sticky top-0 z-30 border-b bg-primary text-primary-foreground">
          <div className="flex min-h-14 items-center justify-between gap-3 px-4 lg:px-6">
            <Link
              to="/"
              className="flex items-center gap-2 rounded-md text-lg font-bold tracking-tight"
            >
              <img src="/icon.svg" alt="" width={28} height={28} className="rounded-md" />
              {t('app.name')}
            </Link>
            <div className="flex items-center gap-2">
              {unlocked && queue > 0 && (
                <Link
                  to="/sync"
                  className="flex min-h-10 items-center gap-1.5 rounded-full bg-primary-foreground/15 px-3 text-sm font-semibold hover:bg-primary-foreground/25 lg:hidden"
                >
                  <RefreshCw aria-hidden className="size-4" />
                  <span>{t('nav.sync')}</span>
                  <Badge count={queue} />
                </Link>
              )}
              <LinkIndicator />
              {unlocked && profile && (
                <span className="hidden items-center gap-2 border-l border-primary-foreground/30 pl-3 text-sm lg:flex">
                  <UserRound aria-hidden className="size-4" />
                  <span className="font-semibold">{profile.display_name}</span>
                </span>
              )}
            </div>
          </div>
        </header>

        <OfflineReadyStrip />
        <AnimatePresence initial={false}>
          {!online && (
            <m.div
              key="offline"
              role="status"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden border-b border-status-pending/40 bg-status-pending-bg text-status-pending"
            >
              <div className="px-4 py-3 lg:px-6">
                <p className="font-semibold">{t('network.offline.title')}</p>
                <p className="text-sm">{t('network.offline.body')}</p>
              </div>
            </m.div>
          )}
        </AnimatePresence>
        <NoticeBar />

        <div className="lg:flex">
          {unlocked && (
            <nav
              aria-label={t('nav.main')}
              className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-64 shrink-0 flex-col gap-1 border-r bg-card p-3 lg:flex"
            >
              {items.map(({ to, label, Icon, badge }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-tap items-center gap-3 rounded-lg px-3 font-semibold',
                      isActive
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )
                  }
                >
                  <Icon aria-hidden className="size-5" />
                  <span className="flex-1">{t(label)}</span>
                  {badge && <Badge count={queue} />}
                  {badge && queue > 0 && <span className="sr-only">({queue})</span>}
                </NavLink>
              ))}
              {profile && (
                <p className="mt-auto rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                  <span className="block font-semibold text-foreground">
                    {profile.display_name}
                  </span>
                  {t(`settings.role.${profile.role}` as MessageKey)}
                  {profile.county ? ` · ${profile.county.name}` : ''}
                </p>
              )}
            </nav>
          )}

          <div className="min-w-0 flex-1">
            <main
              id="main"
              tabIndex={-1}
              className={cn(
                'px-4 pt-5 focus:outline-none lg:px-8 lg:pt-8',
                unlocked && !focus ? 'pb-28 lg:pb-12' : focus ? 'pb-40 lg:pb-32' : 'pb-12',
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                <m.div
                  key={location.pathname}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                >
                  <FrozenOutlet />
                </m.div>
              </AnimatePresence>
            </main>
            {!focus && (
              <footer
                className={cn(
                  'px-4 text-center text-sm text-muted-foreground',
                  unlocked ? 'pb-28 lg:pb-6' : 'pb-6',
                )}
              >
                {t('app.footer', { version: APP_VERSION })}
              </footer>
            )}
          </div>
        </div>

        {unlocked && !focus && (
          <nav
            aria-label={t('nav.main')}
            className="fixed inset-x-0 bottom-0 z-30 border-t bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
          >
            <ul className="mx-auto flex max-w-2xl">
              {items.map(({ to, label, Icon, badge }) => (
                <li key={to} className="flex-1">
                  <NavLink
                    to={to}
                    end={to === '/'}
                    className={({ isActive }) =>
                      cn(
                        'relative flex min-h-16 flex-col items-center justify-center gap-0.5 px-1 text-xs font-semibold sm:text-sm',
                        isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <m.span
                            layoutId="tab-indicator"
                            aria-hidden
                            className="absolute inset-x-3 top-0 h-1 rounded-b-full bg-primary"
                          />
                        )}
                        <span className="relative">
                          <Icon aria-hidden className="size-6" />
                          {badge && <Badge count={queue} className="absolute -right-3 -top-2" />}
                        </span>
                        <span className="max-w-full truncate">{t(label)}</span>
                        {badge && queue > 0 && <span className="sr-only">({queue})</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <RouteAnnouncer />
        <LockScreen />
        <UpdatePrompt />
      </MotionConfig>
    </LazyMotion>
  );
}
