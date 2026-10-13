import { formatINR } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * The saleroom board: each digit is a vertical strip of 0–9 that slides to its new value, so a new
 * bid visibly "rolls" the price like a mechanical indicator. Purely presentational — screen readers
 * get the plain formatted amount. Reduced-motion users get an instant change (global CSS rule).
 */
export function PriceRoll({ amount, className }: { amount: string | null; className?: string }) {
  const text = formatINR(amount);
  return (
    <span className={cn('tabular relative inline-flex overflow-hidden leading-none', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex">
        {text.split('').map((ch, i) =>
          /\d/.test(ch) ? (
            <span key={`${text.length}-${i}`} className="relative inline-block h-[1em] w-[0.62em] overflow-hidden">
              <span
                className="absolute left-0 top-0 flex flex-col transition-transform duration-700 ease-[cubic-bezier(.2,.8,.2,1)]"
                style={{ transform: `translateY(-${Number(ch)}em)` }}
              >
                {'0123456789'.split('').map((d) => (
                  <span key={d} className="block h-[1em] text-center">
                    {d}
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span key={`${text.length}-${i}`} className="inline-block h-[1em]">
              {ch}
            </span>
          ),
        )}
      </span>
    </span>
  );
}
