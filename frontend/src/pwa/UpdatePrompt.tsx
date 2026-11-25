import { AnimatePresence, m } from 'framer-motion';
import { useLocation } from 'react-router-dom';

import { isFocusRoute } from '@/app/nav';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useApp } from '@/stores/app';
import { Button } from '@/ui/button';

import { requestUpdate, useUpdateStore } from './update-store';

/** "Update ready" needs a decision → bottom sheet above the navigation bar. */
export function UpdatePrompt() {
  const { t } = useT();
  const { updateReady, holds, applyRequested } = useUpdateStore();
  const unlocked = useApp((s) => s.status === 'unlocked');
  const { pathname } = useLocation();
  const aboveNav = unlocked && !isFocusRoute(pathname);

  return (
    <AnimatePresence>
      {updateReady && (
        <m.div
          key="update-ready"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ duration: 0.2 }}
          className={cn(
            'pointer-events-none fixed inset-x-0 z-40 p-3 lg:left-64',
            aboveNav
              ? 'bottom-[calc(4rem+env(safe-area-inset-bottom))] lg:bottom-0'
              : 'bottom-[calc(5rem+env(safe-area-inset-bottom))]',
          )}
        >
          <div className="container pointer-events-auto flex max-w-2xl flex-col gap-3 rounded-lg border bg-card p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
            <p className="font-medium">
              {applyRequested && holds.size > 0 ? t('update.deferred') : t('update.ready')}
            </p>
            <Button onClick={requestUpdate} disabled={applyRequested}>
              {t('update.apply')}
            </Button>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
