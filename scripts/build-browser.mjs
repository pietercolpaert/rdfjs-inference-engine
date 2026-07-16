import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

await mkdir('browser', { recursive: true });

const nonDefaultRuleDirs = new Set(['precompiled', 'shacl-experimental']);

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
      const entries = await readdir('examples', { withFileTypes: true });
      const examples = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'src') {
          continue;
        }

        const dir = join('examples', entry.name);
        const files = await readdir(dir);
        const backgroundFile = ['ontology.n3', 'shapes.n3']
          .find((candidate) => files.includes(candidate));
        if (!backgroundFile) {
          continue;
        }

        const inputFile = ['input.messages.trig', 'input.trig', 'input.n3', 'input.ttl']
          .find((candidate) => files.includes(candidate));
        if (!inputFile) {
          continue;
        }

        const shaclInFile = files.includes('shapes-in.n3') ? 'shapes-in.n3' : undefined;
        const shaclOutFile = files.includes('shapes-out.n3') ? 'shapes-out.n3' : undefined;
        if (!shaclInFile || !shaclOutFile) {
          throw new Error(`Playground example ${entry.name} must provide shapes-in.n3 and shapes-out.n3.`);
        }

        examples.push({
          id: entry.name,
          label: humanizeExampleId(entry.name),
          backgroundFile: `examples/${entry.name}/${backgroundFile}`,
          dataFile: `examples/${entry.name}/${inputFile}`,
          background: await readFile(join(dir, backgroundFile), 'utf8'),
          data: await readFile(join(dir, inputFile), 'utf8'),
          shaclInFile: shaclInFile ? `examples/${entry.name}/${shaclInFile}` : undefined,
          shaclOutFile: shaclOutFile ? `examples/${entry.name}/${shaclOutFile}` : undefined,
          shaclIn: shaclInFile ? await readFile(join(dir, shaclInFile), 'utf8') : undefined,
          shaclOut: shaclOutFile ? await readFile(join(dir, shaclOutFile), 'utf8') : undefined,
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
    'inconsistency-diagnostics': 'Inconsistency diagnostics (OWL 2 RL)',
    'shacl-shape-planning': 'SHACL shape planning (SHACL in/out hints)',
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
