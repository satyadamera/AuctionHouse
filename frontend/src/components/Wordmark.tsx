import { Link } from 'react-router-dom';

export function Wordmark() {
  return (
    <Link to="/" className="group inline-flex items-baseline gap-1 font-serif text-2xl font-medium tracking-tight text-ink" aria-label="Auctra home">
      Auctra
      <span className="size-1.5 rounded-full bg-brass transition-transform group-hover:scale-125" aria-hidden />
    </Link>
  );
}
