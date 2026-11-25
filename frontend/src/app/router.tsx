import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router-dom';

import { LoginPage } from '@/features/auth/LoginPage';
import { DeviceCheckPage } from '@/features/device-check/DeviceCheckPage';
import { FormPage } from '@/features/forms/FormPage';
import { NewFormPage } from '@/features/forms/NewFormPage';
import { SavedPage } from '@/features/forms/SavedPage';
import { HomePage } from '@/features/home/HomePage';
import { PageSkeleton } from '@/ui/skeleton';

import { AppShell } from './AppShell';
import { HomeRedirect, RequireUnlocked } from './guards';
import { RouteError } from './RouteError';

// Critical path (ADD §16.1): login, home, new, form, saved. Everything else is lazy.
// (Phase 5 measured lazy-loading new/form/saved: −3.5 KB gz, ~70 ms on Slow 3G — not worth
// an extra chunk hop that can fail offline on a first visit. See QA-REPORT B6.)
const SyncPage = lazy(() => import('@/features/sync/SyncPage'));
const SyncItemPage = lazy(() => import('@/features/sync/SyncItemPage'));
const SupervisorPage = lazy(() => import('@/features/supervisor/SupervisorPage'));
const SimulatorPage = lazy(() => import('@/features/simulator/SimulatorPage'));
const HelpPage = lazy(() => import('@/features/help/HelpPage'));
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'));
const FormsAdminPage = lazy(() => import('@/features/admin/FormsAdminPage'));
const FormBuilderPage = lazy(() => import('@/features/admin/FormBuilderPage'));

const lazyPage = (node: ReactNode) => <Suspense fallback={<PageSkeleton />}>{node}</Suspense>;
const guarded = (node: ReactNode, roles?: Array<'chw' | 'supervisor' | 'admin'>) => (
  <RequireUnlocked {...(roles ? { roles } : {})}>{node}</RequireUnlocked>
);

export const router = createBrowserRouter(
  [
    {
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { path: '/login', element: <LoginPage /> },
        { path: '/device-check', element: <DeviceCheckPage /> },
        {
          path: '/',
          element: guarded(
            <HomeRedirect>
              <HomePage />
            </HomeRedirect>,
          ),
        },
        { path: '/home', element: guarded(<HomePage />) },
        { path: '/new', element: guarded(<NewFormPage />) },
        { path: '/form/:clientUuid', element: guarded(<FormPage />) },
        { path: '/saved/:clientUuid', element: guarded(<SavedPage />) },
        { path: '/sync', element: guarded(lazyPage(<SyncPage />)) },
        { path: '/sync/:clientUuid', element: guarded(lazyPage(<SyncItemPage />)) },
        {
          path: '/supervisor',
          element: guarded(lazyPage(<SupervisorPage />), ['supervisor', 'admin']),
        },
        { path: '/simulator', element: guarded(lazyPage(<SimulatorPage />)) },
        { path: '/admin/forms', element: guarded(lazyPage(<FormsAdminPage />), ['admin']) },
        {
          path: '/admin/forms/:templateId',
          element: guarded(lazyPage(<FormBuilderPage />), ['admin']),
        },
        { path: '/help', element: lazyPage(<HelpPage />) },
        { path: '/settings', element: guarded(lazyPage(<SettingsPage />)) },
        { path: '*', element: guarded(<HomePage />) },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
      v7_fetcherPersist: true,
      v7_normalizeFormMethod: true,
      v7_partialHydration: true,
      v7_skipActionErrorRevalidation: true,
    },
  },
);
