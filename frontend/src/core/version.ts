declare const __APP_VERSION__: string | undefined;

/** Injected by Vite `define` (package.json version); sent as X-App-Version. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
