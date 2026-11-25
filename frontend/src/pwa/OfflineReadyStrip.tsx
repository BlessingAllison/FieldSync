import { AnimatePresence, m } from 'framer-motion';
import { CheckCircle2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/i18n';

import { useUpdateStore } from './update-store';

const VISIBLE_MS = 6_000;

/** First-install confirmation: an in-flow strip (never covers content), self-dismissing. */
export function OfflineReadyStrip() {
  const { t } = useT();
  const offlineReady = useUpdateStore((s) => s.offlineReady);
  const [dismissed, setDismissed] = useState(false);
  const visible = offlineReady && !dismissed;

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setDismissed(true), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <m.div
          key="offline-ready"
          role="status"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden border-b bg-status-sent-bg text-status-sent"
        >
          <div className="container flex items-center gap-2 py-2 text-sm font-semibold">
            <CheckCircle2 aria-hidden className="size-4 shrink-0" />
            <span className="flex-1">{t('update.offlineReady')}</span>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label={t('update.dismiss')}
              className="flex size-10 items-center justify-center rounded-md hover:bg-black/5"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
