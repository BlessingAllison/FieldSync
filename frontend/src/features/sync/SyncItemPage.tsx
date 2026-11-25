import { ArrowLeft, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  conflictView,
  discardItem,
  editSynced,
  getVault,
  reopenFailed,
  resolveConflict,
  retryItem,
  templateDefinition,
} from '@/app/runtime';
import type { Payload } from '@/core/validation/types';
import { type MessageKey, useT } from '@/i18n';
import { formatDateTime, supportCode } from '@/lib/format';
import { displayValue, findField, ruleMessage, tx } from '@/lib/template-text';
import { useVaultQuery } from '@/lib/useVaultQuery';
import { useNetwork } from '@/stores/network';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { ConfirmDialog } from '@/ui/dialog';
import { PageSkeleton } from '@/ui/skeleton';
import { type ChipState, SyncChip } from '@/ui/sync-chip';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export default function SyncItemPage() {
  const { clientUuid = '' } = useParams();
  const translator = useT();
  const { t, locale } = translator;
  const navigate = useNavigate();
  const online = useNetwork((s) => s.online);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data, loading } = useVaultQuery(async () => {
    const vault = getVault();
    const [item, receipt] = await Promise.all([
      vault.getOutboxItem(clientUuid),
      vault.getReceipt(clientUuid),
    ]);
    const meta = item ?? receipt;
    const definition = meta
      ? await templateDefinition(meta.templateCode, meta.templateVersion)
      : null;
    const summary = item
      ? await vault.outboxSummary(item)
      : receipt
        ? await vault.receiptSummary(receipt)
        : null;
    const conflict = item?.state === 'CONFLICT' ? await conflictView(clientUuid) : null;
    const facility = meta
      ? (await vault.listFacilities()).find((f) => f.id === meta.facilityId)
      : undefined;
    return { item, receipt, definition, summary, conflict, facility };
  }, [clientUuid]);

  if (loading || !data) return <PageSkeleton />;
  const { item, receipt, definition, summary, conflict, facility } = data;
  if (!item && !receipt) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-dashed p-6 text-center">
        <p className="mb-4">{t('item.notFound')}</p>
        <Button onClick={() => navigate('/sync')}>{t('common.back')}</Button>
      </div>
    );
  }
  const state: ChipState = item?.state ?? (receipt?.status === 'synced' ? 'SYNCED' : 'PENDING');

  const run = async (action: () => Promise<unknown>, then?: string) => {
    setBusy(true);
    try {
      await action();
      if (then) navigate(then);
    } finally {
      setBusy(false);
    }
  };

  // ── Conflict diff ────────────────────────────────────────────────────────
  let diff: Array<{
    id: string;
    mine: unknown;
    server: unknown;
    byMe: boolean;
    byServer: boolean;
  }> = [];
  let disjoint = true;
  let merged: Payload | null = null;
  if (conflict) {
    const keys = new Set([...Object.keys(conflict.mine), ...Object.keys(conflict.server.payload)]);
    const base = conflict.base ?? {};
    diff = [...keys]
      .filter((key) => !same(conflict.mine[key], conflict.server.payload[key]))
      .map((key) => ({
        id: key,
        mine: conflict.mine[key],
        server: conflict.server.payload[key],
        byMe: !same(conflict.mine[key], base[key]),
        byServer: !same(conflict.server.payload[key], base[key]),
      }));
    disjoint = conflict.base !== null && diff.every((d) => !(d.byMe && d.byServer));
    if (disjoint) {
      merged = { ...(conflict.server.payload as Payload) };
      for (const d of diff) if (d.byMe) merged[d.id] = conflict.mine[d.id];
    }
  }

  const fields = item?.lastError?.fields ?? {};
  const dv = (id: string, v: unknown) =>
    displayValue(
      findField(definition, id),
      v,
      locale,
      t('common.yes'),
      t('common.no'),
      t('item.empty'),
    );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <Button variant="ghost" className="self-start" onClick={() => navigate('/sync')}>
        <ArrowLeft aria-hidden />
        {t('common.back')}
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {summary?.patientLabel ?? t('item.title')}
        </h1>
        <SyncChip state={state} label={t(`state.${state}`)} />
      </div>

      <Card>
        <CardContent className="p-4">
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t('item.template')}</dt>
            <dd className="font-medium">
              {definition ? tx(definition.title, locale) : (item ?? receipt)?.templateCode}
            </dd>
            {facility && (
              <>
                <dt className="text-muted-foreground">{t('item.facility')}</dt>
                <dd className="font-medium">{facility.name}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t('item.captured')}</dt>
            <dd className="font-medium">{formatDateTime((item ?? receipt)!.capturedAt, locale)}</dd>
            {receipt?.syncedAt && state === 'SYNCED' && (
              <>
                <dt className="text-muted-foreground">{t('item.syncedAt')}</dt>
                <dd className="font-medium">{formatDateTime(receipt.syncedAt, locale)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t('item.receipt')}</dt>
            <dd className="font-mono font-medium">{supportCode(clientUuid)}</dd>
            {item?.lastError?.requestId && (
              <>
                <dt className="text-muted-foreground">{t('item.supportCode')}</dt>
                <dd className="font-mono font-medium">{supportCode(item.lastError.requestId)}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {item?.state === 'FAILED' && (
        <section className="flex flex-col gap-3 rounded-lg border-2 border-status-failed bg-status-failed-bg p-4 text-status-failed">
          <h2 className="text-lg font-bold">{t('item.failed.title')}</h2>
          {Object.keys(fields).length > 0 ? (
            <>
              <p className="font-medium">{t('item.failed.fields')}</p>
              <ul className="list-disc pl-5">
                {Object.entries(fields).map(([id, codes]) => {
                  const spec = findField(definition, id);
                  return (
                    <li key={id}>
                      <strong>{spec ? tx(spec.label, locale) : id}:</strong>{' '}
                      {ruleMessage(translator, codes[0] ?? 'type', spec, definition)}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p>{failureReason(t, item.lastError?.code)}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              disabled={busy}
              onClick={() => void run(() => reopenFailed(clientUuid), `/form/${clientUuid}`)}
            >
              <Pencil aria-hidden />
              {t('item.fix')}
            </Button>
            <Button
              variant="outline"
              className="bg-card"
              disabled={busy}
              onClick={() => setConfirmDiscard(true)}
            >
              <Trash2 aria-hidden />
              {t('item.discard')}
            </Button>
          </div>
        </section>
      )}

      {conflict && (
        <section className="flex flex-col gap-4 rounded-lg border-2 border-status-conflict bg-card p-4">
          <div>
            <h2 className="text-lg font-bold text-status-conflict">{t('item.conflict.title')}</h2>
            <p>{t('item.conflict.body')}</p>
            {conflict.server.changed_by_role && (
              <p className="text-sm text-muted-foreground">
                {t('item.conflict.changedBy', {
                  role: t(`settings.role.${conflict.server.changed_by_role as 'chw'}`),
                })}
              </p>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">{t('item.conflict.title')}</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3">
                    {t('item.conflict.field')}
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    {t('item.conflict.yours')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('item.conflict.server')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {diff.map((d) => {
                  const spec = findField(definition, d.id);
                  return (
                    <tr key={d.id} className="border-b align-top">
                      <th scope="row" className="py-2 pr-3 font-semibold">
                        {spec ? tx(spec.label, locale) : d.id}
                      </th>
                      <td className="py-2 pr-3">
                        {dv(d.id, d.mine)}
                        {d.byMe && (
                          <span className="block text-sm text-status-conflict">
                            {t('item.conflict.changedByYou')}
                          </span>
                        )}
                      </td>
                      <td className="py-2">
                        {dv(d.id, d.server)}
                        {d.byServer && (
                          <span className="block text-sm text-status-conflict">
                            {t('item.conflict.changedOnServer')}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!disjoint && <p className="font-medium">{t('item.conflict.overlap')}</p>}
          <div className="flex flex-col gap-2">
            {merged && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => resolveConflict(clientUuid, { kind: 'merge', payload: merged }),
                    '/sync',
                  )
                }
              >
                {t('item.conflict.combine')}
              </Button>
            )}
            {merged && (
              <p className="-mt-1 text-sm text-muted-foreground">
                {t('item.conflict.combineHelp')}
              </p>
            )}
            <Button
              variant={merged ? 'outline' : 'primary'}
              disabled={busy}
              onClick={() => void run(() => resolveConflict(clientUuid, { kind: 'mine' }), '/sync')}
            >
              {t('item.conflict.keepMine')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() => resolveConflict(clientUuid, { kind: 'server' }), '/sync')
              }
            >
              {t('item.conflict.useServer')}
            </Button>
          </div>
        </section>
      )}

      {item?.state === 'RETRY_WAIT' && (
        <Button size="lg" disabled={busy} onClick={() => void run(() => retryItem(clientUuid))}>
          <RotateCcw aria-hidden />
          {t('syncPage.retryNow')}
        </Button>
      )}

      {state === 'SYNCED' && (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            variant="outline"
            disabled={busy || !online}
            onClick={() =>
              void run(async () => {
                const result = await editSynced(clientUuid);
                if (result === 'ok') navigate(`/form/${clientUuid}`);
                else setMessage(t('item.editOffline'));
              })
            }
          >
            <Pencil aria-hidden />
            {t('item.edit')}
          </Button>
          {(!online || message) && (
            <p className="text-sm text-muted-foreground">{message ?? t('item.editOffline')}</p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title={t('item.discardTitle')}
        confirmLabel={t('item.discard')}
        cancelLabel={t('common.cancel')}
        destructive
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          void run(() => discardItem(clientUuid), '/sync');
        }}
      >
        <p>{t('item.discardBody')}</p>
      </ConfirmDialog>
    </div>
  );
}

const FAILURE_REASONS = new Set([
  'template_retired',
  'template_unknown',
  'facility_forbidden',
  'client_uuid_foreign',
  'payload_too_large',
  'permission_denied',
]);

/** Plain-language reason for a non-field failure; never shows the CHW a raw error code. */
function failureReason(t: (key: MessageKey) => string, code: string | undefined): string {
  return code && FAILURE_REASONS.has(code)
    ? t(`item.failed.reason.${code}` as MessageKey)
    : t('item.failed.other');
}
