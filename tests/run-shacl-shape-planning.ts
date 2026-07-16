import assert from 'node:assert/strict';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { InferenceEngine, compileShaclShapeGraph } from '../src';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const EX = 'https://example.org/shape-planning#';
const SOSA = 'http://www.w3.org/ns/sosa/';

const pathShape = parseQuads(`
@prefix ex: <${EX}> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix qcr: <https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix unit: <http://qudt.org/vocab/unit/> .

ex:Shape
  a sh:NodeShape ;
  sh:targetClass ex:Message ;
  sh:class ex:AlignedMessage ;
  sh:property [
    sh:path ex:value ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:decimal ;
    qcr:UcumUnitIn ( unit:M unit:CentiM )
  ] ;
  sh:property [
    sh:path [ sh:inversePath ex:hasPart ]
  ] ;
  sh:property [
    sh:path ( ex:parent ex:name )
  ] ;
  sh:property [
    sh:path [ sh:alternativePath ( ex:email ex:mbox ) ]
  ] ;
  sh:property [
    sh:path [ sh:oneOrMorePath ex:broader ]
  ] ;
  sh:property [
    sh:path (
      ex:parent
      [ sh:alternativePath ( ex:name ex:label ) ]
    )
  ] .
`);

const pathPlan = compileShaclShapeGraph(pathShape, 'in');
assert.equal(pathPlan.shapes.length, 1, 'Expected one compiled SHACL node shape.');
assert.deepEqual(pathPlan.shapes[0].classes, [EX + 'AlignedMessage'], 'Node-level sh:class constraints should be retained.');
assert.ok(pathPlan.relevantClasses.includes(EX + 'AlignedMessage'), 'Node-level sh:class should guide class-aware planning.');
assert.ok(pathPlan.relevantPredicates.includes(EX + 'value'), 'Direct predicate paths should be collected.');
assert.ok(pathPlan.relevantPredicates.includes(EX + 'hasPart'), 'Inverse paths should expose their predicate.');
assert.ok(pathPlan.relevantPredicates.includes(EX + 'parent'), 'Sequence paths should expose all predicates.');
assert.ok(pathPlan.relevantPredicates.includes(EX + 'email'), 'Alternative paths should expose all alternatives.');
assert.ok(pathPlan.relevantPredicates.includes(EX + 'mbox'), 'Alternative paths should expose all alternatives.');
assert.ok(pathPlan.relevantPredicates.includes(EX + 'broader'), 'Repeated paths should expose their predicate.');
assert.ok(pathPlan.repeatedPaths.some((path) => path.endsWith('+')), 'oneOrMorePath should be marked as repeated.');
assert.ok(pathPlan.scalarPaths.includes(EX + 'value'), 'sh:maxCount 1 paths should be scalar.');
assert.deepEqual(
  pathPlan.shapes[0].propertyPlans.find((property) => property.pathText === EX + 'value')?.ucumUnitIn,
  ['http://qudt.org/vocab/unit/CentiM', 'http://qudt.org/vocab/unit/M'],
  'Shape planning should retain qcr:UcumUnitIn alternatives for profile specialization.',
);
assert.ok(
  pathPlan.pathTexts.includes(`${EX}parent / (${EX}name | ${EX}label)`),
  'Nested paths should be compiled into a readable sequence/alternative path.',
);

const ontology = parseQuads(`
@prefix ex: <${EX}> .
@prefix sosa: <${SOSA}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

sosa:madeBySensor
  rdfs:domain sosa:Observation, ex:InternalObservation ;
  rdfs:range sosa:Sensor .

sosa:resultTime
  rdfs:domain sosa:Observation .

sosa:hasSimpleResult
  rdfs:domain sosa:Observation .

sosa:hasFeatureOfInterest
  rdfs:domain sosa:Observation ;
  rdfs:range sosa:FeatureOfInterest .

ex:observedBy
  rdfs:subPropertyOf sosa:madeBySensor, ex:internalSensorLink .

ex:observedAt
  rdfs:subPropertyOf sosa:resultTime .

ex:temperatureCelsius
  rdfs:subPropertyOf sosa:hasSimpleResult .

ex:observedFeature
  rdfs:subPropertyOf sosa:hasFeatureOfInterest .
`);

