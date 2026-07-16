import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Quad } from '@rdfjs/types';
import { InferenceEngine } from '../../src';
import { assertContainsQuads, parseToQuads, writeQuads } from '../util';

const EX = 'https://example.org/subjects#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

async function main(): Promise<void> {
  const ontology = parseToQuads(readFileSync('examples/skos-taxonomy/ontology.n3', 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(ontology);
  mkdirSync(dirname('generated/skos-taxonomy-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/skos-taxonomy-runtime.n3');

  const data = parseToQuads(readFileSync('examples/skos-taxonomy/input.messages.trig', 'utf8'));
  const closure = [...data, ...reasoner.infer(data)];
  const selected = parseToQuads(readFileSync('examples/skos-taxonomy/expected-selected-output.n3', 'utf8'));
  assertContainsQuads(closure, selected, 'SKOS taxonomy example');

  const output = await writeQuads(selected, {
    '': EX,
    skos: SKOS,
    rdfs: RDFS,
  });

  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
