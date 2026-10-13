import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '@/services/api';
import { fetchers, qk } from '@/services/queries';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { ErrorState, Skeleton } from '@/components/ui/Status';
import type { AuctionDetail } from '@/types/api';

const money = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter rupees with up to 2 decimal places').refine((v) => Number(v) > 0, 'Must be more than zero');
const schema = z
  .object({
    title: z.string().trim().min(3, 'At least 3 characters').max(120),
    description: z.string().trim().min(10, 'Describe condition, provenance and what’s included').max(5000),
    categoryId: z.string().min(1, 'Choose a department'),
    startingPrice: money,
    minimumBidIncrement: money,
    startTime: z.string().min(1, 'Choose a start time'),
    endTime: z.string().min(1, 'Choose an end time'),
  })
  .refine((v) => new Date(v.endTime) > new Date(v.startTime), { path: ['endTime'], message: 'End must be after the start' });
type FormValues = z.infer<typeof schema>;

/** <input type="datetime-local"> works in the viewer's local time; the API receives UTC ISO strings. */
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const toIso = (local: string) => new Date(local).toISOString();

export function SellPage() {
  const { id } = useParams();
  const editingId = id ? Number(id) : null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const categories = useQuery({ queryKey: qk.categories, queryFn: fetchers.categories });
  const existing = useQuery({ queryKey: qk.auction(editingId ?? 0), queryFn: () => fetchers.auction(editingId!), enabled: Boolean(editingId) });
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const now = new Date();
  const { register, handleSubmit, formState, reset, setError } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: '',
      description: '',
      categoryId: '',
      startingPrice: '',
      minimumBidIncrement: '100',
      startTime: toLocalInput(new Date(now.getTime() + 5 * 60_000)),
      endTime: toLocalInput(new Date(now.getTime() + 3 * 86_400_000)),
    },
  });

  // Load the existing listing into the form once it arrives (edit mode).
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const loaded = existing.data?.auction;
  if (loaded && loaded.version !== loadedVersion) {
    setLoadedVersion(loaded.version);
    setImages(loaded.images.map((i) => i.url));
  }
  useEffect(() => {
    const a = existing.data?.auction;
    if (!a) return;
    reset({
      title: a.title,
      description: a.description,
      categoryId: String(a.category.id),
      startingPrice: a.startingPrice,
      minimumBidIncrement: a.minimumBidIncrement,
      startTime: toLocalInput(new Date(a.startTime)),
      endTime: toLocalInput(new Date(a.endTime)),
    });
  }, [existing.data, reset]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 8 - images.length)) {
        if (file.size > 5 * 1024 * 1024) {
          toast.error(`${file.name} is larger than 5 MB`);
          continue;
        }
        const fd = new FormData();
        fd.append('image', file);
        const { data } = await api.post<{ url: string }>('/uploads/images', fd);
        setImages((prev) => [...prev, data.url]);
      }
    } catch (err) {
      toast.error('Upload failed', { description: errorMessage(err) });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = (publish: boolean) =>
    handleSubmit(async (v) => {
      setFormError(null);
      if (publish && images.length === 0) return setFormError('Add at least one photo before publishing.');
      const body = {
        title: v.title,
        description: v.description,
        categoryId: Number(v.categoryId),
        startingPrice: v.startingPrice,
        minimumBidIncrement: v.minimumBidIncrement,
        startTime: toIso(v.startTime),
        endTime: toIso(v.endTime),
        imageUrls: images,
      };
      try {
        let auction: AuctionDetail;
        if (editingId) {
          auction = (await api.patch<AuctionDetail>(`/auctions/${editingId}`, body)).data;
          if (publish && auction.status === 'DRAFT') auction = (await api.post<AuctionDetail>(`/auctions/${editingId}/publish`)).data;
        } else {
          auction = (await api.post<AuctionDetail>('/auctions', { ...body, publish })).data;
        }
        void qc.invalidateQueries();
        toast.success(publish ? (auction.status === 'ACTIVE' ? 'Published — bidding is open' : 'Published — scheduled to open') : 'Draft saved');
        navigate(`/auctions/${auction.id}`);
      } catch (err) {
        if (err instanceof ApiError && Array.isArray(err.details)) {
          for (const d of err.details as { path: string; message: string }[]) {
            if (d.path in body) setError(d.path as keyof FormValues, { message: d.message });
          }
        }
        setFormError(errorMessage(err));
      }
    })();

  if (editingId && existing.error) return <div className="mx-auto max-w-3xl px-4 py-16"><ErrorState message={errorMessage(existing.error)} /></div>;
  if (editingId && existing.isLoading) return <div className="mx-auto max-w-3xl px-4 py-16"><Skeleton className="h-96" /></div>;
  const err = formState.errors;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-4xl">{editingId ? 'Edit listing' : 'List an item'}</h1>
      <p className="mt-2 text-ink-soft">Drafts stay private until you publish. Times are in your local timezone.</p>
      <form className="mt-10 flex flex-col gap-8" onSubmit={(e) => { e.preventDefault(); void save(true); }} noValidate>
        {formError && <p role="alert" className="rounded-md bg-outbid-tint px-3 py-2 text-sm text-outbid">{formError}</p>}

        <section className="flex flex-col gap-5">
          <h2 className="text-2xl">Photos</h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {images.map((url, i) => (
              <div key={url} className="group relative aspect-square overflow-hidden rounded-md bg-line/40">
                <img src={url} alt={`Photo ${i + 1}`} className="size-full object-cover" />
                {i === 0 && <span className="absolute bottom-1 left-1 rounded-sm bg-paper/90 px-1.5 text-xs">Cover</span>}
                <button type="button" onClick={() => setImages((p) => p.filter((u) => u !== url))} aria-label={`Remove photo ${i + 1}`} className="absolute right-1 top-1 grid size-7 place-items-center rounded-full bg-paper/90 text-ink-soft hover:text-outbid">
                  <X className="size-4" />
                </button>
              </div>
            ))}
            {images.length < 8 && (
              <button type="button" onClick={() => fileRef.current?.click()} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-strong text-sm text-muted hover:border-ink-soft hover:text-ink" disabled={uploading}>
                {uploading ? <Loader2 className="size-6 animate-spin" aria-hidden /> : <ImagePlus className="size-6" aria-hidden />}
                {uploading ? 'Uploading…' : 'Add photos'}
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={(e) => void upload(e.target.files)} aria-label="Upload photos" />
          <p className="text-xs text-muted">JPEG, PNG or WebP, up to 5 MB each, at most 8. The first photo is the cover.</p>
        </section>

        <section className="flex flex-col gap-5">
          <h2 className="text-2xl">Details</h2>
          <Field label="Title" error={err.title?.message}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} aria-invalid={Boolean(err.title)} {...register('title')} />}</Field>
          <Field label="Department" error={err.categoryId?.message}>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} aria-invalid={Boolean(err.categoryId)} {...register('categoryId')}>
                <option value="">Choose…</option>
                {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Description" hint="Condition, provenance, what’s included." error={err.description?.message}>
            {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} aria-invalid={Boolean(err.description)} {...register('description')} />}
          </Field>
        </section>

        <section className="grid gap-5 sm:grid-cols-2">
          <h2 className="text-2xl sm:col-span-2">Price and timing</h2>
          <Field label="Starting price (₹)" error={err.startingPrice?.message}>{({ id, describedBy }) => <Input id={id} inputMode="decimal" className="tabular" aria-describedby={describedBy} aria-invalid={Boolean(err.startingPrice)} {...register('startingPrice')} />}</Field>
          <Field label="Minimum increment (₹)" hint="Each new bid must beat the last by at least this much." error={err.minimumBidIncrement?.message}>{({ id, describedBy }) => <Input id={id} inputMode="decimal" className="tabular" aria-describedby={describedBy} aria-invalid={Boolean(err.minimumBidIncrement)} {...register('minimumBidIncrement')} />}</Field>
          <Field label="Bidding opens" error={err.startTime?.message}>{({ id, describedBy }) => <Input id={id} type="datetime-local" aria-describedby={describedBy} aria-invalid={Boolean(err.startTime)} {...register('startTime')} />}</Field>
          <Field label="Bidding closes" error={err.endTime?.message}>{({ id, describedBy }) => <Input id={id} type="datetime-local" aria-describedby={describedBy} aria-invalid={Boolean(err.endTime)} {...register('endTime')} />}</Field>
        </section>

        <div className="flex flex-wrap justify-end gap-3 border-t border-line pt-6">
          <Button type="button" variant="secondary" size="lg" onClick={() => void save(false)} loading={formState.isSubmitting}>Save draft</Button>
          <Button type="submit" size="lg" loading={formState.isSubmitting}>Publish</Button>
        </div>
      </form>
    </div>
  );
}
