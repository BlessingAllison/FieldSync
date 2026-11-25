/**
 * Admin: every form template, grouped by form, with its versions and lifecycle actions.
 * Online-only (templates live on the server); field phones are unaffected while offline.
 */
import { Copy, FilePlus2, GitBranchPlus, Pencil, Rocket, Archive, Trash2, Eye } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/app/runtime';
import type { ApiResult } from '@/core/api/http';
import type { FormTemplateAdmin } from '@/core/api/client';
import type { TemplateDefinition } from '@/core/validation/types';
import { type MessageKey, useT } from '@/i18n';
import { formatDateTime } from '@/lib/format';
import { tx } from '@/lib/template-text';
import { useNetwork } from '@/stores/network';
import { Button } from '@/ui/button';
import { ConfirmDialog } from '@/ui/dialog';
import { TextInput } from '@/ui/form-controls';
import { EmptyState } from '@/ui/illustrations';
import { PageSkeleton } from '@/ui/skeleton';

import { asCopy, asNewVersion, emptyDefinition, failureText } from './builder-model';

type Pending =
  | { kind: 'new' }
  | { kind: 'copy'; template: FormTemplateAdmin }
  | { kind: 'publish' | 'retire' | 'delete'; template: FormTemplateAdmin }
  | null;

const STATUS_STYLE: Record<string, string> = {
  draft: 'border-status-conflict text-status-conflict bg-status-conflict-bg',
  published: 'border-status-sent text-status-sent bg-status-sent-bg',
  superseded: 'border-status-pending text-status-pending bg-status-pending-bg',
  retired: 'border-input text-muted-foreground bg-muted',
};

