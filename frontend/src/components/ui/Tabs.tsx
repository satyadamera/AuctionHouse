import * as RTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export function Tabs({ value, onValueChange, tabs, children }: { value: string; onValueChange: (v: string) => void; tabs: { value: string; label: ReactNode }[]; children: ReactNode }) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange}>
      <RTabs.List className="flex gap-6 overflow-x-auto border-b border-line" aria-label="Sections">
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 border-transparent pb-3 pt-1 text-sm font-medium text-muted transition-colors hover:text-ink',
              'data-[state=active]:border-ink data-[state=active]:text-ink',
            )}
          >
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}
export const TabPanel = ({ value, children }: { value: string; children: ReactNode }) => (
  <RTabs.Content value={value} className="pt-8 focus-visible:outline-none">
    {children}
  </RTabs.Content>
);