const shaclIn = parseQuads(`
@prefix ex: <${EX}> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix sosa: <${SOSA}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:ObservationInputShape
  a sh:NodeShape ;
  sh:targetClass sosa:ObservationMessage ;
  sh:closed true ;
  sh:property [
    sh:path ex:observedBy ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:nodeKind sh:IRI
  ] ;
  sh:property [
    sh:path ex:observedAt ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:dateTime
  ] ;
  sh:property [
    sh:path ex:temperatureCelsius ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:decimal
  ] ;
  sh:property [
    sh:path ex:observedFeature ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:nodeKind sh:IRI
  ] .
`);

const shaclOut = parseQuads(`
@prefix ex: <${EX}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix sosa: <${SOSA}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:ObservationOutputShape
  a sh:NodeShape ;
  sh:targetSubjectsOf sosa:madeBySensor ;
  sh:property [
    sh:path sosa:madeBySensor ;
    sh:maxCount 1
  ] ;
  sh:property [
    sh:path sosa:resultTime ;
    sh:maxCount 1 ;
    sh:datatype xsd:dateTime
  ] ;
  sh:property [
    sh:path sosa:hasSimpleResult ;
    sh:maxCount 1 ;
    sh:datatype xsd:decimal
  ] ;
  sh:property [
    sh:path sosa:hasFeatureOfInterest ;
    sh:maxCount 1 ;
    sh:nodeKind sh:IRI
  ] ;
  sh:property [
    sh:path rdf:type ;
    sh:hasValue sosa:Observation
  ] .

ex:SensorOutputShape
  a sh:NodeShape ;
  sh:targetObjectsOf sosa:madeBySensor ;
  sh:property [
    sh:path rdf:type ;
    sh:hasValue sosa:Sensor
  ] .

ex:FeatureOutputShape
  a sh:NodeShape ;
  sh:targetObjectsOf sosa:hasFeatureOfInterest ;
  sh:property [
    sh:path rdf:type ;
    sh:hasValue sosa:FeatureOfInterest
  ] .
`);

const reasoner = new InferenceEngine();
reasoner.load(ontology, { shaclIn, shaclOut });
const planning = reasoner.getShapePlanning();
assert.ok(planning, 'load(..., { shaclIn, shaclOut }) should compile shape planning metadata.');
assert.ok(planning.relevantInputPredicates.includes(EX + 'observedBy'), 'Input shape predicates should guide rule selection.');
assert.ok(planning.relevantOutputPredicates.includes(RDF_TYPE), 'Output shape predicates should guide rule selection.');
assert.ok(reasoner.getRuntime().includes('SHACL shape hints'), 'Generated runtime should explain that shape hints were used.');
assert.equal(reasoner.getRuntime().includes('rules/shacl-experimental/shacl-core-eyeling.n3'), false, 'Optimization shapes should not activate SHACL validation rules by themselves.');
assert.equal(reasoner.getRuntime().includes('rules/owl2rl/owl2rl-eyeling.n3'), false, 'Shape-guided partial evaluation should avoid retaining generic OWL2RL rules when direct static-ontology rules cover the requested output shape.');
assert.equal(reasoner.getRuntime().includes('# Precomputed background facts and closure'), false, 'Shape-guided partial evaluation should not embed the static background closure when input and output shapes make it unnecessary.');

const closureRuntimeReasoner = new InferenceEngine();
closureRuntimeReasoner.load(ontology, { shaclIn, shaclOut, includeStaticClosure: true });
assert.ok(closureRuntimeReasoner.getRuntime().includes('# Precomputed background facts and closure'), 'includeStaticClosure: true should still explicitly embed the static background closure.');

const restoredReasoner = new InferenceEngine({ runtime: reasoner.getRuntime() });
assert.deepEqual(
  restoredReasoner.getShapePlanning()?.relevantOutputPredicates,
  planning.relevantOutputPredicates,
  'Saved runtime text should embed enough shape planning metadata to restore it without reparsing shapes.',
);

