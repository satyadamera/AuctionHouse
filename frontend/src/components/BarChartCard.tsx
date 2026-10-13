import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type Row = Record<string, string | number>;

interface Props {
  title: string;
  data: Row[];
  xKey: string;
  yKey: string;
  yLabel: string;
  formatX?: (v: string) => string;
  layout?: 'vertical' | 'horizontal';
  emptyText?: string;
}

/**
 * One-series bar chart: thin bars with rounded data-ends, recessive grid, hover tooltip, and a
 * table view for screen readers and anyone who prefers numbers. One series → the title names it,
 * no legend box.
 */
export function BarChartCard({ title, data, xKey, yKey, yLabel, formatX = (v) => v, layout = 'horizontal', emptyText = 'No data yet.' }: Props) {
  const vertical = layout === 'vertical';
  return (
    <figure className="rounded-lg border border-line bg-paper p-5">
      <figcaption className="font-serif text-xl">{title}</figcaption>
      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">{emptyText}</p>
      ) : (
        <div className={vertical ? 'mt-4 h-64' : 'mt-4 h-56'}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout={vertical ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, bottom: 0, left: vertical ? 8 : -16 }} barCategoryGap={vertical ? 6 : 2}>
              <CartesianGrid stroke="var(--color-line)" strokeDasharray="0" vertical={vertical} horizontal={!vertical} />
              {vertical ? (
                <>
                  <XAxis type="number" allowDecimals={false} tick={{ fill: 'var(--color-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey={xKey} width={96} tick={{ fill: 'var(--color-ink-soft)', fontSize: 12 }} axisLine={false} tickLine={false} />
                </>
              ) : (
                <>
                  <XAxis dataKey={xKey} tickFormatter={formatX} tick={{ fill: 'var(--color-muted)', fontSize: 12 }} axisLine={{ stroke: 'var(--color-line-strong)' }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fill: 'var(--color-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
                </>
              )}
              <Tooltip
                cursor={{ fill: 'var(--color-ink)', fillOpacity: 0.04 }}
                labelFormatter={(l) => (vertical ? String(l) : formatX(String(l)))}
                formatter={(v) => [String(v), yLabel]}
                contentStyle={{ borderRadius: 8, border: '1px solid var(--color-line)', fontSize: 13 }}
              />
              <Bar dataKey={yKey} fill="var(--color-chart)" radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={vertical ? 18 : 28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {data.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">Show as table</summary>
          <table className="tabular mt-2 w-full text-left">
            <thead>
              <tr className="border-b border-line text-muted"><th className="py-1 font-normal">{vertical ? 'Name' : 'Day'}</th><th className="py-1 text-right font-normal">{yLabel}</th></tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={String(d[xKey])} className="border-b border-line/60"><td className="py-1">{formatX(String(d[xKey]))}</td><td className="py-1 text-right">{d[yKey]}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}

export const formatDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
