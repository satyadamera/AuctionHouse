import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Menu, Search, X } from 'lucide-react';
import { canSell, useAuth } from '@/context/AuthContext';
import { Wordmark } from './Wordmark';
import { NotificationBell } from './NotificationBell';
import { cn } from '@/utils/cn';

const navLink = ({ isActive }: { isActive: boolean }) => cn('text-sm transition-colors hover:text-ink', isActive ? 'text-ink font-medium' : 'text-ink-soft');

function SearchBox({ onDone }: { onDone?: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/auctions${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    onDone?.();
  };
  return (
    <form onSubmit={submit} role="search" className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search lots"
        aria-label="Search lots"
        className="h-10 w-full rounded-md border border-line bg-paper pl-9 pr-3 text-sm placeholder:text-muted focus:border-baize focus:outline-none"
      />
    </form>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const initials = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('');
  const item = 'block cursor-pointer rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-ink/5';
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="grid size-9 place-items-center rounded-full bg-baize text-xs font-semibold text-porcelain" aria-label={`Account menu for ${user.name}`}>
        {initials}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} className="z-50 min-w-52 rounded-lg border border-line bg-paper p-1.5 shadow-xl">
          <div className="px-3 py-2">
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-xs text-muted">{user.email}</div>
          </div>
          <Dropdown.Separator className="my-1 h-px bg-line" />
          <Dropdown.Item className={item} onSelect={() => navigate('/dashboard')}>My bids &amp; watchlist</Dropdown.Item>
          {canSell(user) && <Dropdown.Item className={item} onSelect={() => navigate('/seller')}>Seller dashboard</Dropdown.Item>}
          {user.role === 'ADMIN' && <Dropdown.Item className={item} onSelect={() => navigate('/admin')}>Administration</Dropdown.Item>}
          <Dropdown.Item className={item} onSelect={() => navigate('/dashboard?tab=settings')}>Account settings</Dropdown.Item>
          <Dropdown.Separator className="my-1 h-px bg-line" />
          <Dropdown.Item className={item} onSelect={async () => { await logout(); navigate('/'); }}>
            Sign out
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function Layout() {
  const { user, initializing } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-porcelain/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Wordmark />
          <nav className="hidden items-center gap-6 md:flex" aria-label="Primary">
            <NavLink to="/auctions" className={navLink} end>Browse</NavLink>
            <NavLink to="/auctions?status=SCHEDULED" className={() => navLink({ isActive: false })}>Upcoming</NavLink>
            <NavLink to="/auctions?status=COMPLETED" className={() => navLink({ isActive: false })}>Results</NavLink>
            {canSell(user) && <NavLink to="/sell" className={navLink}>Sell</NavLink>}
          </nav>
          <div className="ml-auto hidden w-64 lg:block">
            <SearchBox />
          </div>
          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            {!initializing && user && (
              <>
                <NotificationBell />
                <AccountMenu />
              </>
            )}
            {!initializing && !user && (
              <div className="hidden items-center gap-2 sm:flex">
                <Link to="/login" className="px-3 text-sm font-medium text-ink-soft hover:text-ink">Sign in</Link>
                <Link to="/register" className="inline-flex h-9 items-center rounded-md bg-baize px-4 text-sm font-medium text-porcelain hover:bg-baize-deep">
                  Create account
                </Link>
              </div>
            )}
            <button className="grid size-10 place-items-center rounded-md md:hidden" onClick={() => setMobileOpen((o) => !o)} aria-expanded={mobileOpen} aria-label="Menu">
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>
        {mobileOpen && (
          <div className="border-t border-line px-4 pb-4 pt-3 md:hidden">
            <SearchBox onDone={() => setMobileOpen(false)} />
            <nav className="mt-3 flex flex-col gap-1" aria-label="Mobile">
              {[
                ['/auctions', 'Browse'],
                ['/auctions?status=SCHEDULED', 'Upcoming'],
                ['/auctions?status=COMPLETED', 'Results'],
                ...(canSell(user) ? [['/sell', 'Sell']] : []),
                ...(user ? [['/dashboard', 'My bids']] : [['/login', 'Sign in'], ['/register', 'Create account']]),
              ].map(([to, label]) => (
                <Link key={to} to={to!} onClick={() => setMobileOpen(false)} className="rounded px-2 py-2 text-sm hover:bg-ink/5">
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        )}
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <footer className="mt-24 border-t border-line">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[2fr_1fr_1fr]">
          <div className="max-w-sm">
            <Wordmark />
            <p className="mt-3 text-sm text-muted">
              Live online auctions for watches, art, electronics, collectibles and sneakers. All prices in Indian rupees. A portfolio project — no real money changes hands.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Buy</span>
            <Link className="text-ink-soft hover:text-ink" to="/auctions">Live auctions</Link>
            <Link className="text-ink-soft hover:text-ink" to="/auctions?sort=ending_soon">Closing soon</Link>
            <Link className="text-ink-soft hover:text-ink" to="/auctions?status=COMPLETED">Past results</Link>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Sell &amp; learn</span>
            <Link className="text-ink-soft hover:text-ink" to="/sell">List an item</Link>
            <Link className="text-ink-soft hover:text-ink" to="/#how-bidding-works">How bidding works</Link>
            <a className="text-ink-soft hover:text-ink" href="/api/docs">API documentation</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
