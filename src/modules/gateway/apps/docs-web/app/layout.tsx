import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Provider } from '@/components/provider';
import './global.css';

export const metadata: Metadata = {
  title: { default: 'dgateway documentation', template: '%s · dgateway' },
  description: 'Unified self-hosted API gateway for decision models.',
  icons: { icon: `${process.env.NEXT_PUBLIC_DOCS_BASE_PATH}/icon.svg` },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
