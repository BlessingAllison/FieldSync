import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { useT } from '@/i18n';

/**
 * SPA navigation for assistive technology (WCAG 2.4.2, 2.4.3): after each route change set
 * the document title from the page's <h1>, move focus to that heading and announce it.
 * Waits briefly for lazy routes to render their heading.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const { t } = useT();
  const [message, setMessage] = useState('');
  const first = useRef(true);
  /** The heading of the page we navigated FROM: during the exit transition it is still mounted. */
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const settle = () => {
      if (cancelled) return;
      const found = document.querySelector<HTMLElement>('main h1');
      const heading = found && found !== previous.current && found.isConnected ? found : null;
      if (!heading && tries < 30) {
        tries += 1;
        window.setTimeout(settle, 50);
        return;
      }
      previous.current = heading;
      const title = heading?.textContent?.trim();
      document.title = title ? `${title} · ${t('app.name')}` : t('app.name');
      if (first.current) {
        first.current = false; // initial load: leave focus where the browser put it
        return;
      }
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: false });
        setMessage(title ?? '');
      }
    };
    settle();
    return () => {
      cancelled = true;
    };
  }, [pathname, t]);

  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  );
}
