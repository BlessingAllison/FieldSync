import { m } from 'framer-motion';
import { Loader2, Lock, RefreshCw, ShieldCheck, UserRound, WifiOff } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { signIn, switchUser } from '@/app/runtime';
import type { SignInError } from '@/core/auth/session';
import { type MessageKey, useT } from '@/i18n';
import { useApp } from '@/stores/app';
import { useNetwork } from '@/stores/network';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { FieldShell, TextInput } from '@/ui/form-controls';
import { SyncArt } from '@/ui/illustrations';

import { LanguagePicker } from '../settings/LanguagePicker';

export function LoginPage() {
  const { t } = useT();
  const { status, lockedUser, knownUsers } = useApp();
  const online = useNetwork((s) => s.online);
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignInError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (lockedUser) setUsername(lockedUser.username);
  }, [lockedUser]);

  if (status === 'unlocked') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }
  if (status === 'booting') return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn(username, password);
      if (!result.ok) setError(result.error);
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  const errorText = error
    ? error.kind === 'too_many_attempts'
      ? t('login.error.too_many_attempts', { seconds: error.retryAfterSeconds })
      : t(`login.error.${error.kind}` as MessageKey)
    : undefined;

  return (
    <div className="mx-auto grid max-w-5xl items-start gap-10 pt-4 lg:grid-cols-2 lg:pt-12">
      <aside className="hidden flex-col gap-6 lg:flex" aria-hidden>
        <SyncArt className="w-72" />
        <ul className="flex flex-col gap-4 text-lg">
          {(
            [
              [WifiOff, 'login.feature.offline'],
              [Lock, 'login.feature.encrypted'],
              [RefreshCw, 'login.feature.sync'],
            ] as const
          ).map(([Icon, key]) => (
            <li key={key} className="flex items-center gap-3">
              <span className="rounded-lg bg-secondary p-2 text-secondary-foreground">
                <Icon className="size-5" />
              </span>
              {t(key)}
            </li>
          ))}
        </ul>
      </aside>
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/icon.svg" alt="" width={72} height={72} className="rounded-2xl shadow-md" />
          <h1 className="text-3xl font-bold tracking-tight">
            {lockedUser
              ? t('login.welcomeBack', { name: lockedUser.displayName })
              : t('login.title')}
          </h1>
          <p className="text-muted-foreground">{t('app.tagline')}</p>
        </div>

        {!online && (
          <p
            role="status"
            className="rounded-lg border border-status-pending/40 bg-status-pending-bg p-4 font-medium text-status-pending"
          >
            {knownUsers.length ? t('login.offlineOk') : t('login.firstTimeOffline')}
          </p>
        )}

        {!lockedUser && knownUsers.length > 0 && (
          <section aria-labelledby="known-users">
            <h2 id="known-users" className="mb-2 font-semibold text-muted-foreground">
              {t('login.knownUsers')}
            </h2>
            <div className="flex flex-col gap-2">
              {knownUsers.map((user) => (
                <button
                  key={user.userId}
                  type="button"
                  onClick={() => setUsername(user.username)}
                  aria-pressed={username === user.username}
                  className="flex min-h-tap items-center gap-3 rounded-lg border-2 border-input bg-card px-4 text-left font-medium hover:bg-accent aria-pressed:border-primary"
                >
                  <UserRound aria-hidden className="size-5" />
                  <span className="flex-1">{user.displayName}</span>
                  <span className="text-sm text-muted-foreground">{user.username}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <Card>
          <CardContent className="p-5">
            <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5" noValidate>
              {!lockedUser && (
                <FieldShell id="username" label={t('login.username')}>
                  <TextInput
                    id="username"
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </FieldShell>
              )}
              <FieldShell id="password" label={t('login.password')} error={errorText}>
                <TextInput
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  invalid={Boolean(error)}
                  aria-describedby={error ? 'password-error' : undefined}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </FieldShell>
              <Button type="submit" size="lg" disabled={busy || !username || !password}>
                {busy ? (
                  <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <ShieldCheck aria-hidden />
                )}
                {lockedUser ? t('login.unlock') : t('login.submit')}
              </Button>
              {busy && (
                <m.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  role="status"
                  className="text-center text-muted-foreground"
                >
                  {t('login.working')}
                </m.p>
              )}
            </form>
          </CardContent>
        </Card>

        {lockedUser && (
          <Button variant="ghost" onClick={() => void switchUser()}>
            {t('login.useAnother')}
          </Button>
        )}
        <LanguagePicker className="justify-center" />
      </div>
    </div>
  );
}
