import { Building2, ChevronRight, ClipboardList, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { getVault, newDraft } from '@/app/runtime';
import type { TemplateRecord } from '@/core/db/schema';
import type { TemplateDefinition } from '@/core/validation/types';
import { useT } from '@/i18n';
import { tx } from '@/lib/template-text';
import { useVaultQuery } from '@/lib/useVaultQuery';
import { ChoiceCards } from '@/ui/form-controls';
import { PageSkeleton } from '@/ui/skeleton';

export function NewFormPage() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, loading } = useVaultQuery(async () => {
    const vault = getVault();
    const [templates, facilities] = await Promise.all([
      vault.listTemplates(),
      vault.listFacilities(),
    ]);
    // Offer only the newest accepting version of each template code.
    const newest = new Map<string, TemplateRecord>();
    for (const tpl of templates) {
      const current = newest.get(tpl.code);
      if (tpl.status === 'published' && (!current || tpl.version > current.version))
        newest.set(tpl.code, tpl);
    }
    return { templates: [...newest.values()], facilities };
  });

  useEffect(() => {
    if (data?.facilities.length === 1 && data.facilities[0]) setFacilityId(data.facilities[0].id);
  }, [data]);

  if (loading || !data) return <PageSkeleton />;

  const start = async (template: TemplateRecord) => {
    if (!facilityId || busy) return;
    setBusy(true);
    const clientUuid = await newDraft(template.code, template.version, facilityId);
    navigate(`/form/${clientUuid}`, { replace: true });
  };

  const groups: Array<{ title: string; Icon: typeof UserRound; items: TemplateRecord[] }> = [
    {
      title: t('new.patientForms'),
      Icon: UserRound,
      items: data.templates.filter((tpl) => tpl.subject === 'patient'),
    },
    {
      title: t('new.facilityForms'),
      Icon: Building2,
      items: data.templates.filter((tpl) => tpl.subject === 'facility'),
    },
  ];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('new.title')}</h1>
      {data.facilities.length === 0 && (
        <p className="rounded-lg border border-dashed p-5 text-muted-foreground">
          {t('new.noFacility')}
        </p>
      )}
      {data.facilities.length > 1 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-lg font-semibold">{t('new.facility')}</legend>
          <ChoiceCards
            name="facility"
            options={data.facilities.map((f) => ({ value: f.id, label: `${f.name} (${f.code})` }))}
            value={facilityId}
            onChange={setFacilityId}
          />
        </fieldset>
      )}
      {data.templates.length === 0 && (
        <p className="rounded-lg border border-dashed p-5 text-muted-foreground">
          {t('new.noTemplates')}
        </p>
      )}
      {groups
        .filter((g) => g.items.length > 0)
        .map((group) => (
          <section key={group.title} className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <group.Icon aria-hidden className="size-5" />
              {group.title}
            </h2>
            {group.items.map((tpl) => {
              const definition = tpl.definition as TemplateDefinition;
              return (
                <button
                  key={tpl.code}
                  type="button"
                  disabled={!facilityId || busy}
                  onClick={() => void start(tpl)}
                  className="flex min-h-20 items-center gap-4 rounded-lg border-2 border-input bg-card p-4 text-left hover:border-primary hover:bg-accent disabled:border-dashed"
                >
                  <ClipboardList aria-hidden className="size-7 shrink-0 text-primary" />
                  <span className="flex-1">
                    <span className="block text-lg font-semibold">
                      {tx(definition.title, locale)}
                    </span>
                    {definition.description && (
                      <span className="block text-sm text-muted-foreground">
                        {tx(definition.description, locale)}
                      </span>
                    )}
                    <span className="text-sm text-muted-foreground">
                      {t('new.version', { version: tpl.version })}
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-6" />
                </button>
              );
            })}
          </section>
        ))}
    </div>
  );
}
