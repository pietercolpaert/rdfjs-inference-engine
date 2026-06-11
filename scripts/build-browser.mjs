import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

await mkdir('browser', { recursive: true });

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'info',
};

const bundledRulesPlugin = {
  name: 'bundled-rules',
  setup(build) {
    build.onResolve({ filter: /^bundled-rules$/ }, () => ({ path: 'bundled-rules', namespace: 'bundled-rules' }));
    build.onLoad({ filter: /.*/, namespace: 'bundled-rules' }, async () => {
      const files = (await readdir('rules')).filter((file) => file.endsWith('.n3')).sort();
      const parts = [];
      for (const file of files) {
        const text = await readFile(join('rules', file), 'utf8');
        parts.push(`# Source: rules/${file}\n${text.trimEnd()}`);
      }

      return {
        contents: [
          `export const bundledRuleFiles = ${JSON.stringify(files)};`,
          `export const bundledRules = ${JSON.stringify(parts.join('\n\n'))};`,
        ].join('\n'),
        loader: 'js',
      };
    });
  },
};

await build({
  ...common,
  entryPoints: ['browser-src/index.ts'],
  outfile: 'browser/rdfjs-inference-engine.min.js',
  format: 'iife',
  globalName: 'RdfjsInferenceEngine',
});

await build({
  ...common,
  entryPoints: ['browser-src/playground.ts'],
  outfile: 'browser/playground.min.js',
  format: 'iife',
  plugins: [bundledRulesPlugin],
  loader: {
    '.n3': 'text',
    '.trig': 'text',
  },
});
