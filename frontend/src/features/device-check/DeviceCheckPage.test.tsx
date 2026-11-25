import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LazyMotion, domAnimation } from 'framer-motion';
import { describe, expect, it, vi } from 'vitest';

import * as caps from '@/platform/capabilities';

import { DeviceCheckPage } from './DeviceCheckPage';

function renderPage() {
  return render(
    <LazyMotion features={domAnimation}>
      <DeviceCheckPage />
    </LazyMotion>,
  );
}

function mockProbes(overrides: Partial<Record<string, caps.ProbeStatus>> = {}) {
  vi.spyOn(caps, 'probeServiceWorker').mockReturnValue(overrides.serviceWorker ?? 'ok');
  vi.spyOn(caps, 'probeIndexedDb').mockResolvedValue(overrides.indexedDb ?? 'ok');
  vi.spyOn(caps, 'probeCrypto').mockResolvedValue(overrides.crypto ?? 'ok');
  vi.spyOn(caps, 'probePersistence').mockResolvedValue(overrides.persistence ?? 'ok');
  vi.spyOn(caps, 'probeStorage').mockResolvedValue({
    status: overrides.storage ?? 'ok',
    info: { usage: 2 * 1024 * 1024, quota: 4 * 1024 * 1024 * 1024 },
  });
  vi.spyOn(caps, 'probeBackgroundSync').mockReturnValue(overrides.backgroundSync ?? 'ok');
  vi.spyOn(caps, 'probeServer').mockResolvedValue(overrides.server ?? 'ok');
}

describe('DeviceCheckPage', () => {
  it('reports a ready device', async () => {
    mockProbes();
    renderPage();
    expect(await screen.findByText('This phone is ready for offline work.')).toBeInTheDocument();
    expect(screen.getByText('2 MB used of 4 GB available to FieldSync.')).toBeInTheDocument();
  });

  it('counts items needing attention and explains them in plain language', async () => {
    mockProbes({ server: 'fail', backgroundSync: 'warn' });
    renderPage();
    expect(await screen.findByText('2 items need attention.')).toBeInTheDocument();
    expect(
      screen.getByText('No connection to the server right now. Forms stay safe on this phone.'),
    ).toBeInTheDocument();
  });

  it('offers to protect storage when the browser may evict it', async () => {
    mockProbes({ persistence: 'warn' });
    const request = vi.spyOn(caps, 'requestPersistence').mockResolvedValue(true);
    renderPage();
    const button = await screen.findByRole('button', { name: 'Protect storage' });
    vi.spyOn(caps, 'probePersistence').mockResolvedValue('ok');
    await userEvent.click(button);
    expect(request).toHaveBeenCalledOnce();
    await waitFor(() => {
      const card = document.querySelector('[data-check="persistence"]') as HTMLElement;
      expect(within(card).getByText('OK')).toBeInTheDocument();
    });
  });
});
