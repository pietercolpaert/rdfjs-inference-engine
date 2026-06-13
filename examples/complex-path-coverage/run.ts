import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Quad, Term } from '@rdfjs/types';
import { InferenceEngine } from '../../src';
import { assertContainsQuads, parseToQuads, writeQuads } from '../util';

const EX = 'https://example.org/coverage#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const SKOLEM = 'https://eyereasoner.github.io/.well-known/genid/';
const SKOLEM_KEY = 'examples/complex-path-coverage';

async function main(): Promise<void> {
  const ontology = parseToQuads(readFileSync('examples/complex-path-coverage/ontology.n3', 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(ontology, {
    deterministicSkolem: true,
    skolemKey: SKOLEM_KEY,
  });
  mkdirSync(dirname('generated/complex-path-coverage-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/complex-path-coverage-runtime.n3');

  const data = parseToQuads(readFileSync('examples/complex-path-coverage/input.trig', 'utf8'));
  const closure = [...data, ...reasoner.infer(data, {
    deterministicSkolem: true,
    skolemKey: SKOLEM_KEY,
  })];
  const selected = selectDemoQuads(closure);
  const expected = parseToQuads(readFileSync('examples/complex-path-coverage/expected-selected-output.n3', 'utf8'));
  assertContainsQuads(selected, expected, 'Complex SHACL path + OWL 2 RL + SKOS coverage example');

  const output = await writeQuads(selected, {
    '': EX,
    rdf: RDF,
    sh: SH,
    skos: SKOS,
    gen: SKOLEM,
  });

  process.stdout.write(output);
}

function selectDemoQuads(quads: Quad[]): Quad[] {
  const resultIds = new Set(quads
    .filter((quad) => isNamed(quad.predicate as Term, RDF + 'type')
      && isNamed(quad.object as Term, SH + 'ValidationResult'))
    .map((quad) => termKey(quad.subject as Term)));

  return quads.filter((quad) => isSelectedInferredTheme(quad)
    || isReviewedRecordType(quad)
    || isSelectedValidationResultQuad(quad, resultIds))
    .sort((left, right) => quadKey(left).localeCompare(quadKey(right)));
}

function isSelectedInferredTheme(quad: Quad): boolean {
  return isNamed(quad.subject as Term, EX + 'bus-42', EX + 'bus-77')
    && isNamed(quad.predicate as Term, EX + 'theme')
    && isNamed(quad.object as Term, EX + 'bus', EX + 'vehicle');
}

function isReviewedRecordType(quad: Quad): boolean {
  return isNamed(quad.subject as Term, EX + 'electric-bus-card')
    && isNamed(quad.predicate as Term, RDF + 'type')
    && isNamed(quad.object as Term, EX + 'ReviewedCatalogRecord');
}

function isSelectedValidationResultQuad(quad: Quad, resultIds: Set<string>): boolean {
  return resultIds.has(termKey(quad.subject as Term))
    && quad.predicate.termType === 'NamedNode'
    && (quad.predicate.value === RDF + 'type' || quad.predicate.value.startsWith(SH));
}

function isNamed(term: Term, ...values: string[]): boolean {
  return term.termType === 'NamedNode' && values.includes(term.value);
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
