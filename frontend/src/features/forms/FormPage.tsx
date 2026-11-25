/**
 * Form runner (ADD §16.1): stepper, autosave on every change (encrypted, debounced 400 ms),
 * inline validation from the shared engine, showIf visibility, update hold while open.
 */
import { AnimatePresence, m } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, CloudOff, Loader2, Save, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { getVault, saveDraft, submitDraft, templateDefinition } from '@/app/runtime';
import type { DraftData } from '@/core/repositories/vault';
import { validate, visibleFieldIds } from '@/core/validation/engine';
import type { FieldValue, Payload, TemplateDefinition } from '@/core/validation/types';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { ruleMessage, tx } from '@/lib/template-text';
import { holdUpdates } from '@/pwa/update-store';
import { Button } from '@/ui/button';
import { PageSkeleton } from '@/ui/skeleton';

import { FieldRenderer } from './FieldRenderer';

const AUTOSAVE_MS = 400;

export function FormPage() {
  const { clientUuid = '' } = useParams();
  const translator = useT();
  const { t, plural, locale } = translator;
  const navigate = useNavigate();
  const [draft, setDraft] = useState<DraftData | null>(null);
  const [definition, setDefinition] = useState<TemplateDefinition | null>(null);
  const [missing, setMissing] = useState<'draft' | 'template' | null>(null);
  const [values, setValues] = useState<Payload>({});
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'storage_full'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<{ draft: DraftData | null; values: Payload; step: number }>({
    draft: null,
    values: {},
    step: 0,
  });

  // A service-worker update must never interrupt a form in progress (ADD §12.11).
  useEffect(() => holdUpdates(`draft:${clientUuid}`), [clientUuid]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const loaded = await getVault().getDraft(clientUuid);
      if (!alive) return;
      if (!loaded) {
        setMissing('draft');
        return;
      }
      const def = await templateDefinition(loaded.templateCode, loaded.templateVersion);
      if (!alive) return;
      if (!def) {
        setMissing('template');
        return;
      }
      setDraft(loaded);
      setDefinition(def);
      setValues(loaded.values);
      setStep(Math.min(loaded.step, def.steps.length - 1));
    })();
    return () => {
      alive = false;
    };
  }, [clientUuid]);

  const flush = useCallback(async (): Promise<'ok' | 'storage_full'> => {
    const { draft: current, values: v, step: s } = latest.current;
    if (!current) return 'ok';
    setSaveState('saving');
    const result = await saveDraft({ ...current, values: v, step: s });
    setSaveState(result === 'ok' ? 'saved' : 'storage_full');
    return result;
  }, []);

  useEffect(() => {
    latest.current = { draft, values, step };
  }, [draft, values, step]);

  // Flush pending autosave when leaving the page.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    },
    [flush],
  );

  const scheduleSave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush();
    }, AUTOSAVE_MS);
  };

  const setValue = (id: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [id]: value }));
    scheduleSave();
  };
  const touch = (id: string) => setTouched((prev) => new Set(prev).add(id));

  const result = useMemo(
    () => (definition ? validate(definition, values, new Date()) : null),
    [definition, values],
  );
  const visible = useMemo(
    () => (definition ? visibleFieldIds(definition, values) : new Set<string>()),
    [definition, values],
  );

  if (missing) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-dashed p-6 text-center">
        <p className="mb-4 text-lg">
          {missing === 'draft' ? t('form.notFound') : t('form.templateMissing')}
        </p>
        <Button onClick={() => navigate('/')}>{t('saved.home')}</Button>
      </div>
    );
  }
  if (!definition || !draft || !result) return <PageSkeleton />;

  const steps = definition.steps;
  const current = steps[step];
  if (!current) return <PageSkeleton />;
  const stepFields = current.fields.filter((f) => visible.has(f.id));
  const errorsFor = (id: string) => result.errors[id];
  const stepErrorIds = stepFields.filter((f) => errorsFor(f.id)).map((f) => f.id);
  const isLast = step === steps.length - 1;

  const goTo = (next: number) => {
    setStep(next);
    setShowAll(false);
    scheduleSave();
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const focusField = (id: string) => document.getElementById(`field-${id}`)?.focus();

  const next = () => {
    if (stepErrorIds.length > 0) {
      setShowAll(true);
      focusField(stepErrorIds[0] ?? '');
      return;
    }
    goTo(step + 1);
  };

  const save = async () => {
    if (stepErrorIds.length > 0) {
      setShowAll(true);
      focusField(stepErrorIds[0] ?? '');
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSubmitting(true);
    // Submit validates the STORED draft. If the latest answers could not be stored (phone
    // full), stop here: the stored copy is stale and would report phantom errors, and the
    // outbox write would fail anyway. The answers stay on screen; the notice says why.
    if ((await flush()) === 'storage_full') {
      setSubmitting(false);
      return;
    }
    const outcome = await submitDraft(clientUuid);
    setSubmitting(false);
    if (outcome.ok) {
      navigate(`/saved/${clientUuid}`, { replace: true });
    } else if (outcome.reason === 'invalid') {
      // e.g. a cross-rule pointing at an earlier step: go to the first step with an error.
      const firstBad = steps.findIndex((s) => s.fields.some((f) => outcome.errors[f.id]));
      if (firstBad >= 0) goTo(firstBad);
      setShowAll(true);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label={t('form.close')}
            className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-card hover:bg-accent"
          >
            <X aria-hidden className="size-5" />
          </button>
          <p className="truncate text-sm font-semibold text-muted-foreground">
            {tx(definition.title, locale)}
          </p>
        </div>
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
        >
          {saveState === 'saving' && (
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          )}
          {saveState === 'saved' && <Check aria-hidden className="size-4 text-status-sent" />}
          {saveState === 'storage_full' && (
            <CloudOff aria-hidden className="size-4 text-status-failed" />
          )}
          {saveState === 'saved'
            ? t('form.autosaved')
            : saveState === 'storage_full'
              ? t('notice.storage_full')
              : ''}
        </p>
      </div>

      {draft.baseVersion && (
        <p className="rounded-lg border border-status-conflict/40 bg-status-conflict-bg p-3 font-medium text-status-conflict">
          {t('form.editingSent', { version: draft.baseVersion })}
        </p>
      )}

      <nav aria-label={t('form.step', { current: step + 1, total: steps.length })}>
        <p className="mb-2 font-semibold">
          {t('form.step', { current: step + 1, total: steps.length })}
        </p>
        <ol className="flex gap-1.5">
          {steps.map((s, index) => {
            const done = index < step;
            const here = index === step;
            return (
              <li key={s.id} className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    'h-2 rounded-full transition-colors',
                    done || here ? 'bg-primary' : 'bg-muted',
                  )}
                />
                <span
                  aria-current={here ? 'step' : undefined}
                  className={cn(
                    'hidden truncate text-sm sm:block',
                    here ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {tx(s.title, locale)}
                </span>
                <span className="sr-only sm:hidden">{tx(s.title, locale)}</span>
              </li>
            );
          })}
        </ol>
      </nav>

      <AnimatePresence mode="wait" initial={false}>
        <m.section
          key={current.id}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          transition={{ duration: 0.16 }}
          aria-labelledby="step-title"
          className="flex flex-col gap-6"
        >
          <h1
            id="step-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-bold tracking-tight focus:outline-none"
          >
            {tx(current.title, locale)}
          </h1>

          {showAll && stepErrorIds.length > 0 && (
            <div
              role="alert"
              className="rounded-lg border-2 border-status-failed bg-status-failed-bg p-4 text-status-failed"
            >
              <p className="font-bold">{plural('form.fixErrors', stepErrorIds.length)}</p>
              <ul className="mt-1 list-disc pl-5">
                {stepFields
                  .filter((f) => errorsFor(f.id))
                  .map((f) => (
                    <li key={f.id}>
                      <a
                        href={`#field-${f.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          focusField(f.id);
                        }}
                        className="underline underline-offset-4"
                      >
                        {tx(f.label, locale)}
                      </a>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {stepFields.map((spec) => {
            const codes = errorsFor(spec.id);
            const show = Boolean(codes && (showAll || touched.has(spec.id)));
            const error =
              show && codes?.[0] ? ruleMessage(translator, codes[0], spec, definition) : undefined;
            return (
              <FieldRenderer
                key={spec.id}
                spec={spec}
                value={values[spec.id]}
                error={error}
                onChange={(v) => setValue(spec.id, v)}
                onBlur={() => touch(spec.id)}
              />
            );
          })}
        </m.section>
      </AnimatePresence>

      {/* Focus mode: the tab bar is hidden on form routes; this bar owns the bottom edge. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-2xl gap-3 px-4 py-3">
          {step > 0 ? (
            <Button variant="outline" size="lg" className="flex-1" onClick={() => goTo(step - 1)}>
              <ArrowLeft aria-hidden />
              {t('common.back')}
            </Button>
          ) : (
            <Button variant="outline" size="lg" className="flex-1" onClick={() => navigate('/')}>
              <X aria-hidden />
              {t('common.close')}
            </Button>
          )}
          {isLast ? (
            <Button
              size="lg"
              className="flex-[2]"
              onClick={() => void save()}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Save aria-hidden />
              )}
              {submitting ? t('form.saving') : t('form.saveForm')}
            </Button>
          ) : (
            <Button size="lg" className="flex-[2]" onClick={next}>
              {t('common.next')}
              <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
      </div>
      <p className="text-center text-sm text-muted-foreground">{t('form.exit')}</p>
    </div>
  );
}
