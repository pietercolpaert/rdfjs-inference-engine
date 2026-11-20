import assert from 'node:assert/strict';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { InferenceEngine, loadDefaultRuleProfiles, type LoadOptions } from '../src';

// Regression test: shape-guided runtimes must keep property-chain (and other
// join) consequences whose second hop lives in the background ontology, and
// valid literals of datatypes Eyeling cannot parse (xsd:date) must not be
// reported as dt-not-type inconsistencies.

// Only OWL 2 RL: the bundled QUDT profile activates its prepared runtime for
// qudt:hasUnit backgrounds and is not what this test is about.
const owl2rl = loadDefaultRuleProfiles().filter((profile) => profile.label?.includes('owl2rl'));

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LITERAL = 'http://www.w3.org/2000/01/rdf-schema#Literal';
const INCONSISTENCIES = 'https://www.pieter.pm/rdfjs-inference-engine/ns/inconsistencies#';
const TSS = 'https://w3id.org/tss#';
const SOSA = 'http://www.w3.org/ns/sosa/';
const SAREF = 'https://saref.etsi.org/core/';
const QUDT = 'http://qudt.org/schema/qudt/';
const UNIT = 'http://qudt.org/vocab/unit/';
const EX = 'http://example.org/tss-test#';

const PREFIXES = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix tss: <${TSS}> .
@prefix sosa: <${SOSA}> .
@prefix saref: <${SAREF}> .
@prefix qudt: <${QUDT}> .
@prefix unit: <${UNIT}> .
@prefix ex: <${EX}> .
`;

const background = parseQuads(`${PREFIXES}
<https://w3id.org/tss> a owl:Ontology ;
  dcterms:modified "2026-11-20"^^xsd:date .

tss:hasPoint rdfs:range tss:Point .
tss:Point rdfs:subClassOf sosa:Observation, saref:Measurement .
tss:field rdfs:domain tss:Point ; rdfs:range tss:Field .
tss:time rdfs:subPropertyOf sosa:resultTime, saref:hasTimestamp .
tss:value rdfs:subPropertyOf sosa:hasSimpleResult, saref:hasValue .
tss:unit rdfs:domain tss:Field .
tss:observedProperty rdfs:domain tss:Field .

qudt:hasUnit owl:propertyChainAxiom ( tss:field tss:unit ) .
saref:isMeasuredIn owl:propertyChainAxiom ( tss:field tss:unit ) .
sosa:observedProperty owl:propertyChainAxiom ( tss:field tss:observedProperty ) .
saref:relatesToProperty owl:propertyChainAxiom ( tss:field tss:observedProperty ) .
sosa:hasFeatureOfInterest owl:propertyChainAxiom ( tss:field tss:featureOfInterest ) .

ex:temperature a tss:Field ;
  tss:unit unit:DEG_C ;
  tss:observedProperty ex:airTemperature ;
  tss:featureOfInterest ex:air .
`);

const shaclIn = parseQuads(`${PREFIXES}
ex:SourceShape a sh:NodeShape ;
  sh:targetSubjectsOf tss:hasPoint ;
  sh:closed true ;
  sh:property [ sh:path tss:hasPoint ; sh:nodeKind sh:BlankNodeOrIRI ] .
ex:PointShape a sh:NodeShape ;
  sh:targetObjectsOf tss:hasPoint ;
  sh:closed true ;
  sh:property [ sh:path tss:field ; sh:nodeKind sh:IRI ] ,
    [ sh:path tss:time ; sh:datatype xsd:dateTime ] ,
    [ sh:path tss:value ; sh:nodeKind sh:Literal ] .
`);

const shaclOut = parseQuads(`${PREFIXES}
ex:ObservationShape a sh:NodeShape ;
  sh:targetClass sosa:Observation, saref:Measurement ;
  sh:property [ sh:path rdf:type ; sh:in ( sosa:Observation saref:Measurement ) ] ,
    [ sh:path sosa:resultTime ] , [ sh:path sosa:hasSimpleResult ] ,
    [ sh:path sosa:observedProperty ] , [ sh:path sosa:hasFeatureOfInterest ] ,
    [ sh:path qudt:hasUnit ] , [ sh:path saref:hasTimestamp ] , [ sh:path saref:hasValue ] ,
    [ sh:path saref:relatesToProperty ] , [ sh:path saref:isMeasuredIn ] .
`);

const outputPredicates = new Set([
  SOSA + 'resultTime', SOSA + 'hasSimpleResult', SOSA + 'observedProperty', SOSA + 'hasFeatureOfInterest',
  QUDT + 'hasUnit', SAREF + 'hasTimestamp', SAREF + 'hasValue', SAREF + 'relatesToProperty', SAREF + 'isMeasuredIn',
]);
const outputClasses = new Set([SOSA + 'Observation', SAREF + 'Measurement']);

const rows = [0, 1, 2].map((index) => parseQuads(`${PREFIXES}
ex:source tss:hasPoint ex:point${index} .
ex:point${index} tss:field ex:temperature ;
  tss:time "2030-01-01T00:0${index}:00Z"^^xsd:dateTime ;
  tss:value "${index}.5"^^xsd:double .
