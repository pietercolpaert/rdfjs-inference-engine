import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

const skosProfile = readFileSync('rules/skos-entailment.n3', 'utf8');
const selectedSkosReasoner = new InferenceEngine();
selectedSkosReasoner.load(skosProfile, []);
assert.equal(
  selectedSkosReasoner.getRuntime().includes('=>'),
  false,
  'Default runtime selection should omit inactive SKOS runtime rules when no SKOS vocabulary is loaded.',
);

const fullSkosReasoner = new InferenceEngine();
fullSkosReasoner.load(skosProfile, [], { selectRuntimeRules: false });
assert.equal(
  fullSkosReasoner.getRuntime().includes('skos:broader'),
  true,
  'selectRuntimeRules: false should preserve the full generic profile for infer-time schema tests.',
);

const browserStyleProfiles = loadDefaultRuleProfiles();
const browserStyleSkosReasoner = new InferenceEngine();
browserStyleSkosReasoner.load({
  n3: browserStyleProfiles.map((profile) => profile.n3).join('\n\n'),
  label: `Bundled profiles: ${browserStyleProfiles.map((profile) => profile.label).join(', ')}`,
}, parseQuads(`
@prefix : <https://example.org/subjects#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .

:scheme a skos:ConceptScheme .
`));
const browserStyleSkosOutput = Array.from(browserStyleSkosReasoner.infer(parseQuads(`
@prefix : <https://example.org/subjects#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .

:cat skos:broader :mammal .
:mammal skos:broader :animal .
`)));
assert.ok(
  browserStyleSkosOutput.some((quad) => quad.subject.value === 'https://example.org/subjects#cat'
    && quad.predicate.value === 'http://www.w3.org/2004/02/skos/core#broaderTransitive'
    && quad.object.value === 'https://example.org/subjects#animal'),
  'Browser-style bundled profile loading should retain SKOS rules for SKOS predicates that arrive in infer() data.',
);

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

const grandfatherReasoner = new InferenceEngine();
grandfatherReasoner.load(
  loadDefaultRuleProfiles(),
  parseQuads(`
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
@prefix ex: <https://example.org/#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

ex:Grandfather
  a owl:Class ;
  rdfs:subClassOf ex:Person ;
  owl:equivalentClass [
    a owl:Class ;
    owl:intersectionOf (
      [
        a owl:Restriction ;
        owl:onProperty ex:gender ;
        owl:hasValue "male"
      ]
      [
        a owl:Restriction ;
        owl:onProperty ex:hasGrandchild ;
        owl:someValuesFrom owl:Thing
      ]
    )
  ] .

ex:hasGrandchild
  a owl:ObjectProperty ;
  owl:propertyChainAxiom ( ex:child ex:child ) .
`),
);
const grandfatherOutput = Array.from(grandfatherReasoner.infer(parseQuads(`
@prefix ex: <https://example.org/#> .

ex:P1 a ex:Person ;
  ex:child ex:P1.1, ex:P1.2 ;
  ex:gender "male" .
ex:P1.1 a ex:Person ; ex:child ex:P1.1.1 .
ex:P1.1.1 a ex:Person .
ex:P1.2 a ex:Person ; ex:child ex:P1.2.1, ex:P1.2.2 .
ex:P1.2.1 a ex:Person .
ex:P1.2.2 a ex:Person .
`)));
assert.ok(
  grandfatherOutput.some((quad) => quad.subject.value === 'https://example.org/#P1'
    && quad.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
    && quad.object.value === 'https://example.org/#Grandfather'),
  'A male person with a child who has a child should be classified as ex:Grandfather.',
);
assert.equal(
  grandfatherOutput.some((quad) => quad.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
    && quad.object.termType === 'BlankNode'),
  false,
  'Application output should not expose anonymous class-expression type triples.',
);

function parseQuads(source: string): Quad[] {
  return Array.from((parser.parse(source) ?? []) as Iterable<unknown>) as Quad[];
}

console.log(`Default rule loading tests: ${expectedLabels.length}/${expectedLabels.length} profiles loaded.`);
