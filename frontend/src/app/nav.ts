import {
  HelpCircle,
  Home,
  LayoutDashboard,
  RefreshCw,
  Settings,
  type LucideIcon,
} from 'lucide-react';

import type { MessageKey } from '@/i18n';
import { isReviewer, type Role } from '@/lib/roles';

export interface NavItem {
  to: string;
  label: MessageKey;
  Icon: LucideIcon;
  /** Show the queue badge (waiting + needs action). */
  badge?: boolean;
}

export function navItems(role: Role | undefined): NavItem[] {
  const reviewer = isReviewer(role);
  return [
    ...(reviewer
      ? [{ to: '/supervisor', label: 'nav.dashboard' as const, Icon: LayoutDashboard }]
      : []),
    { to: reviewer ? '/home' : '/', label: 'nav.home', Icon: Home },
    { to: '/sync', label: 'nav.sync', Icon: RefreshCw, badge: true },
    { to: '/help', label: 'nav.help', Icon: HelpCircle },
    { to: '/settings', label: 'nav.settings', Icon: Settings },
  ];
}

/** Routes that run in focus mode: no tab bar, a fixed action bar instead (forms). */
export const isFocusRoute = (pathname: string): boolean => pathname.startsWith('/form/');
