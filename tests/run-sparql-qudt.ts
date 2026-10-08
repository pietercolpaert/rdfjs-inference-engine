import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { generateSparqlConstruct, executeSparqlRuntime, createRdfjsSparqlExecutor, defaultSparqlMappingRules, type SparqlConstructResult } from '../src';
const directory = 'examples/sparql-construct/qudt-museum-dimensions/';
const parse = (source: string): Quad[] => new Parser().parse(source) as Quad[];
const read = (file: string) => readFileSync(directory + file, 'utf8');
const ontology = read('ontology.ttl'), shaclIn = read('shapes-in.ttl'), shaclOut = read('shapes-out.ttl');
const compile = (background = ontology, input = shaclIn, output = shaclOut) =>
  generateSparqlConstruct({ ontology: parse(background), shaclIn: parse(input), shaclOut: parse(output) });
const engine = new QueryEngine();
const sample = (number: string, unit: string) => `
@prefix museum: <https://example.org/museum/ontology#> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:height> a museum:RecordedHeight ; museum:heightOf <urn:object> ;
qudt:numericValue ${number} ; ${unit ? `qudt:unit unit:${unit} ;` : ''} museum:note "test" .`;
async function run(result: SparqlConstructResult, data: string): Promise<Quad[]> {
  assert.ok(result.program && result.query);
  return (await executeSparqlRuntime(result.program, parse(data), createRdfjsSparqlExecutor(engine), { outputQuery: result.query })).output;
}
const numericValue = (quads: Quad[]) => quads.find(q => q.predicate.value === 'http://qudt.org/schema/qudt/numericValue')?.object;
async function main(): Promise<void> {
  const result = compile();
  assert.ok(result.query);
  assert.ok(!result.diagnostics.some(d => d.severity === 'error'));
  assert.equal(result.mappings.length, 3);
  for (const [number, unit, expected] of [['32', 'CentiM', 0.32], ['450', 'MilliM', 0.45], ['1.2', 'M', 1.2]] as const) {
    const output = await run(result, sample(`"${number}"^^xsd:decimal`, unit));
    assert.equal(output.length, 4);
    const value = numericValue(output);
    assert.equal(Number(value?.value), expected, 'Convert the number rather than only relabel its unit.');
    assert.equal(value?.termType, 'Literal');
    if (value?.termType === 'Literal') assert.equal(value.datatype.value, 'http://www.w3.org/2001/XMLSchema#decimal');
    assert.ok(output.some(q => q.predicate.value === 'http://qudt.org/schema/qudt/unit' && q.object.value === 'http://qudt.org/vocab/unit/M'));
  }
  for (const [number, unit] of [['"invalid"', 'CentiM'], ['"5"^^xsd:decimal', 'SEC'], ['"5"^^xsd:decimal', '']] as const) {
    assert.equal((await run(result, sample(number, unit))).length, 0, 'Invalid numbers, missing units and undeclared units cannot produce a normalized record.');
  }
  const scientific = compile(ontology.replace('"0.01"^^xsd:decimal', '"1e-2"^^xsd:double'));
  assert.ok(scientific.query);
  assert.equal((await run(scientific, sample('"32"^^xsd:decimal', 'CentiM'))).length, 0, 'The consumer decimal constraint rejects uncast double results.');
  const reverse = compile(ontology, shaclIn, shaclOut.replaceAll('unit:M', 'unit:CentiM'));
  assert.ok(reverse.query);
  assert.equal(Number(numericValue(await run(reverse, sample('"0.32"^^xsd:decimal', 'M')))?.value), 32);
  const temperatureOntology = `
@prefix museum: <https://example.org/museum/ontology#> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix qkdv: <http://qudt.org/vocab/dimensionvector/> .
@prefix schema: <https://schema.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
museum:RecordedHeight rdfs:subClassOf qudt:QuantityValue .
museum:heightOf rdfs:subPropertyOf schema:about .
unit:DEG_C qudt:hasDimensionVector qkdv:A0E0L0I0M0H1T0D0 ; qudt:conversionMultiplier 1.0 ; qudt:conversionOffset 273.15 .
unit:K qudt:hasDimensionVector qkdv:A0E0L0I0M0H1T0D0 ; qudt:conversionMultiplier 1.0 ; qudt:conversionOffset 0.0 .`;
  const temperatureIn = shaclIn.replace('unit:CentiM unit:MilliM unit:M', 'unit:DEG_C unit:K');
  const affine = compile(temperatureOntology, temperatureIn, shaclOut.replaceAll('unit:M', 'unit:K'));
  assert.ok(affine.query);
  assert.equal(Number(numericValue(await run(affine, sample('"20"^^xsd:decimal', 'DEG_C')))?.value), 293.15);
  const reverseAffine = compile(temperatureOntology, temperatureIn, shaclOut.replaceAll('unit:M', 'unit:DEG_C'));
  assert.ok(reverseAffine.query);
  assert.equal(Number(numericValue(await run(reverseAffine, sample('"293.15"^^xsd:decimal', 'K')))?.value), 20, 'Subtract target offsets when converting Kelvin to Celsius.');
  for (const background of [
    ontology.replace('"0.01"^^xsd:decimal', '"0"^^xsd:decimal'),
    ontology.replace('"0.01"^^xsd:decimal', '"invalid"^^xsd:decimal'),
    ontology.replace('qudt:hasDimensionVector qkdv:A0E0L1I0M0H0T0D0', 'qudt:hasDimensionVector qkdv:OtherDimension'),
    ontology.replace('unit:CentiM a qudt:Unit', 'unit:CentiM a qudt:LogarithmicUnit'),
    ontology.replace('qudt:conversionMultiplier "0.01"^^xsd:decimal ;', ''),
    ontology.replace('qudt:conversionMultiplier "0.01"^^xsd:decimal ;', 'qudt:conversionMultiplier "0.01"^^xsd:decimal, "0.02"^^xsd:decimal ;'),
  ]) assert.equal((await run(compile(background), sample('"32"^^xsd:decimal', 'CentiM'))).length, 0, 'N3 guards reject unsafe or missing conversion metadata.');
  const changed = generateSparqlConstruct({ ontology: parse(ontology), shaclIn: parse(shaclIn), shaclOut: parse(shaclOut),
    rules: defaultSparqlMappingRules.replace('(?shifted ?sourceMultiplier) math:product ?canonical', '(?shifted ?sourceMultiplier) math:sum ?canonical') });
  assert.ok(changed.query);
  assert.equal(Number(numericValue(await run(changed, sample('"32"^^xsd:decimal', 'CentiM')))?.value), 32.01,
    'Changing N3 arithmetic changes the actual SPARQL result: no hidden TypeScript unit-conversion path.');
  console.log('SPARQL QUDT: decimal conversion, offsets, identity, reverse conversion and safety diagnostics verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