const observationInput = parseQuads(`
@prefix ex: <${EX}> .
@prefix sosa: <${SOSA}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:obs1 ex:observedBy ex:sensor1 ;
  ex:observedAt "2026-06-16T10:00:01Z"^^xsd:dateTime ;
  ex:temperatureCelsius "18.1"^^xsd:decimal ;
  ex:observedFeature ex:platformA .
ex:obs1 ex:debugOnly "drop me" .
`);
const inferred = Array.from(reasoner.infer(observationInput));
const optimization = reasoner.getLastInputOptimization();
assert.ok(optimization?.enabled, 'Shape-guided infer() should enable per-input optimization.');
assert.equal(optimization.originalQuadCount, 5, 'Optimization diagnostics should report the original input size.');
assert.equal(optimization.optimizedQuadCount, 4, 'Closed input shapes should compact away unrelated message-local facts.');
assert.equal(optimization.droppedQuadCount, 1, 'Optimization diagnostics should count dropped message-local facts.');
assert.ok(
  optimization.indexesBuilt.some((index) => index.kind === 'subject-predicate' && index.predicate === EX + 'observedBy'),
  'Input shape planning should request a subject-predicate index for direct forward paths.',
);
assert.ok(
  optimization.joinOrderHints.some((hint) => hint.predicate === EX + 'observedBy' && hint.scalar && hint.required),
  'Input shape planning should expose scalar/required join-order hints.',
);
assert.equal(
  optimization.compactRecords[0]?.scalarValues[EX + 'observedBy'],
  EX + 'sensor1',
  'Shape-guided compact storage should store sh:maxCount 1 path values in scalar slots.',
);
assert.equal(
  optimization.compactRecords[0]?.scalarValues[EX + 'observedAt'],
  '"2026-06-16T10:00:01Z"^^http://www.w3.org/2001/XMLSchema#dateTime',
  'Shape-guided compact storage should keep scalar timestamp values.',
);
assert.ok(
  inferred.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === RDF_TYPE
    && quad.object.value === SOSA + 'Observation'),
  'Shape-guided runtime should still infer the output type from rdfs:domain.',
);
assert.ok(
  inferred.some((quad) => quad.subject.value === EX + 'sensor1'
    && quad.predicate.value === RDF_TYPE
    && quad.object.value === SOSA + 'Sensor'),
  'Shape-guided runtime should still infer the output type from rdfs:range.',
);
assert.ok(
  inferred.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === SOSA + 'madeBySensor'
    && quad.object.value === EX + 'sensor1'),
  'Shape-guided runtime should keep variable-head subproperty rules when the output shape asks for the super-property.',
);
assert.ok(
  inferred.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === SOSA + 'resultTime'
    && quad.object.value === '2026-06-16T10:00:01Z'),
  'Shape-guided runtime should keep timestamp subproperty rules when the output shape asks for sosa:resultTime.',
);
assert.ok(
  inferred.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === SOSA + 'hasSimpleResult'
    && quad.object.value === '18.1'),
  'Shape-guided runtime should keep result subproperty rules when the output shape asks for sosa:hasSimpleResult.',
);
assert.ok(
  inferred.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === SOSA + 'hasFeatureOfInterest'
    && quad.object.value === EX + 'platformA'),
  'Shape-guided runtime should keep feature-of-interest subproperty rules when the output shape asks for sosa:hasFeatureOfInterest.',
);
assert.ok(
  inferred.some((quad) => quad.subject.value === EX + 'platformA'
    && quad.predicate.value === RDF_TYPE
    && quad.object.value === SOSA + 'FeatureOfInterest'),
  'Shape-guided runtime should still infer the feature-of-interest type from rdfs:range.',
);
assert.equal(
  inferred.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === EX + 'internalSensorLink'
    && quad.object.value === EX + 'sensor1'),
  false,
  'SHACL output projection should hide predicates not mentioned by the output shape.',
);
assert.equal(
  inferred.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === RDF_TYPE
    && quad.object.value === EX + 'InternalObservation'),
  false,
  'SHACL output projection should hide rdf:type values not mentioned by the output shape.',
);

const unprojected = Array.from(reasoner.infer(observationInput, { projectShapeOutput: false }));
assert.ok(
  unprojected.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === EX + 'internalSensorLink'
    && quad.object.value === EX + 'sensor1'),
  'projectShapeOutput: false should expose derived predicates outside the output shape projection.',
);
assert.ok(
  unprojected.some((quad) => quad.subject.value === EX + 'obs1'
    && quad.predicate.value === RDF_TYPE
    && quad.object.value === EX + 'InternalObservation'),
  'projectShapeOutput: false should expose derived triples outside the output shape projection.',
);

Array.from(reasoner.infer(parseQuads(`
@prefix ex: <${EX}> .

ex:obs2 ex:debugOnly "kept when disabled" .
`), { optimizeShapeInput: false }));
assert.equal(reasoner.getLastInputOptimization(), undefined, 'optimizeShapeInput: false should bypass compact input optimization.');

function parseQuads(source: string): Quad[] {
  return Array.from((new Parser().parse(source) ?? []) as Iterable<unknown>) as Quad[];
}

console.log('SHACL shape planning tests passed.');
