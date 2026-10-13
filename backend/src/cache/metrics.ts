/**
 * In-process cache metrics. Good enough for a single instance and for the demo scripts; in
 * production these would be exported to Prometheus/OpenTelemetry instead.
 */
interface Counter {
  hits: number;
  misses: number;
  errors: number;
  skippedStaleWrites: number;
}

const byArea = new Map<string, Counter>();

function counter(area: string): Counter {
  let c = byArea.get(area);
  if (!c) {
    c = { hits: 0, misses: 0, errors: 0, skippedStaleWrites: 0 };
    byArea.set(area, c);
  }
  return c;
}

export const cacheMetrics = {
  hit: (area: string) => void counter(area).hits++,
  miss: (area: string) => void counter(area).misses++,
  error: (area: string) => void counter(area).errors++,
  staleWriteSkipped: (area: string) => void counter(area).skippedStaleWrites++,
  snapshot() {
    const areas: Record<string, Counter & { hitRate: number | null }> = {};
    let hits = 0;
    let misses = 0;
    for (const [area, c] of byArea) {
      const total = c.hits + c.misses;
      areas[area] = { ...c, hitRate: total ? +(c.hits / total).toFixed(4) : null };
      hits += c.hits;
      misses += c.misses;
    }
    const total = hits + misses;
    return { hits, misses, hitRate: total ? +(hits / total).toFixed(4) : null, areas };
  },
  reset: () => byArea.clear(),
};
