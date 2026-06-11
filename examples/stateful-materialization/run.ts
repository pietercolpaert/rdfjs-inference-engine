import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Quad, Term } from '@rdfjs/types';
import { InferenceEngine } from '../../src';
import { parseRdfOrMessages, parseToQuads, writeMessages } from '../util';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const FAMILY = 'https://example.org/family#';
const SELECTED_TYPES = new Set([FAMILY + 'Parent', FAMILY + 'Mother']);

async function main(): Promise<void> {
  const statefulMaterialization = process.argv.includes('--stateful-materialization');
  const profile = readFileSync('rules/owl2rl-eyeling.n3', 'utf8');
  const ontology = parseToQuads(readFileSync('examples/stateful-materialization/ontology.n3', 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(profile, ontology);
  mkdirSync(dirname('generated/stateful-materialization-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/stateful-materialization-runtime.n3');

  const input = parseRdfOrMessages(readFileSync('examples/stateful-materialization/input.messages.trig', 'utf8'));
  if (!input.isMessages) {
    throw new Error('Expected RDF Messages input.');
  }

  const state: Quad[] = [];
  const stateKeys = new Set<string>();
  const inferredMessages = input.messages.map((message) => {
    const inferenceInput = statefulMaterialization ? [...state, ...message] : message;
    const inferred = Array.from(reasoner.infer(inferenceInput));
    const delta = statefulMaterialization
      ? inferred.filter((quad) => !stateKeys.has(quadKey(quad)))
      : inferred;

    if (statefulMaterialization) {
      rememberAll(state, stateKeys, message);
      rememberAll(state, stateKeys, inferred);
    }

    return delta.filter(isSelectedOutput);
  });

  const output = await writeMessages(inferredMessages, { '': FAMILY });

  process.stdout.write(output);
}

function rememberAll(state: Quad[], stateKeys: Set<string>, quads: Iterable<Quad>): void {
  for (const quad of quads) {
    const key = quadKey(quad);
    if (!stateKeys.has(key)) {
      stateKeys.add(key);
      state.push(quad);
    }
  }
}

function isSelectedOutput(quad: Quad): boolean {
  return quad.subject.termType === 'NamedNode'
    && quad.subject.value === FAMILY + 'alice'
    && quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && SELECTED_TYPES.has(quad.object.value);
}

function quadKey(quad: Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph].map(termKey).join(' ');
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
