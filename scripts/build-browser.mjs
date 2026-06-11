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

const bundledExamplesPlugin = {
  name: 'bundled-examples',
  setup(build) {
    build.onResolve({ filter: /^bundled-examples$/ }, () => ({ path: 'bundled-examples', namespace: 'bundled-examples' }));
    build.onLoad({ filter: /.*/, namespace: 'bundled-examples' }, async () => {
      const entries = await readdir('examples', { withFileTypes: true });
      const examples = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'src') {
          continue;
        }

        const dir = join('examples', entry.name);
        const files = await readdir(dir);
        if (!files.includes('ontology.n3')) {
          continue;
        }

        const inputFile = ['input.trig', 'input.n3', 'input.ttl', 'input.messages.trig']
          .find((candidate) => files.includes(candidate));
        if (!inputFile) {
          continue;
        }

        examples.push({
          id: entry.name,
          label: humanizeExampleId(entry.name),
          backgroundFile: `examples/${entry.name}/ontology.n3`,
          dataFile: `examples/${entry.name}/${inputFile}`,
          background: await readFile(join(dir, 'ontology.n3'), 'utf8'),
          data: await readFile(join(dir, inputFile), 'utf8'),
        });
      }

      examples.sort((left, right) => left.label.localeCompare(right.label));

      return {
        contents: `export const bundledExamples = ${JSON.stringify(examples)};`,
        loader: 'js',
      };
    });
  },
};

function humanizeExampleId(id) {
  const overrides = {
    'transit-fleet': 'Transit fleet (OWL/RDFS)',
    'shipment-logistics': 'Shipment logistics (OWL 2 RL)',
    'skos-taxonomy': 'SKOS taxonomy (SKOS Core)',
    'owl-skos-catalog': 'Catalog topics (OWL 2 RL + SKOS Core)',
    'transit-messages': 'Transit stream (RDF Messages)',
    'stateful-materialization': 'Stateful materialization (RDF Messages)',
  };
  return overrides[id] ?? id.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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
  plugins: [bundledRulesPlugin, bundledExamplesPlugin],
  loader: {
    '.n3': 'text',
    '.trig': 'text',
  },
});
