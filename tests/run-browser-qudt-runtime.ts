import assert from 'node:assert/strict';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

const QCR_NORMALIZED_QUANTITY = 'https://w3id.org/qudt-inference#normalizedQuantity';
const bundlePath = `/tmp/rdfjs-browser-engine-qudt-${process.pid}.cjs`;

buildSync({
  entryPoints: ['browser-src/index.ts'],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});

try {
  Reflect.set(globalThis, 'self', globalThis);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const api = require(bundlePath) as typeof import('../browser-src/index');
  const ruleFiles = [
    'owl2rl/owl2rl-eyeling.n3',
    'qudt/qudt-cdt-normalization.n3',
    'skos/skos-entailment.n3',
  ];
  const profiles = ruleFiles.map((file) => ({
    n3: readFileSync(join('rules', file), 'utf8'),
    label: file,
    precompiledRuntime: file.startsWith('qudt/')
      ? readFileSync('rules/qudt/qudt-cdt-normalization.runtime.n3', 'utf8')
      : undefined,
  }));
  const directory = 'examples/qudt-logarithmic';
  const background = api.parseRdfOrMessages(readFileSync(join(directory, 'ontology.n3'), 'utf8')).quads;
  const input = api.parseRdfOrMessages(readFileSync(join(directory, 'input.messages.trig'), 'utf8'));
  const reasoner = new api.InferenceEngine();
  const runtime = reasoner.load(profiles, background, {
    shaclIn: readFileSync(join(directory, 'shapes-in.n3'), 'utf8'),
    shaclOut: readFileSync(join(directory, 'shapes-out.n3'), 'utf8'),
  });

  assert.ok(runtime.length < 60 * 1024, `Browser QUDT runtime should stay below 60 KiB; got ${runtime.length} bytes.`);
  assert.match(runtime, /Shape-specialized QUDT projection: 4 unit\(s\), 25\/11809 facts\./);
  assert.equal(input.messages.length, 4, 'Expected four logarithmic RDF Messages.');
  for (const [index, message] of input.messages.entries()) {
    const output = Array.from(reasoner.infer(message));
    assert.equal(
      output.filter((quad) => quad.predicate.value === QCR_NORMALIZED_QUANTITY).length,
      1,
      `Browser message ${index + 1} should expose one normalized QUDT quantity.`,
    );
  }

  console.log(`Browser QUDT runtime test: ${(runtime.length / 1024).toFixed(1)} KiB and ${input.messages.length}/4 messages normalized.`);
} finally {
  unlinkSync(bundlePath);
}
