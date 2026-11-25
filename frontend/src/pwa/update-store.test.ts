import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  holdUpdates,
  markUpdateReady,
  requestUpdate,
  setActivator,
  useUpdateStore,
} from './update-store';

describe('update holds', () => {
  beforeEach(() => {
    useUpdateStore.setState({
      updateReady: false,
      offlineReady: false,
      holds: new Set(),
      applyRequested: false,
    });
  });

  it('activates immediately when nothing holds the update', () => {
    const activate = vi.fn();
    setActivator(activate);
    markUpdateReady();
    expect(activate).not.toHaveBeenCalled(); // never without the user asking
    requestUpdate();
    expect(activate).toHaveBeenCalledOnce();
  });

  it('defers activation until every hold is released', () => {
    const activate = vi.fn();
    setActivator(activate);
    const releaseForm = holdUpdates('draft:0193');
    const releaseOther = holdUpdates('sync-screen');
    markUpdateReady();
    requestUpdate();
    expect(activate).not.toHaveBeenCalled();
    releaseForm();
    expect(activate).not.toHaveBeenCalled();
    releaseOther();
    expect(activate).toHaveBeenCalledOnce();
  });
});
