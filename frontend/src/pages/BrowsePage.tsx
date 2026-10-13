import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SlidersHorizontal, X } from 'lucide-react';
import { fetchers, qk, type BrowseParams } from '@/services/queries';
import { AuctionGrid } from '@/features/auctions/AuctionCard';
import { EmptyState, ErrorState } from '@/components/ui/Status';
import { Select } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils/cn';

const SORTS = [
  ['ending_soon', 'Ending soonest'],
  ['newest', 'Newly listed'],
  ['price_asc', 'Price: low to high'],
  ['price_desc', 'Price: high to low'],
  ['most_bids', 'Most bids'],
] as const;
const STATUSES = [
  ['ACTIVE', 'Live now'],
  ['SCHEDULED', 'Opening soon'],
  ['COMPLETED', 'Results'],
  ['ALL', 'Everything'],
] as const;

/** All filter state lives in the URL, so results are shareable and the back button works. */
export function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const browse: BrowseParams = {
    q: params.get('q') ?? undefined,
    category: params.get('category') ?? undefined,
    status: (params.get('status') as BrowseParams['status']) ?? 'ACTIVE',
    sort: (params.get('sort') as BrowseParams['sort']) ?? 'ending_soon',
    minPrice: params.get('minPrice') ? Number(params.get('minPrice')) : undefined,
    maxPrice: params.get('maxPrice') ? Number(params.get('maxPrice')) : undefined,
    featured: params.get('featured') === 'true' || undefined,
    page: Number(params.get('page') ?? 1),
    pageSize: 12,
  };
  const query = useQuery({ queryKey: qk.browse(browse as Record<string, unknown>), queryFn: () => fetchers.browse(browse), placeholderData: keepPreviousData });
  const categories = useQuery({ queryKey: qk.categories, queryFn: fetchers.categories });

  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };

  const [minPrice, setMinPrice] = useState(params.get('minPrice') ?? '');
  const [maxPrice, setMaxPrice] = useState(params.get('maxPrice') ?? '');
  const [q, setQ] = useState(browse.q ?? '');
  // Keep the search box in sync when the URL changes (e.g. header search, back button).
  const [prevUrlQ, setPrevUrlQ] = useState(browse.q ?? '');
  if (prevUrlQ !== (browse.q ?? '')) {
    setPrevUrlQ(browse.q ?? '');
    setQ(browse.q ?? '');
  }

  const applyPrice = (e: FormEvent) => {
    e.preventDefault();
    set({ minPrice: minPrice || undefined, maxPrice: maxPrice || undefined });
  };

  const meta = query.data?.meta;
  const categoryName = categories.data?.find((c) => c.slug === browse.category)?.name;
  const heading = browse.q ? `Results for “${browse.q}”` : categoryName ?? (browse.status === 'COMPLETED' ? 'Past results' : browse.status === 'SCHEDULED' ? 'Opening soon' : browse.featured ? 'Featured lots' : 'Live auctions');
  const activeFilters = [browse.q && 'q', browse.category && 'category', browse.minPrice !== undefined && 'minPrice', browse.maxPrice !== undefined && 'maxPrice', browse.featured && 'featured'].filter(Boolean) as string[];

  const filters = (
    <div className="flex flex-col gap-8">
      <form onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() || undefined }); }} role="search">
        <label htmlFor="browse-q" className="text-sm font-medium">Search</label>
        <input id="browse-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title contains…" className="mt-2 h-10 w-full rounded-md border border-line-strong bg-paper px-3 text-sm focus:border-baize focus:outline-none" />
      </form>
      <fieldset>
        <legend className="text-sm font-medium">Status</legend>
        <div className="mt-2 flex flex-col gap-1">
          {STATUSES.map(([v, label]) => (
            <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-ink/[0.03]">
              <input type="radio" name="status" checked={browse.status === v} onChange={() => set({ status: v === 'ACTIVE' ? undefined : v })} className="accent-baize" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-medium">Department</legend>
        <div className="mt-2 flex flex-col gap-1">
          <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-ink/[0.03]">
            <input type="radio" name="category" checked={!browse.category} onChange={() => set({ category: undefined })} className="accent-baize" />
            All departments
          </label>
          {categories.data?.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm hover:bg-ink/[0.03]">
              <span className="flex items-center gap-2">
                <input type="radio" name="category" checked={browse.category === c.slug} onChange={() => set({ category: c.slug })} className="accent-baize" />
                {c.name}
              </span>
              <span className="tabular text-xs text-muted">{c.liveCount}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <form onSubmit={applyPrice}>
        <fieldset>
          <legend className="text-sm font-medium">Price (₹)</legend>
          <div className="mt-2 flex items-center gap-2">
            <input inputMode="numeric" aria-label="Minimum price" placeholder="Min" value={minPrice} onChange={(e) => setMinPrice(e.target.value.replace(/[^\d]/g, ''))} className="tabular h-10 w-full rounded-md border border-line-strong bg-paper px-3 text-sm" />
            <span className="text-muted" aria-hidden>to</span>
            <input inputMode="numeric" aria-label="Maximum price" placeholder="Max" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^\d]/g, ''))} className="tabular h-10 w-full rounded-md border border-line-strong bg-paper px-3 text-sm" />
          </div>
          <Button type="submit" variant="secondary" size="sm" className="mt-3 w-full">Apply price</Button>
        </fieldset>
      </form>
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <h1 className="text-4xl">{heading}</h1>
          <p className="mt-2 text-sm text-muted" aria-live="polite">
            {meta ? `${meta.total} ${meta.total === 1 ? 'lot' : 'lots'}` : ' '}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="lg:hidden" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}>
            <SlidersHorizontal className="size-4" aria-hidden /> Filters
          </Button>
          <label htmlFor="sort" className="sr-only">Sort by</label>
          <Select id="sort" value={browse.sort} onChange={(e) => set({ sort: e.target.value === 'ending_soon' ? undefined : e.target.value })} className="w-48">
            {SORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </Select>
        </div>
      </div>
      {activeFilters.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {browse.q && <Chip onRemove={() => set({ q: undefined })}>“{browse.q}”</Chip>}
          {categoryName && <Chip onRemove={() => set({ category: undefined })}>{categoryName}</Chip>}
          {(browse.minPrice !== undefined || browse.maxPrice !== undefined) && (
            <Chip onRemove={() => { setMinPrice(''); setMaxPrice(''); set({ minPrice: undefined, maxPrice: undefined }); }}>
              ₹{browse.minPrice ?? 0} – {browse.maxPrice !== undefined ? `₹${browse.maxPrice}` : 'any'}
            </Chip>
          )}
          {browse.featured && <Chip onRemove={() => set({ featured: undefined })}>Featured</Chip>}
        </div>
      )}
      <div className="mt-8 grid gap-10 lg:grid-cols-[14rem_1fr]">
        <aside className={cn(filtersOpen ? 'block' : 'hidden', 'lg:block')} aria-label="Filters">{filters}</aside>
        <div className={cn(query.isFetching && query.isPlaceholderData && 'opacity-60 transition-opacity')}>
          {query.error ? (
            <ErrorState message="The listings could not be loaded." onRetry={() => void query.refetch()} />
          ) : query.data && query.data.items.length === 0 ? (
            <EmptyState title="No lots match" action={<Button variant="secondary" onClick={() => setParams(new URLSearchParams())}>Clear all filters</Button>}>
              Try a different department, widen the price range, or include lots that are opening soon.
            </EmptyState>
          ) : (
            <AuctionGrid items={query.data?.items} loading={query.isLoading} columns={3} />
          )}
          {meta && meta.totalPages > 1 && (
            <nav className="mt-12 flex items-center justify-between border-t border-line pt-6" aria-label="Pagination">
              <Button variant="secondary" disabled={meta.page <= 1} onClick={() => set({ page: String(meta.page - 1) })}>Previous</Button>
              <span className="tabular text-sm text-muted">Page {meta.page} of {meta.totalPages}</span>
              <Button variant="secondary" disabled={meta.page >= meta.totalPages} onClick={() => set({ page: String(meta.page + 1) })}>Next</Button>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-paper py-1 pl-3 pr-1 text-sm">
      {children}
      <button onClick={onRemove} className="grid size-6 place-items-center rounded-full hover:bg-ink/5" aria-label="Remove filter">
        <X className="size-3.5" />
      </button>
    </span>
  );
}
