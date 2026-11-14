import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="wordmark">
          <span aria-hidden="true" className="station" />
          dgateway<span className="wordmark-meta">/ docs</span>
        </span>
      ),
    },
    themeSwitch: { enabled: false },
    links: [
      { text: 'Guides', url: '/docs/guides/getting-started', active: 'nested-url' },
      { text: 'API reference', url: '/docs/reference/decisions', active: 'nested-url' },
    ],
  };
}
