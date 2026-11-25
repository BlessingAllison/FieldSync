import { Lock } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { switchUser, unlockUiWithPassword, unlockWithPin } from '@/app/runtime';
import { useT } from '@/i18n';
import { useApp } from '@/stores/app';
import { Button } from '@/ui/button';
import { FieldShell, TextInput } from '@/ui/form-controls';

/** Idle UI lock overlay. The session handle is still valid; PIN or password re-opens. */
export function LockScreen() {
  const { t } = useT();
  const { uiLocked, hasPin, profile } = useApp();
  const [usePassword, setUsePassword] = useState(false);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Modal dialog: move focus into it when it opens (WAI-ARIA dialog pattern).
  useEffect(() => {
    if (uiLocked) inputRef.current?.focus();
  }, [uiLocked, usePassword]);
  if (!uiLocked) return null;
  const pinMode = hasPin && !usePassword;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (pinMode) {
        const result = await unlockWithPin(secret);
        if (result === 'wrong') setError(t('lock.wrongPin'));
      } else if (!(await unlockUiWithPassword(secret))) {
        setError(t('lock.wrongPassword'));
      }
    } finally {
      setBusy(false);
      setSecret('');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4"
    >
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="rounded-full bg-secondary p-4 text-secondary-foreground">
            <Lock aria-hidden className="size-8" />
          </span>
          <h1 id="lock-title" className="text-2xl font-bold">
            {t('lock.title')}
          </h1>
          <p className="text-muted-foreground">{profile?.display_name}</p>
        </div>
        <FieldShell
          id="lock-secret"
          label={pinMode ? t('lock.pinPrompt') : t('lock.passwordPrompt')}
          error={error ?? undefined}
        >
          <TextInput
            id="lock-secret"
            ref={inputRef}
            type="password"
            inputMode={pinMode ? 'numeric' : 'text'}
            autoComplete={pinMode ? 'off' : 'current-password'}
            maxLength={pinMode ? 6 : 256}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            invalid={Boolean(error)}
            aria-describedby={error ? 'lock-secret-error' : undefined}
            className="text-center text-2xl tracking-widest"
          />
        </FieldShell>
        <Button type="submit" size="lg" disabled={busy || secret.length === 0}>
          {t('lock.unlock')}
        </Button>
        {pinMode && (
          <Button variant="ghost" onClick={() => setUsePassword(true)}>
            {t('lock.usePassword')}
          </Button>
        )}
        <Button variant="ghost" onClick={() => void switchUser()}>
          {t('settings.switchUser')}
        </Button>
      </form>
    </div>
  );
}
