import { useState } from 'react';
import { cn } from '@/utils/cn';

export function ImageGallery({ images, title }: { images: { id: number; url: string; alt: string | null }[]; title: string }) {
  const [active, setActive] = useState(0);
  const current = images[active] ?? images[0];
  if (!current) return <div className="aspect-square rounded-lg bg-line/50" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-lg bg-line/40">
        <img src={current.url} alt={current.alt ?? title} className="size-full object-cover" />
      </div>
      {images.length > 1 && (
        <div className="flex gap-3" role="tablist" aria-label="Images">
          {images.map((img, i) => (
            <button
              key={img.id}
              role="tab"
              aria-selected={i === active}
              aria-label={`Image ${i + 1} of ${images.length}`}
              onClick={() => setActive(i)}
              className={cn('size-20 overflow-hidden rounded-md border-2 transition-colors', i === active ? 'border-ink' : 'border-transparent opacity-70 hover:opacity-100')}
            >
              <img src={img.url} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
