import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';

export default function NotFound() {
  return (
    <main id="main-content" className="not-found">
      <Link href="/" className="wordmark">
        <span className="station" aria-hidden="true" />
        dgateway<span className="wordmark-meta">/ docs</span>
      </Link>
      <div className="end-of-line" aria-hidden="true">
        <span />
        <i />
      </div>
      <h1>This page isn’t on the map.</h1>
      <p className="not-found-code">404 / End of the line</p>
      <p>
        The link may have changed, or the address may be incomplete. Pick up your route in the
        documentation.
      </p>
      <div className="landing-actions">
        <Link className="primary-link" href="/docs">
          Open the docs <ArrowRight size={18} aria-hidden="true" />
        </Link>
        <Link className="text-link" href="/">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to home
        </Link>
      </div>
    </main>
  );
}
