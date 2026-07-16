import assert from 'node:assert/strict';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

const QCR_NORMALIZED_QUANTITY = 'https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#normalizedQuantity';
const QCR_NORMALIZED_UCUM_LITERAL = 'https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#normalizedUcumLiteral';
const CDT_UCUM = 'https://w3id.org/cdt/ucum';
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

  assert.ok(runtime.length < 40 * 1024, `Browser QUDT runtime should stay below 40 KiB; got ${runtime.length} bytes.`);
  assert.match(runtime, /Shape-specialized QUDT kernel: forward rule\(s\) 5\./,
    'The logarithmic example should retain only the log-literal-to-linear forward rule.');
  const projectionSummary = runtime.match(/Shape-specialized QUDT projection: (\d+) unit\(s\), (\d+)\/(\d+) facts\./);
  assert.ok(projectionSummary, 'Browser runtime should report its shape-specialized QUDT projection.');
  assert.equal(Number(projectionSummary[1]), 4, 'The logarithmic example should retain four QUDT units.');
  assert.equal(Number(projectionSummary[2]), 26, 'The logarithmic example should retain 26 relevant QUDT facts.');
  assert.ok(Number(projectionSummary[3]) > 10_000, 'The source QUDT projection should contain its full background fact set.');
  assert.equal(input.messages.length, 4, 'Expected four logarithmic RDF Messages.');
  for (const [index, message] of input.messages.entries()) {
    const output = Array.from(reasoner.infer(message));
    assert.equal(
      output.filter((quad) => quad.predicate.value === QCR_NORMALIZED_QUANTITY).length,
      1,
      `Browser message ${index + 1} should expose one normalized QUDT quantity.`,
    );
    const ucumLiterals = output.filter((quad) => quad.predicate.value === QCR_NORMALIZED_UCUM_LITERAL);
    assert.equal(ucumLiterals.length, 1, `Browser message ${index + 1} should expose one normalized UCUM literal.`);
    assert.equal(ucumLiterals[0].object.termType === 'Literal' ? ucumLiterals[0].object.datatype.value : undefined, CDT_UCUM,
      `Browser message ${index + 1} should use the cdt:ucum datatype.`);
  }

  console.log(`Browser QUDT runtime test: ${(runtime.length / 1024).toFixed(1)} KiB and ${input.messages.length}/4 messages normalized.`);
} finally {
  unlinkSync(bundlePath);
}
