import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import type { Role } from '@/lib/roles';
import { useApp } from '@/stores/app';

export function RequireUnlocked({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const status = useApp((s) => s.status);
  const role = useApp((s) => s.profile?.role);
  const location = useLocation();
  if (status === 'booting') return null;
  if (status !== 'unlocked')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && role && !roles.includes(role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Role-based landing: supervisors/admins start on the dashboard (ADD §16.1). */
export function HomeRedirect({ children }: { children: ReactNode }) {
  const role = useApp((s) => s.profile?.role);
  if (role === 'supervisor' || role === 'admin') return <Navigate to="/supervisor" replace />;
  return <>{children}</>;
}
