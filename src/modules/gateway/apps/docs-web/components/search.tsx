'use client';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogFooter,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useStaticSearch } from 'fumadocs-core/search/client';
import { useI18n } from 'fumadocs-ui/contexts/i18n';

export default function DefaultSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const search = useStaticSearch({
    locale,
    from: `${process.env.NEXT_PUBLIC_DOCS_BASE_PATH}/search-index.json`,
  });

  return (
    <SearchDialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent className="docs-search">
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput
            placeholder="Search guides, endpoints, and examples…"
            aria-label="Search documentation"
          />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList
          defaultItems={[
            {
              id: 'start',
              type: 'page',
              url: '/docs/guides/getting-started',
              content: 'Getting started',
            },
            {
              id: 'decisions',
              type: 'page',
              url: '/docs/reference/decisions',
              content: 'Decisions API',
            },
            {
              id: 'routing',
              type: 'page',
              url: '/docs/guides/routing',
              content: 'Routing and fallback',
            },
          ]}
          Empty={() => (
            <div className="search-empty" role="status">
              <strong>No matching pages</strong>
              <p>Try a topic such as “providers”, “cost” or “client keys”.</p>
            </div>
          )}
        />
        <SearchDialogFooter className="search-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
