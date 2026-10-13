import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Skeleton } from '@/components/ui/Status';
import type { Role } from '@/types/api';

/**
 * Client-side route guards are a UX convenience only (they avoid showing a screen that would just
 * fail). Every protected API endpoint independently enforces authentication and role on the server.
 */
export function RequireAuth({ children, role }: { children: ReactNode; role?: Role }) {
  const { user, initializing } = useAuth();
  const location = useLocation();
  if (initializing) return <div className="mx-auto max-w-5xl px-4 py-10"><Skeleton className="h-64" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (role === 'ADMIN' && user.role !== 'ADMIN') return <Forbidden />;
  if (role === 'SELLER' && user.role === 'USER') return <Forbidden seller />;
  return <>{children}</>;
}

function Forbidden({ seller }: { seller?: boolean }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-3xl">{seller ? 'Seller accounts only' : 'Administrators only'}</h1>
      <p className="mt-3 text-ink-soft">
        {seller ? 'Your account can bid but not list items. An administrator can upgrade it to a seller account.' : 'You don’t have access to this area.'}
      </p>
    </div>
  );
}
