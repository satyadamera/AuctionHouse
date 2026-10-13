import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <p className="font-serif text-6xl text-baize">404</p>
      <h1 className="mt-4 text-3xl">This page isn’t in the catalogue</h1>
      <p className="mt-3 text-ink-soft">The link may be mistyped, or the lot may have been a private draft.</p>
      <Link to="/auctions" className="mt-8 inline-flex h-11 items-center rounded-md bg-baize px-5 font-medium text-porcelain hover:bg-baize-deep">Browse live lots</Link>
    </div>
  );
}
