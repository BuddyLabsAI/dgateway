import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import type { ComponentProps } from 'react';
import type { MDXComponents } from 'mdx/types';

function DocsCodeBlock(props: ComponentProps<'pre'> & { 'data-language'?: string }) {
  const language = props['data-language'];
  const labels: Record<string, string> = {
    sh: 'Shell',
    bash: 'Shell',
    ts: 'TypeScript',
    json: 'JSON',
    jsonc: 'JSON with comments',
  };
  return (
    <CodeBlock
      {...props}
      title={props.title ?? (language ? (labels[language] ?? language) : 'Code')}
      viewportProps={{ 'aria-label': `${language ?? 'Code'} example` }}
    >
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    pre: DocsCodeBlock,
    Callout: (props: ComponentProps<typeof Callout>) => (
      <Callout {...props} className="docs-callout" />
    ),
    table: (props: ComponentProps<'table'>) => (
      <div className="table-scroll" role="region" aria-label="Reference table" tabIndex={0}>
        <table {...props} />
      </div>
    ),
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
