import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { generateSparqlConstruct, executeSparqlRuntime, createRdfjsSparqlExecutor, InferenceEngine, loadDefaultRuleProfiles, type SparqlConstructResult } from '../src';
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
<urn:object> museum:height <urn:height> .
<urn:height> a museum:RecordedHeight, qudt:QuantityValue ; museum:heightOf <urn:object> ;
qudt:numericValue ${number} ; ${unit ? `qudt:unit unit:${unit} ;` : ''} museum:note "test" .`;
async function run(result: SparqlConstructResult, data: string): Promise<Quad[]> {
  assert.ok(result.program && result.query);
  return (await executeSparqlRuntime(result.program, parse(data), createRdfjsSparqlExecutor(engine), { outputQuery: result.query })).output;
}
const numericValue = (quads: Quad[], unit?: string) => {
  const subject = unit ? quads.find(q => q.predicate.value === 'http://qudt.org/schema/qudt/unit' && q.object.value === 'http://qudt.org/vocab/unit/' + unit)?.subject : undefined;
  return quads.find(q => q.predicate.value === 'http://qudt.org/schema/qudt/numericValue' && (!unit || subject && q.subject.equals(subject)))?.object;
};
async function main(): Promise<void> {
  const result = compile();
  assert.ok(result.query);
  assert.ok(!result.diagnostics.some(d => d.severity === 'error'));
  assert.equal(result.mappings.length, 3);
  assert.match(result.runtime, /Shape-specialized QUDT kernel: forward rule\(s\) 4\./);
  assert.ok(result.program!.rules.reduce((bytes, rule) => bytes + rule.query.length, 0) < 100_000, 'Reusable helpers keep the bundled QUDT program compact.');
  for (const [number, unit, expected] of [['32', 'CentiM', 0.32], ['450', 'MilliM', 0.45], ['1.2', 'M', 1.2]] as const) {
    const output = await run(result, sample(`"${number}"^^xsd:decimal`, unit));
    assert.equal(output.length, 5);
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
  assert.equal(Number(numericValue(await run(scientific, sample('"32"^^xsd:decimal', 'CentiM')))?.value), 0.32, 'Bundled QUDT metadata remains available alongside provider metadata.');
  const configuration = (target: string, code: string) => `\n<urn:target-profile> <https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#datatype> <https://w3id.org/cdt/length> ; <https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#targetUnit> <http://qudt.org/vocab/unit/${target}> ; <https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#targetUcumCode> \"${code}\" .`;
  const qudtProfile = loadDefaultRuleProfiles().find(profile => profile.precompiledRuntime)!;
  const compileQudt = (background: string, input: string, output: string) => generateSparqlConstruct({
    profiles: [qudtProfile], ontology: parse(background), shaclIn: parse(input), shaclOut: parse(output.replaceAll('schema:about', 'museum:heightOf')) });
  const reverse = compileQudt(ontology + configuration('CentiM', 'cm'), shaclIn, shaclOut.replaceAll('unit:M', 'unit:CentiM'));
  assert.ok(reverse.query);
  assert.equal(Number(numericValue(await run(reverse, sample('"0.32"^^xsd:decimal', 'M')), 'CentiM')?.value), 32);
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
  const affine = compileQudt(temperatureOntology, temperatureIn, shaclOut.replaceAll('unit:M', 'unit:K'));
  assert.ok(affine.query);
  assert.equal(Number(numericValue(await run(affine, sample('"20"^^xsd:decimal', 'DEG_C')))?.value), 293.15);
  const reverseAffine = compileQudt(temperatureOntology + configuration('DEG_C', 'Cel'), temperatureIn, shaclOut.replaceAll('unit:M', 'unit:DEG_C'));
  assert.ok(reverseAffine.query);
  assert.equal(Number(numericValue(await run(reverseAffine, sample('"293.15"^^xsd:decimal', 'K')), 'DEG_C')?.value), 20, 'Subtract target offsets when converting Kelvin to Celsius.');
  const actualEngine = new InferenceEngine();
  actualEngine.load(loadDefaultRuleProfiles(), parse(ontology), { shaclIn: parse(shaclIn), shaclOut: parse(shaclOut) });
  const normalizeAllocation = (runtime: string) => runtime.replace(/https:\/\/eyereasoner\.github\.io\/\.well-known\/genid\/[a-f0-9-]+/g, 'urn:allocated');
  assert.equal(normalizeAllocation(result.runtime), normalizeAllocation(actualEngine.getRuntime().split('\n').filter(line => !line.startsWith('\"')).join('\n')), 'Reuse the original rules and RDF-compatible background; load-time allocations may differ.');
  const changed = generateSparqlConstruct({ ontology: parse(ontology), shaclIn: parse(shaclIn), shaclOut: parse(shaclOut),
    rules: result.runtime.replace('math:product\n        ?canonicalValue', 'math:sum\n        ?canonicalValue') });
  assert.ok(changed.query);
  assert.equal(Number(numericValue(await run(changed, sample('"32"^^xsd:decimal', 'CentiM')))?.value), 32.01,
    'Changing the bundled N3 arithmetic changes the actual SPARQL result.');
  console.log('SPARQL QUDT: decimal conversion, offsets, identity, reverse conversion and safety diagnostics verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
