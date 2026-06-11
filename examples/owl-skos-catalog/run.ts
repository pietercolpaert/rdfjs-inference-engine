import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InferenceEngine } from '../../src';
import { assertContainsQuads, parseToQuads, writeQuads } from '../util';

const EX = 'https://example.org/catalog#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

async function main(): Promise<void> {
  const profiles = [
    readFileSync('rules/owl2rl-eyeling.n3', 'utf8'),
    readFileSync('rules/skos-entailment.n3', 'utf8'),
  ];
  const ontology = parseToQuads(readFileSync('examples/owl-skos-catalog/ontology.n3', 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(profiles, ontology);
  mkdirSync(dirname('generated/owl-skos-catalog-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/owl-skos-catalog-runtime.n3');

  const data = parseToQuads(readFileSync('examples/owl-skos-catalog/input.trig', 'utf8'));
  const closure = [...data, ...reasoner.infer(data)];
  const selected = parseToQuads(readFileSync('examples/owl-skos-catalog/expected-selected-output.n3', 'utf8'));
  assertContainsQuads(closure, selected, 'Combined OWL 2 RL + SKOS catalog example');

  const output = await writeQuads(selected, {
    '': EX,
    skos: SKOS,
  });

  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
