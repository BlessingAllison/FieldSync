export type Role = 'chw' | 'supervisor' | 'admin';
export const isReviewer = (role: Role | undefined): boolean =>
  role === 'supervisor' || role === 'admin';
