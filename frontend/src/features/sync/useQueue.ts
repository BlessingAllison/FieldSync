import { getVault } from '@/app/runtime';
import type { ReceiptRecord } from '@/core/db/schema';
import type { ItemSummary, OutboxItem } from '@/core/sync/types';
import type { TemplateDefinition } from '@/core/validation/types';
import { useVaultQuery } from '@/lib/useVaultQuery';

export interface QueueRow {
  item: OutboxItem;
  summary: ItemSummary;
}

export interface SentRow {
  receipt: ReceiptRecord;
  summary: ItemSummary;
}

export function useQueue() {
  return useVaultQuery(async () => {
    const vault = getVault();
    const [rows, receipts, templates] = await Promise.all([
      vault.listOutboxWithSummaries(),
      vault.listReceipts(),
      vault.listTemplates(),
    ]);
    const sent: SentRow[] = await Promise.all(
      receipts
        .filter((r) => r.status === 'synced')
        .reverse()
        .slice(0, 200)
        .map(async (receipt) => ({ receipt, summary: await vault.receiptSummary(receipt) })),
    );
    const titles = new Map(
      templates.map((t) => [`${t.code}:${t.version}`, (t.definition as TemplateDefinition).title]),
    );
    return {
      action: rows.filter((r) => r.item.state === 'FAILED' || r.item.state === 'CONFLICT'),
      waiting: rows.filter(
        (r) =>
          r.item.state === 'PENDING' || r.item.state === 'SYNCING' || r.item.state === 'RETRY_WAIT',
      ),
      sent,
      titles,
    };
  });
}
