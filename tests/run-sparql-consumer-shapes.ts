import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { Parser as SparqlParser } from 'sparqljs';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { generateSparqlConstruct, executeSparqlRuntime, createRdfjsSparqlExecutor } from '../src';
import { compileOutputProjection } from '../src/sparql-output-projection';
const parse = (text: string) => new Parser().parse(text) as Quad[];
const read = (name: string) => readFileSync('tests/fixtures/nde-consumer/' + name, 'utf8');
const shapes = parse(read('shapes.ttl')), data = parse(read('input.ttl'));
const executor = createRdfjsSparqlExecutor(new QueryEngine());
const key = (q: Quad) => [q.subject, q.predicate, q.object, q.graph].map(t => `${t.termType}:${t.value}${t.termType === 'Literal' ? ':' + t.language + ':' + t.datatype.value : ''}`).join(' ');
async function project(consumer: Quad[], input: Quad[] = data) {
  const result = generateSparqlConstruct({ ontology: [], shaclIn: shapes, shaclOut: consumer, profiles: [] });
  assert.ok(result.query && result.program, JSON.stringify(result.diagnostics));
  new SparqlParser().parse(result.query);
  assert.ok(result.diagnostics.some(d => d.severity === 'warning' && d.message.includes('best-effort')));
  const output = await executeSparqlRuntime(result.program, input, executor, { outputQuery: result.query });
  return { result, output: output.output };
}
async function main() {
  const { result, output } = await project(shapes);
  const expected = data.filter(q => q.subject.value !== 'urn:nde-test:unrelated');
  assert.deepEqual(new Set(output.map(key)), new Set(expected.map(key)), 'Project nested creators, terms, measurements, media, IIIF, dates and coordinates without inventing or losing triples.');
  assert.ok(!output.some(q => q.subject.value === 'urn:nde-test:untyped' && q.predicate.value.endsWith('#type')), 'Unknown creators are not assigned an invented type.');
  const invalidDate = data.map(q => q.predicate.value === 'https://schema.org/birthDate'
    ? parse('<urn:nde-test:person> <https://schema.org/birthDate> "1889"^^<http://www.w3.org/2001/XMLSchema#date> .')[0] : q);
  assert.ok((await project(shapes, invalidDate)).output.some(q => q.predicate.value === 'https://schema.org/birthDate'), 'Preserve dates even when datatype and pattern constraints fail.');
  const blockedCreator = [...data, ...parse('<urn:nde-test:untyped> a <https://schema.org/Role> .')];
  assert.ok((await project(shapes, blockedCreator)).output.some(q => q.predicate.value === 'https://schema.org/creator' && q.object.value === 'urn:nde-test:untyped'), 'Negated validation constraints do not discard existing creators.');
  const twoNames = parse('@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:shape> sh:targetClass <urn:Person>; sh:property [ sh:path <urn:name>; sh:minCount 1; sh:maxCount 1; sh:uniqueLang true ], [ sh:path <urn:missing>; sh:minCount 1 ].');
  const names = parse('<urn:person> a <urn:Person>; <urn:name> "Jan"@nl, "Johannes"@nl .');
  const selected = await project(twoNames, names);
  assert.deepEqual(new Set(selected.output.map(key)), new Set(names.map(key)), 'Preserve both names despite maxCount, uniqueLang and missing required fields.');
  const notInvented = parse('@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:shape> sh:targetNode <urn:person>; sh:class <urn:Other>; sh:property [ sh:path <urn:name>; sh:hasValue "invented"; sh:maxCount 0 ].');
  assert.deepEqual(new Set((await project(notInvented, names)).output.map(key)), new Set(names.filter(q => q.predicate.value === 'urn:name').map(key)), 'Do not invent classes or constants, or suppress values for maxCount zero.');
  const propertyReference = parse('@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:shape> sh:targetNode <urn:root>; sh:node [ sh:path <urn:child>; sh:node [ sh:property [ sh:path <urn:name> ] ] ].');
  const nested = parse('<urn:root> <urn:child> <urn:childNode>; <urn:name> "unselected root name" . <urn:childNode> <urn:name> "child name" .');
  assert.deepEqual(new Set((await project(propertyReference, nested)).output.map(key)), new Set(nested.filter(q => q.object.value !== 'unselected root name').map(key)), 'Referenced property shapes traverse their endpoints, not their parents.');
  const deactivated = parse('@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:shape> sh:targetClass <urn:Example>; sh:property [ sh:path <urn:active> ], [ sh:path <urn:disabled>; sh:deactivated true; sh:node <urn:undefined> ].');
  assert.ok(compileOutputProjection({ shaclOut: deactivated }).query, 'Deactivated properties do not block generation.');
  const missing = parse('@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:shape> sh:targetClass <urn:Example>; sh:property [ sh:path <urn:p>; sh:node <urn:undefined> ].');
  assert.equal(compileOutputProjection({ shaclOut: missing }).query, null, 'Missing node-shape definitions still produce errors.');
  const context = vm.createContext({ console, URL, AbortController, AbortSignal, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval });
  context.self = context;
  vm.runInContext(readFileSync('browser/rdfjs-inference-engine.min.js', 'utf8'), context);
  const browser = context.RdfjsInferenceEngine.generateSparqlConstruct({ ontology: [], shaclIn: shapes, shaclOut: shapes, profiles: [] });
  assert.equal(browser.query, result.query, 'Node and browser compile the same nested consumer projection.');
  if (process.argv[2]) {
    const live = parse(readFileSync(process.argv[2], 'utf8'));
    const checked = await project(live);
    assert.ok(checked.output.some(q => q.subject.value === 'urn:nde-test:height' && q.predicate.value === 'https://schema.org/value'));
    assert.ok(checked.output.some(q => q.subject.value === 'urn:nde-test:coordinates' && q.predicate.value === 'https://schema.org/latitude'));
    assert.ok(checked.output.some(q => q.subject.value === 'https://example.org/iiif/manifest' && q.predicate.value === 'https://schema.org/encodingFormat'));
    const actualBrowser = context.RdfjsInferenceEngine.generateSparqlConstruct({ ontology: [], shaclIn: shapes, shaclOut: live, profiles: [] });
    assert.equal(actualBrowser.query, checked.result.query);
    console.log('Downloaded NDE profile: complete profile generated and executed in Node; browser query parity verified.');
  }
  console.log('Consumer SHACL: nested nodes, logical field selection, advisory constraints and preserved multi-valued fields, dates, identities and browser parity verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
