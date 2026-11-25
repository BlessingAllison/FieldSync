/**
 * Route-level error boundary. Its main job is a lazy screen whose chunk failed to download
 * (first visit, signal lost before the SW finished precaching). Answers and saved forms
 * live in IndexedDB, so a reload loses nothing; the message says so.
 */
import { useEffect } from 'react';
import { useRouteError } from 'react-router-dom';

import { useT } from '@/i18n';
import { Button } from '@/ui/button';
import { EmptyState, OfflineArt } from '@/ui/illustrations';

export function RouteError() {
  const error = useRouteError();
  const { t } = useT();
  useEffect(() => {
    // Diagnostics only: never contains form content (rendering errors carry component names).
    console.error('route error', error instanceof Error ? error.name : typeof error);
  }, [error]);
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-4">
      <EmptyState Art={OfflineArt} title={t('routeError.title')} body={t('routeError.body')}>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>{t('routeError.reload')}</Button>
          <Button variant="secondary" onClick={() => window.location.assign('/home')}>
            {t('routeError.home')}
          </Button>
        </div>
      </EmptyState>
    </main>
  );
}
