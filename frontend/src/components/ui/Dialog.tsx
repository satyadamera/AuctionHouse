import * as RDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Dialog({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-ink/40 data-[state=open]:animate-in" />
        <RDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-paper p-6 shadow-2xl focus-visible:outline-none">
          <div className="flex items-start justify-between gap-4">
            <RDialog.Title className="font-serif text-2xl">{title}</RDialog.Title>
            <RDialog.Close className="-m-1 rounded p-1 text-muted hover:text-ink" aria-label="Close">
              <X className="size-5" />
            </RDialog.Close>
          </div>
          {description ? <RDialog.Description className="mt-2 text-sm text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
          <div className="mt-5">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