`));

const expectedPointFacts = [
  [RDF_TYPE, SOSA + 'Observation'],
  [RDF_TYPE, SAREF + 'Measurement'],
  [SOSA + 'resultTime', '"2030-01-01T00:00:00Z"'],
  [SAREF + 'hasTimestamp', '"2030-01-01T00:00:00Z"'],
  [SOSA + 'hasSimpleResult', '"0.5"'],
  [SAREF + 'hasValue', '"0.5"'],
  [QUDT + 'hasUnit', UNIT + 'DEG_C'],
  [SAREF + 'isMeasuredIn', UNIT + 'DEG_C'],
  [SOSA + 'observedProperty', EX + 'airTemperature'],
  [SAREF + 'relatesToProperty', EX + 'airTemperature'],
  [SOSA + 'hasFeatureOfInterest', EX + 'air'],
];

const unshaped = loadEngine({});
const unshapedOutputs = rows.map((row) => Array.from(unshaped.infer(row)));

const variants: Array<[string, LoadOptions]> = [
  ['shaclIn + shaclOut', { shaclIn, shaclOut }],
  ['shaclOut only', { shaclOut }],
  ['shaclIn only', { shaclIn }],
];

for (const [label, options] of [['no shapes', {}] as [string, LoadOptions], ...variants]) {
  const engine = label === 'no shapes' ? unshaped : loadEngine(options);
  const outputs = label === 'no shapes' ? unshapedOutputs : rows.map((row) => Array.from(engine.infer(row)));

  const pointFacts = new Set(outputs[0]
    .filter((quad) => quad.subject.value === EX + 'point0')
    .map((quad) => `${quad.predicate.value} ${objectText(quad)}`));
  for (const [predicate, object] of expectedPointFacts) {
    assert.ok(pointFacts.has(`${predicate} ${object}`), `${label}: expected ex:point0 <${predicate}> ${object}, got:\n${Array.from(pointFacts).join('\n')}`);
  }

  if (label !== 'no shapes') {
    outputs.forEach((output, index) => assert.deepEqual(
      projectedKeys(output),
      projectedKeys(unshapedOutputs[index]),
      `${label}: projected output for row ${index} should equal the unshaped runtime's output.`,
    ));
  }

  // dcterms:modified "2026-11-20"^^xsd:date is a valid rdfs:Literal.
  assert.deepEqual(engine.getStaticInconsistencies(), [], `${label}: a valid xsd:date literal should not be a static inconsistency.`);
  assert.equal(
    outputs.flat().some((quad) => quad.predicate.value.startsWith(INCONSISTENCIES)),
    false,
    `${label}: infer() should not report inconsistencies for consistent background and input.`,
  );
}

const shapedRuntime = loadEngine({ shaclIn, shaclOut }).getRuntime();
assert.equal(shapedRuntime.includes('rules/owl2rl/owl2rl-eyeling.n3'), false, 'Property chains should be partial-evaluated instead of retaining generic OWL 2 RL rules.');
assert.equal(shapedRuntime.includes('# Precomputed background facts and closure'), false, 'Shape-guided runtimes should still avoid the full static closure.');
assert.ok(shapedRuntime.includes('# Precomputed background facts for partial-evaluated join rules'), 'Partial-evaluated join rules should embed the background facts they join with.');
assert.ok(
  shapedRuntime.includes(`{ ?x <${TSS}field> ?z1 . ?z1 <${TSS}unit> ?y . }\n=> { ?x <${QUDT}hasUnit> ?y . } .`),
  'owl:propertyChainAxiom ( tss:field tss:unit ) should become a direct join rule.',
);

// Without shaclIn the input is unconstrained: both chain hops may come from the message.
const messageField = parseQuads(`${PREFIXES}
ex:point9 tss:field ex:pressure ; tss:value "1013.0"^^xsd:double .
ex:pressure tss:unit unit:HectoPA .
`);
const outOnlyMessage = Array.from(loadEngine({ shaclOut }).infer(messageField));
assert.ok(
  outOnlyMessage.some((quad) => quad.subject.value === EX + 'point9' && quad.predicate.value === QUDT + 'hasUnit' && quad.object.value === UNIT + 'HectoPA'),
  'Chain joins entirely within the message should still be inferred with shaclOut only.',
);

// Ill-typed literals of supported datatypes remain inconsistent.
const illTyped = new InferenceEngine();
illTyped.load(owl2rl, parseQuads(`${PREFIXES} ex:x ex:count "abc"^^xsd:integer .`));
assert.ok(
  illTyped.getStaticInconsistencies().some((report) => report.rule === INCONSISTENCIES + 'dt-not-type'
    && report.terms[0]?.value === 'abc'
    && report.terms[1]?.value === RDFS_LITERAL),
  'An ill-typed xsd:integer literal should still be reported by dt-not-type.',
);

function loadEngine(options: LoadOptions): InferenceEngine {
  const engine = new InferenceEngine();
  engine.load(owl2rl, background, options);
  return engine;
}

function projectedKeys(quads: Quad[]): string[] {
  return quads
    .filter((quad) => outputPredicates.has(quad.predicate.value)
      || (quad.predicate.value === RDF_TYPE && outputClasses.has(quad.object.value)))
    .map((quad) => `${quad.subject.value} ${quad.predicate.value} ${objectText(quad)}`)
    .sort();
}

function objectText(quad: Quad): string {
  return quad.object.termType === 'Literal' ? `"${quad.object.value}"` : quad.object.value;
}

function parseQuads(source: string): Quad[] {
  return Array.from((new Parser().parse(source) ?? []) as Iterable<unknown>) as Quad[];
}

console.log('SHACL background join tests passed.');
