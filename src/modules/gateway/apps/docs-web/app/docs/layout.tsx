import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      links={[]}
      sidebar={{
        defaultOpenLevel: 2,
        footer: (
          <p className="sidebar-note">
            Self-hosted. OpenAI-shaped.
            <br />
            Free under the MIT license.
          </p>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