export default function FormsAdminPage() {
  const { t, plural, locale } = useT();
  const navigate = useNavigate();
  const online = useNetwork((s) => s.online);
  const [templates, setTemplates] = useState<FormTemplateAdmin[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState<'patient' | 'facility'>('patient');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.manageTemplates();
    if (result.ok) {
      setTemplates(result.data);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (online) void load();
  }, [online, load]);

  const groups = useMemo(() => {
    const byCode = new Map<string, FormTemplateAdmin[]>();
    for (const template of templates ?? []) {
      byCode.set(template.code, [...(byCode.get(template.code) ?? []), template]);
    }
    return [...byCode.values()].map((versions) => versions.sort((a, b) => b.version - a.version));
  }, [templates]);

  const run = async (action: () => Promise<ApiResult<unknown>>, then?: (data: unknown) => void) => {
    setBusy(true);
    setMessage(null);
    const result = await action();
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      setMessage(t('fb.actionFailed', { reason: failureText(result) }));
      return;
    }
    if (then) then(result.data);
    else await load();
  };

  const openEditor = (data: unknown) => navigate(`/admin/forms/${(data as { id: string }).id}`);

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === 'new') {
      void run(() => api.createTemplate(emptyDefinition(name.trim(), subject)), openEditor);
    } else if (pending.kind === 'copy') {
      const definition = asCopy(
        pending.template.definition as TemplateDefinition,
        name.trim(),
        (templates ?? []).map((tpl) => tpl.code),
      );
      void run(() => api.createTemplate(definition), openEditor);
    } else if (pending.kind === 'publish') {
      void run(() => api.publishTemplate(pending.template.id));
    } else if (pending.kind === 'retire') {
      void run(() => api.retireTemplate(pending.template.id));
    } else {
      void run(() => api.deleteTemplate(pending.template.id));
    }
  };

  const newVersion = (template: FormTemplateAdmin) =>
    void run(
      () =>
        api.createTemplate(
          asNewVersion(template.definition as TemplateDefinition, templates ?? []),
        ),
      openEditor,
    );

  const dialogTitle: Record<NonNullable<Pending>['kind'], MessageKey> = {
    new: 'fb.newTitle',
    copy: 'fb.duplicate',
    publish: 'fb.publishTitle',
    retire: 'fb.retireTitle',
    delete: 'fb.deleteTitle',
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('fb.title')}</h1>
          <p className="mt-1 max-w-prose text-muted-foreground">{t('fb.intro')}</p>
        </div>
        <Button
          disabled={!online || busy}
          onClick={() => {
            setName('');
            setSubject('patient');
            setPending({ kind: 'new' });
          }}
        >
          <FilePlus2 aria-hidden />
          {t('fb.new')}
        </Button>
      </div>

      {!online && (
        <p
          role="status"
          className="rounded-lg border border-status-pending/40 bg-status-pending-bg p-3 font-medium text-status-pending"
        >
          {t('fb.offline')}
        </p>
      )}
      {message && (
        <p
          role="alert"
          className="rounded-lg border-2 border-status-failed bg-status-failed-bg p-3 font-medium text-status-failed"
        >
          {message}
        </p>
      )}
      {loadFailed && (
        <p role="alert" className="font-medium text-status-failed">
          {t('fb.loadFailed')}
        </p>
      )}

      {templates === null && online && !loadFailed && <PageSkeleton />}
      {templates?.length === 0 && <EmptyState title={t('fb.empty')} />}

      <ul className="flex flex-col gap-4">
        {groups.map((versions) => {
          const latest = versions[0]!;
          return (
            <li key={latest.code}>
              <article
                aria-labelledby={`form-${latest.code}`}
                className="flex flex-col gap-3 rounded-lg border bg-card p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id={`form-${latest.code}`} className="text-lg font-bold">
                    {tx(latest.title as { en: string }, locale)}
                  </h2>
                  <span className="font-mono text-sm text-muted-foreground">{latest.code}</span>
                </div>
                <ul className="flex flex-col divide-y">
                  {versions.map((template) => (
                    <li
                      key={template.id}
                      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {t('fb.version', { version: template.version })}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-sm font-semibold ${STATUS_STYLE[template.status] ?? ''}`}
                        >
                          {t(`fb.status.${template.status}` as MessageKey)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {template.status === 'published' && template.published_at
                            ? t('fb.publishedOn', {
                                date: formatDateTime(Date.parse(template.published_at), locale),
                              })
                            : template.accept_until && template.status !== 'draft'
                              ? t('fb.acceptUntil', {
                                  date: formatDateTime(Date.parse(template.accept_until), locale),
                                })
                              : ''}
                          {template.status !== 'draft' &&
                            ` · ${plural('fb.received', template.submission_count)}`}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {template.status === 'draft' ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => navigate(`/admin/forms/${template.id}`)}
                            >
                              <Pencil aria-hidden />
                              {t('fb.edit')}
                            </Button>
                            <Button
                              size="sm"
                              disabled={!online || busy}
                              onClick={() => setPending({ kind: 'publish', template })}
                            >
                              <Rocket aria-hidden />
                              {t('fb.publish')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!online || busy}
                              onClick={() => setPending({ kind: 'delete', template })}
                            >
                              <Trash2 aria-hidden />
                              {t('fb.delete')}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => navigate(`/admin/forms/${template.id}`)}
                            >
                              <Eye aria-hidden />
                              {t('fb.view')}
                            </Button>
                            {template.id === latest.id && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!online || busy}
                                onClick={() => newVersion(template)}
                              >
                                <GitBranchPlus aria-hidden />
                                {t('fb.newVersion')}
                              </Button>
                            )}
                            {template.status !== 'retired' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!online || busy}
                                onClick={() => setPending({ kind: 'retire', template })}
                              >
                                <Archive aria-hidden />
                                {t('fb.retire')}
                              </Button>
                            )}
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!online || busy}
                          onClick={() => {
                            setName(`${tx(template.title as { en: string }, locale)} (2)`);
                            setPending({ kind: 'copy', template });
                          }}
                        >
                          <Copy aria-hidden />
                          {t('fb.duplicate')}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? t(dialogTitle[pending.kind]) : ''}
        confirmLabel={
          pending?.kind === 'publish'
            ? t('fb.publish')
            : pending?.kind === 'retire'
              ? t('fb.retire')
              : pending?.kind === 'delete'
                ? t('fb.delete')
                : t('fb.create')
        }
        cancelLabel={t('fb.cancel')}
        destructive={pending?.kind === 'delete' || pending?.kind === 'retire'}
        confirmDisabled={
          busy || ((pending?.kind === 'new' || pending?.kind === 'copy') && name.trim().length < 3)
        }
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      >
        {pending?.kind === 'publish' && <p>{t('fb.publishBody')}</p>}
        {pending?.kind === 'retire' && <p>{t('fb.retireBody')}</p>}
        {pending?.kind === 'delete' && <p>{t('fb.deleteBody')}</p>}
        {(pending?.kind === 'new' || pending?.kind === 'copy') && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fb-name" className="font-semibold">
                {pending.kind === 'new' ? t('fb.newName') : t('fb.duplicateName')}
              </label>
              <TextInput
                id="fb-name"
                value={name}
                maxLength={120}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                aria-describedby="fb-name-help"
              />
              <p id="fb-name-help" className="text-sm text-muted-foreground">
                {t('fb.newNameHelp')}
              </p>
            </div>
            {pending.kind === 'new' && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-semibold">{t('fb.subject')}</legend>
                {(['patient', 'facility'] as const).map((value) => (
                  <label
                    key={value}
                    className="flex min-h-tap items-center gap-3 rounded-lg border-2 px-3"
                  >
                    <input
                      type="radio"
                      name="fb-subject"
                      value={value}
                      checked={subject === value}
                      onChange={() => setSubject(value)}
                      className="size-5"
                    />
                    {t(`fb.subject.${value}`)}
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
