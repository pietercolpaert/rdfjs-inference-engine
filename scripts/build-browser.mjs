import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

const browserNodePolyfillsPlugin = {
  name: 'browser-node-polyfills',
  setup(build) {
    const aliases = new Map([
      ['http', 'stream-http'],
      ['https', 'https-browserify'],
      ['stream', 'stream-browserify'],
    ]);

    build.onResolve({ filter: /^(http|https|stream)$/ }, (args) => ({
      path: require.resolve(aliases.get(args.path)),
    }));
  },
};

await mkdir('browser', { recursive: true });

const nonDefaultRuleDirs = new Set(['precompiled', 'shacl-experimental']);

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'browser',
  target: ['es2020'],
  // Escape multiline strings so generated bundles have no trailing whitespace.
  // Trimming the output would corrupt significant spaces inside string literals.
  supported: { 'template-literal': false },
  define: {
    global: 'globalThis',
  },
  inject: ['browser-src/node-globals.ts'],
  legalComments: 'none',
  logLevel: 'info',
};

const bundledRulesPlugin = {
  name: 'bundled-rules',
  setup(build) {
    build.onResolve({ filter: /^bundled-rules$/ }, () => ({ path: 'bundled-rules', namespace: 'bundled-rules' }));
    build.onLoad({ filter: /.*/, namespace: 'bundled-rules' }, async () => {
      const files = await discoverBundledRuleFiles('rules');
      const profiles = [];
      for (const file of files) {
        const text = await readFile(join('rules', file), 'utf8');
        const precompiledPath = join('rules', file.replace(/\.n3$/, '.runtime.n3'));
        profiles.push({
          file,
          n3: `# Source: rules/${file}\n${text.trimEnd()}`,
          precompiledRuntime: await fileExists(precompiledPath) ? await readFile(precompiledPath, 'utf8') : undefined,
        });
      }

      return {
        contents: [
          `export const bundledRuleFiles = ${JSON.stringify(files)};`,
          `export const bundledRuleProfiles = ${JSON.stringify(profiles)};`,
          `export const bundledRules = bundledRuleProfiles.map((profile) => profile.n3).join(${JSON.stringify('\n\n')});`,
        ].join('\n'),
        loader: 'js',
      };
    });
  },
};

async function discoverBundledRuleFiles(rulesDir) {
  const files = [];
  for (const entry of await readdir(rulesDir, { withFileTypes: true })) {
    if (entry.isFile() && isRuleProfileFile(entry.name)) {
      files.push(entry.name);
      continue;
    }

    if (!entry.isDirectory() || nonDefaultRuleDirs.has(entry.name)) {
      continue;
    }

    const dir = join(rulesDir, entry.name);
    for (const file of await readdir(dir)) {
      if (isRuleProfileFile(file)) {
        files.push(`${entry.name}/${file}`);
      }
    }
  }

  return files.sort();
}

function isRuleProfileFile(file) {
  return file.endsWith('.n3') && !file.endsWith('.runtime.n3');
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const bundledExamplesPlugin = {
  name: 'bundled-examples',
  setup(build) {
    build.onResolve({ filter: /^bundled-examples$/ }, () => ({ path: 'bundled-examples', namespace: 'bundled-examples' }));
    build.onLoad({ filter: /.*/, namespace: 'bundled-examples' }, async () => {
      const examples = [];
      const ids = new Set();
      async function collectExamples(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
        const backgroundFile = ['ontology.n3', 'ontology.ttl', 'shapes.n3', 'shapes.ttl']
          .find(candidate => files.includes(candidate));
        const inputFile = ['input.messages.trig', 'input.trig', 'input.n3', 'input.ttl']
          .find(candidate => files.includes(candidate));
        if (backgroundFile && inputFile) {
          const id = dir.split('/').at(-1);
          if (ids.has(id)) throw new Error(`Duplicate playground example ID: ${id}`);
          ids.add(id);
          const shaclInFile = ['shapes-in.n3', 'shapes-in.ttl'].find(file => files.includes(file));
          const shaclOutFile = ['shapes-out.n3', 'shapes-out.ttl'].find(file => files.includes(file));
          if (!shaclInFile || !shaclOutFile) {
            throw new Error(`Playground example ${id} must provide provider and consumer SHACL shapes.`);
          }
          const metadata = files.includes('example.json')
            ? JSON.parse(await readFile(join(dir, 'example.json'), 'utf8')) : {};
          examples.push({
            id,
            label: metadata.label ?? humanizeExampleId(id),
            description: metadata.description ?? `Load ${humanizeExampleId(id)} with its ontology, provider and consumer SHACL, and input data.`,
            backgroundFile: join(dir, backgroundFile),
            dataFile: join(dir, inputFile),
            background: await readFile(join(dir, backgroundFile), 'utf8'),
            data: await readFile(join(dir, inputFile), 'utf8'),
            shaclInFile: join(dir, shaclInFile),
            shaclOutFile: join(dir, shaclOutFile),
            shaclIn: await readFile(join(dir, shaclInFile), 'utf8'),
            shaclOut: await readFile(join(dir, shaclOutFile), 'utf8'),
          });
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== 'src') await collectExamples(join(dir, entry.name));
        }
      }
      await collectExamples('examples');

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
    'inconsistency-diagnostics': 'Inconsistency diagnostics (OWL 2 RL)',
    'shacl-shape-planning': 'SHACL shape planning (SHACL in/out hints)',
    'transit-messages': 'Transit stream (RDF Messages)',
    'stateful-materialization': 'Stateful materialization (RDF Messages)',
    'waterinfo-ghent-terneuzen': 'Waterinfo Gent-Terneuzen canal (QUDT/CDT)',
  };
  return overrides[id] ?? id.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

await build({
  ...common,
  entryPoints: ['browser-src/index.ts'],
  outfile: 'browser/rdfjs-inference-engine.min.js',
  format: 'iife',
  globalName: 'RdfjsInferenceEngine',
  plugins: [browserNodePolyfillsPlugin, bundledRulesPlugin],
});

await build({
  ...common,
  entryPoints: ['browser-src/playground.ts'],
  outfile: 'browser/playground.min.js',
  format: 'iife',
  plugins: [browserNodePolyfillsPlugin, bundledRulesPlugin, bundledExamplesPlugin],
  loader: {
    '.n3': 'text',
    '.trig': 'text',
  },
});

await build({
  ...common,
  entryPoints: ['browser-src/sparql-construct-playground.ts'],
  outfile: 'browser/sparql-construct-playground.min.js',
  format: 'iife',
  plugins: [bundledExamplesPlugin],
});

await build({
  ...common,
  entryPoints: ['browser-src/sparql-construct-worker.ts'],
  outfile: 'browser/sparql-construct-worker.min.js',
  format: 'iife',
  plugins: [browserNodePolyfillsPlugin],
});
