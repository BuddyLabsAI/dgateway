'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function LandingMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) return;
    Promise.all([import('./landing-motion-engine'), document.fonts.ready])
      .then(([motion]) => {
        if (!disposed && !preference.matches && root.current)
          stop = motion.startLandingMotion(root.current);
      })
      .catch(() => stop?.());
    const reduce = () => {
      if (preference.matches) stop?.();
    };
    preference.addEventListener('change', reduce);
    return () => {
      disposed = true;
      preference.removeEventListener('change', reduce);
      stop?.();
    };
  }, []);
  return (
    <main ref={root} id="main-content" className="landing">
      {children}
    </main>
  );
}
