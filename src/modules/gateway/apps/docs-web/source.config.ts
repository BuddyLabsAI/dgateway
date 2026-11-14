import { defineConfig } from 'fumadocs-mdx/config';

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: 'github-light',
        dark: {
          name: 'dgateway-night',
          type: 'dark',
          colors: { 'editor.background': '#080d17', 'editor.foreground': '#e8eef8' },
          tokenColors: [
            {
              scope: ['comment', 'punctuation.definition.comment'],
              settings: { foreground: '#8a98b1' },
            },
            { scope: ['string', 'constant.other.symbol'], settings: { foreground: '#7fd8be' } },
            {
              scope: ['support.type.property-name', 'meta.object-literal.key', 'entity.name.tag'],
              settings: { foreground: '#8fb0ff' },
            },
            { scope: ['constant.numeric'], settings: { foreground: '#f0b97a' } },
            {
              scope: ['keyword', 'storage', 'constant.language'],
              settings: { foreground: '#c4a5ff' },
            },
            {
              scope: ['entity.name.function', 'support.function'],
              settings: { foreground: '#8fb0ff' },
            },
            { scope: ['punctuation'], settings: { foreground: '#b0bdd2' } },
          ],
        },
      },
      transformers: [
        {
          pre(node) {
            node.properties['data-language'] = this.options.lang;
          },
        },
      ],
    },
  },
});
