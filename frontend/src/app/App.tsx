import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/context/AuthContext';
import { NotificationsProvider } from '@/context/NotificationsContext';
import { LiveFeedProvider } from '@/context/LiveFeedContext';
import { ApiError } from '@/services/api';
import { Layout } from '@/components/Layout';
import { Skeleton } from '@/components/ui/Status';
import { RequireAuth } from './RouteGuards';
import { HomePage } from '@/pages/HomePage';
import { BrowsePage } from '@/pages/BrowsePage';
import { AuctionPage } from '@/pages/AuctionPage';
import { LoginPage, RegisterPage } from '@/pages/AuthPages';
import { NotFoundPage } from '@/pages/NotFoundPage';

// Heavier, role-specific screens are code-split.
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const SellPage = lazy(() => import('@/pages/SellPage').then((m) => ({ default: m.SellPage })));
const SellerPage = lazy(() => import('@/pages/SellerPage').then((m) => ({ default: m.SellerPage })));
const AdminPage = lazy(() => import('@/pages/AdminPage').then((m) => ({ default: m.AdminPage })));

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      // Never retry 4xx (they won't succeed); retry network/5xx twice.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollTo, which must not become the cleanup.
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

const page = (el: React.ReactNode) => <Suspense fallback={<div className="mx-auto max-w-5xl px-4 py-10"><Skeleton className="h-96" /></div>}>{el}</Suspense>;

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <NotificationsProvider>
            <LiveFeedProvider>
              <ScrollToTop />
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<HomePage />} />
                  <Route path="auctions" element={<BrowsePage />} />
                  <Route path="auctions/:id" element={<AuctionPage />} />
                  <Route path="login" element={<LoginPage />} />
                  <Route path="register" element={<RegisterPage />} />
                  <Route path="dashboard" element={<RequireAuth>{page(<DashboardPage />)}</RequireAuth>} />
                  <Route path="sell" element={<RequireAuth role="SELLER">{page(<SellPage />)}</RequireAuth>} />
                  <Route path="sell/:id/edit" element={<RequireAuth role="SELLER">{page(<SellPage />)}</RequireAuth>} />
                  <Route path="seller" element={<RequireAuth role="SELLER">{page(<SellerPage />)}</RequireAuth>} />
                  <Route path="admin" element={<RequireAuth role="ADMIN">{page(<AdminPage />)}</RequireAuth>} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
              <Toaster position="bottom-right" richColors closeButton toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }} />
            </LiveFeedProvider>
          </NotificationsProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
