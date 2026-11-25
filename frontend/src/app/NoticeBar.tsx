import { X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { lock } from '@/app/runtime';
import { type MessageKey, useT } from '@/i18n';
import { useApp } from '@/stores/app';
import { Button } from '@/ui/button';

export function NoticeBar() {
  const { t } = useT();
  const notice = useApp((s) => s.notice);
  const navigate = useNavigate();
  if (!notice) return null;
  const dismiss = () => useApp.setState({ notice: null });
  return (
    <div role="alert" className="border-b bg-status-pending-bg text-status-pending">
      <div className="container flex items-start gap-3 py-3">
        <p className="flex-1 font-semibold">{t(`notice.${notice.kind}` as MessageKey)}</p>
        {notice.kind === 'session_expired' && (
          <Button
            size="sm"
            variant="outline"
            className="bg-card"
            onClick={() => {
              dismiss();
              void lock().then(() => navigate('/login'));
            }}
          >
            {t('notice.signIn')}
          </Button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('notice.dismiss')}
          className="flex size-10 items-center justify-center rounded-md hover:bg-black/5"
        >
          <X aria-hidden className="size-5" />
        </button>
      </div>
    </div>
  );
}
