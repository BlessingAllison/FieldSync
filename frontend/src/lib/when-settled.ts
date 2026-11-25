/**
 * Run `fn` once the page has finished loading and the main thread is idle (or after 5 s).
 * Used for work that must not compete with the first paint on a 2G/3G link.
 */
export function whenSettled(fn: () => void): void {
  const idle = () => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 5_000 });
    else setTimeout(fn, 1_000); // Safari
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}
