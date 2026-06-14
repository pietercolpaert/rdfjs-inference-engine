import { readFileSync } from 'node:fs';
import type { Quad, Term } from '@rdfjs/types';
import { InferenceEngine } from '../../src';
import { parseToQuads, writeQuads } from '../util';

const EX = 'https://example.org/shacl12-grandfather#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';
const SKOLEM = 'https://eyereasoner.github.io/.well-known/genid/';
const SKOLEM_KEY = 'examples/shacl12-grandfather';

async function main(): Promise<void> {
  const shapes = parseToQuads(readFileSync('examples/shacl12-grandfather/shapes.n3', 'utf8'));
  const data = parseToQuads(readFileSync('examples/shacl12-grandfather/input.trig', 'utf8'));

  const reasoner = new InferenceEngine();
  reasoner.load(shapes, {
    deterministicSkolem: true,
    skolemKey: SKOLEM_KEY,
  });

  const inferred = Array.from(reasoner.infer(data, {
    deterministicSkolem: true,
    skolemKey: SKOLEM_KEY,
  }));

  const selected = selectValidationResultQuads(inferred);
  const output = await writeQuads(sortQuads(selected), {
    '': EX,
    rdf: RDF,
    sh: SH,
    gen: SKOLEM,
  });

  process.stdout.write(output);
}

function selectValidationResultQuads(quads: Quad[]): Quad[] {
  const resultIds = new Set(quads
    .filter((quad) => isNamed(quad.predicate as Term, RDF + 'type')
      && isNamed(quad.object as Term, SH + 'ValidationResult'))
    .map((quad) => termKey(quad.subject as Term)));

  return quads.filter((quad) => resultIds.has(termKey(quad.subject as Term))
    && quad.predicate.termType === 'NamedNode'
    && (quad.predicate.value === RDF + 'type' || quad.predicate.value.startsWith(SH)));
}

function sortQuads(quads: Quad[]): Quad[] {
  return [...quads].sort((left, right) => quadKey(left).localeCompare(quadKey(right)));
}

function isNamed(term: Term, value: string): boolean {
  return term.termType === 'NamedNode' && term.value === value;
}

function quadKey(quad: Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph]
    .map((term) => termKey(term as Term))
    .join(' ');
}

function termKey(term: Term): string {
  if (term.termType === 'Literal') {
    return `"${term.value}"@${term.language}^^${term.datatype.value}`;
  }
  return `${term.termType}:${term.value}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
