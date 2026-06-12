import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { InferenceEngine, loadDefaultRuleProfiles, type RuntimeCompilerInput } from '../src';

const SKOLEM_BASE_IRI = 'https://eyereasoner.github.io/.well-known/genid/';

const expectedLabels = readdirSync('rules')
  .filter((file) => file.endsWith('.n3'))
  .sort()
  .map((file) => `rules/${file}`);

assert.ok(expectedLabels.length > 0, 'Expected at least one bundled N3 rule profile.');

const defaultProfiles = loadDefaultRuleProfiles();
assert.deepEqual(
  defaultProfiles.map((profile) => profile.label),
  expectedLabels,
  'loadDefaultRuleProfiles() should load every bundled rules/*.n3 file in sorted order.',
);

let compilerInput: RuntimeCompilerInput | undefined;
const reasoner = new InferenceEngine();
reasoner.load([], {
  runtimeCompiler: (input) => {
    compilerInput = input;
    return input.profileN3;
  },
});

assert.ok(compilerInput, 'Expected the runtime compiler to be called.');
assert.deepEqual(
  compilerInput.profiles.map((profile) => profile.label),
  expectedLabels,
  'load(vocabularyDataset) should use every bundled rules/*.n3 file by default.',
);

const parser = new Parser();
const disjointReasoner = new InferenceEngine();
disjointReasoner.load(
  loadDefaultRuleProfiles(),
  parseQuads(`
@prefix : <https://example.org/test#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

:A owl:disjointWith :B .
`),
);
const disjointOutput = Array.from(disjointReasoner.infer(parseQuads(`
@prefix : <https://example.org/test#> .

:b0 a :A .
`)));
assert.equal(
  disjointOutput.some((quad) => [quad.subject, quad.predicate, quad.object, quad.graph]
    .some((term) => term.termType === 'NamedNode' && term.value.startsWith(SKOLEM_BASE_IRI))),
  false,
  'Application output should not expose generated internal Skolem helper triples.',
);

function parseQuads(source: string): Quad[] {
  return Array.from((parser.parse(source) ?? []) as Iterable<unknown>) as Quad[];
}

console.log(`Default rule loading tests: ${expectedLabels.length}/${expectedLabels.length} profiles loaded.`);
