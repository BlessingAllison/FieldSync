import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/** Colours are CSS variables (src/styles/index.css) so light/dark/outdoor themes swap at runtime. */
const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Dark mode is driven by tokens (system preference or [data-theme="dark"]); the `dark:`
  // variant is only for the rare non-token tweak and follows the explicit attribute.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1200px' } },
    extend: {
      colors: {
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        background: token('background'),
        foreground: token('foreground'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground') },
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        // Sync-state semantics (always paired with an icon + text, never colour alone).
        status: {
          pending: token('status-pending'),
          'pending-bg': token('status-pending-bg'),
          sending: token('status-sending'),
          'sending-bg': token('status-sending-bg'),
          sent: token('status-sent'),
          'sent-bg': token('status-sent-bg'),
          failed: token('status-failed'),
          'failed-bg': token('status-failed-bg'),
          conflict: token('status-conflict'),
          'conflict-bg': token('status-conflict-bg'),
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      minHeight: { tap: '3rem' },
      minWidth: { tap: '3rem' },
      fontFamily: {
        // System fonts only: zero font downloads on metered 3G (ADD §4).
        sans: [
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          '"Noto Sans"',
          'Ubuntu',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [animate],
} satisfies Config;
