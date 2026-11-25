import {
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Smartphone,
  Trash2,
  UserRound,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

import { lock, setPin, signOutAndErase, switchUser } from '@/app/runtime';
import { APP_VERSION } from '@/core/version';
import type { ThemePreference } from '@/core/db/schema';
import { type MessageKey, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { isReviewer } from '@/lib/roles';
import { useApp } from '@/stores/app';
import { usePreferences } from '@/stores/preferences';
import { useSync, waitingCount } from '@/stores/sync';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { ConfirmDialog } from '@/ui/dialog';
import { FieldShell, TextInput } from '@/ui/form-controls';

import { LanguagePicker } from './LanguagePicker';

/** Swatches preview each theme with literal colours (they must not follow the active theme). */
const THEMES: Array<{ value: ThemePreference; swatch: string }> = [
  {
    value: 'system',
    swatch:
      '[--sw-bar:#0b4f55] [--sw-bg:linear-gradient(90deg,#f6f6f1_50%,#0d1416_50%)] [--sw-ink:#5f6b70]',
  },
  { value: 'light', swatch: '[--sw-bar:#0b4f55] [--sw-bg:#f6f6f1] [--sw-ink:#0e1a1d]' },
  { value: 'dark', swatch: '[--sw-bar:#76d3d3] [--sw-bg:#0d1416] [--sw-ink:#f2f2ec]' },
  { value: 'outdoor', swatch: '[--sw-bar:#002b2f] [--sw-bg:#ffffff] [--sw-ink:#000000]' },
];

export default function SettingsPage() {
  const { t } = useT();
  const { theme, setTheme } = usePreferences();
  const { profile, hasPin } = useApp();
  const counts = useSync((s) => s.counts);
  const unsent = waitingCount(counts) + counts.FAILED + counts.CONFLICT;
  const [pin, setPinValue] = useState('');
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseConfirm, setEraseConfirm] = useState('');

  const savePin = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(pin)) {
      setPinMessage(t('settings.pin.invalid'));
      return;
    }
    await setPin(pin);
    setPinValue('');
    setPinMessage(t('settings.pin.saved'));
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.account')}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <UserRound aria-hidden className="size-8 text-muted-foreground" />
          <div>
            <p className="text-lg font-semibold">{profile?.display_name}</p>
            <p className="text-muted-foreground">
              {profile?.username} ·{' '}
              {profile ? t(`settings.role.${profile.role}` as MessageKey) : ''}
              {profile?.county ? ` · ${profile.county.name}` : ''}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.appearance')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div
            role="radiogroup"
            aria-label={t('settings.appearance')}
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {THEMES.map(({ value, swatch }) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer flex-col gap-2 rounded-lg border-2 p-2 text-sm font-semibold',
                  theme === value
                    ? 'border-primary bg-secondary text-secondary-foreground'
                    : 'border-input bg-card hover:bg-accent',
                )}
              >
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={theme === value}
                  onChange={() => void setTheme(value)}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn('flex h-12 overflow-hidden rounded-md border', swatch)}
                >
                  <span className="w-1/3 bg-[var(--sw-bar)]" />
                  <span className="flex flex-1 flex-col justify-center gap-1 p-1.5 [background:var(--sw-bg)]">
                    <span className="h-1.5 w-3/4 rounded bg-[var(--sw-ink)]" />
                    <span className="h-1.5 w-1/2 rounded bg-[var(--sw-ink)] opacity-60" />
                  </span>
                </span>
                {t(`settings.theme.${value}`)}
              </label>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{t('settings.theme.help')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.language')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LanguagePicker />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={(e) => void savePin(e)} className="flex flex-col gap-3">
            <FieldShell
              id="new-pin"
              label={t('settings.pin.label')}
              help={t('settings.pin.help')}
              error={pinMessage && pinMessage !== t('settings.pin.saved') ? pinMessage : undefined}
            >
              <TextInput
                id="new-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
                aria-describedby="new-pin-help"
              />
            </FieldShell>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">
                <KeyRound aria-hidden />
                {t('settings.pin.set')}
              </Button>
              {hasPin && (
                <Button
                  variant="outline"
                  onClick={() => void setPin(null).then(() => setPinMessage(null))}
                >
                  {t('settings.pin.remove')}
                </Button>
              )}
            </div>
            {pinMessage === t('settings.pin.saved') && (
              <p role="status" className="font-medium text-status-sent">
                {pinMessage}
              </p>
            )}
          </form>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void lock()}>
              <Lock aria-hidden />
              {t('settings.lockNow')}
            </Button>
            <Button variant="outline" onClick={() => void switchUser()}>
              <LogOut aria-hidden />
              {t('settings.switchUser')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.tools')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {isReviewer(profile?.role) && (
            <Link
              to="/supervisor"
              className="flex min-h-tap items-center gap-3 rounded-lg border px-4 font-semibold hover:bg-accent"
            >
              <LayoutDashboard aria-hidden className="size-5" />
              {t('settings.dashboard')}
            </Link>
          )}
          <Link
            to="/device-check"
            className="flex min-h-tap items-center gap-3 rounded-lg border px-4 font-semibold hover:bg-accent"
          >
            <Smartphone aria-hidden className="size-5" />
            {t('settings.deviceCheck')}
          </Link>
          <Link
            to="/simulator"
            className="flex min-h-tap items-center gap-3 rounded-lg border px-4 font-semibold hover:bg-accent"
          >
            <FlaskConical aria-hidden className="size-5" />
            {t('settings.simulator')}
          </Link>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">{t('settings.dangerZone')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setEraseOpen(true)}>
            <Trash2 aria-hidden />
            {t('settings.erase')}
          </Button>
        </CardContent>
      </Card>

      <p className="text-center text-sm text-muted-foreground">
        {t('settings.version', { version: APP_VERSION })}
      </p>

      <ConfirmDialog
        open={eraseOpen}
        title={t('settings.eraseTitle')}
        confirmLabel={t('settings.eraseConfirm')}
        cancelLabel={t('common.cancel')}
        destructive
        confirmDisabled={unsent > 0 && eraseConfirm !== String(unsent)}
        onCancel={() => {
          setEraseOpen(false);
          setEraseConfirm('');
        }}
        onConfirm={() => {
          setEraseOpen(false);
          void signOutAndErase();
        }}
      >
        {unsent === 0 ? (
          <p>{t('settings.eraseBody.none')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="font-semibold text-destructive">
              {t('settings.eraseBody.some', { count: unsent })}
            </p>
            <FieldShell id="erase-confirm" label={t('settings.eraseConfirmLabel')}>
              <TextInput
                id="erase-confirm"
                inputMode="numeric"
                value={eraseConfirm}
                onChange={(e) => setEraseConfirm(e.target.value)}
              />
            </FieldShell>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
