import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Quad } from '@rdfjs/types';
import { Parser as RdfParser } from 'rdf-parser-ts';
import { Parser as SparqlParser } from 'sparqljs';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { generateSparqlConstruct, executeSparqlRuntime, createRdfjsSparqlExecutor, type SparqlConstructResult } from '../src';
const prefix = `@prefix ex: <https://example.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
const parse = (text: string): Quad[] => new RdfParser().parse(prefix + text) as Quad[];
const ontology = parse(`ex:Reading rdfs:subClassOf ex:Intermediate . ex:Intermediate owl:equivalentClass ex:Observation .
ex:temperature rdfs:subPropertyOf ex:measurement . ex:measurement owl:equivalentProperty ex:value .
ex:timestamp owl:equivalentProperty ex:time . ex:sensor owl:inverseOf ex:observed .
ex:child owl:equivalentProperty ex:part . ex:label rdfs:subPropertyOf ex:name .`);
const provider = parse(`ex:Provider a sh:NodeShape ; sh:targetClass ex:Reading ;
sh:property [ sh:path ex:temperature ] ; sh:property [ sh:path ex:timestamp ] ;
sh:property [ sh:path ex:sensor ] ; sh:property [ sh:path (ex:child ex:label) ] .`);
const consumer = parse(`ex:Consumer a sh:NodeShape ; sh:targetClass ex:Observation ;
sh:property [ sh:path ex:value ; sh:datatype xsd:decimal ; sh:minCount 1 ] ;
sh:property [ sh:path ex:time ; sh:datatype xsd:dateTime ] ;
sh:property [ sh:path [ sh:inversePath ex:observed ] ] ;
sh:property [ sh:path (ex:part ex:name) ] .`);
const engine = new QueryEngine();
async function execute(result: SparqlConstructResult, data: string): Promise<Quad[]> {
  const query = result.query;
  assert.ok(query && result.program, 'Expected a translated runtime.');
  const parsed = new SparqlParser().parse(query);
  assert.ok('queryType' in parsed);
  assert.equal(parsed.queryType, 'CONSTRUCT');
  return (await executeSparqlRuntime(result.program, parse(data), createRdfjsSparqlExecutor(engine), { outputQuery: query })).output;
}
const key = (q: Quad): string => [q.subject, q.predicate, q.object].map(t => `${t.termType}:${t.value}${t.termType === 'Literal' ? ':' + t.datatype.value + ':' + t.language : ''}`).join(' ');
async function main(): Promise<void> {
  const result = generateSparqlConstruct({ ontology, shaclIn: provider, shaclOut: consumer });
  assert.equal(result.mappings.length, 4);
  assert.ok(!result.diagnostics.some(d => d.severity === 'error'));
  const actual = await execute(result, `ex:m a ex:Reading ; ex:temperature "18.4"^^xsd:decimal ; ex:sensor ex:s ; ex:child ex:c . ex:c ex:label "inside" .
ex:n a ex:Reading ; ex:temperature "20"^^xsd:decimal ; ex:timestamp "2026-10-08T12:00:00Z"^^xsd:dateTime .`);
  const expected = parse(`ex:m a ex:Observation ; ex:value "18.4"^^xsd:decimal ; ex:part ex:c . ex:s ex:observed ex:m . ex:c ex:name "inside" .
ex:n a ex:Observation ; ex:value "20"^^xsd:decimal ; ex:time "2026-10-08T12:00:00Z"^^xsd:dateTime .`);
  assert.deepEqual(new Set(actual.map(key)), new Set(expected.map(key)), 'Map classes, inverse properties and nested paths while preserving optional values.');
  assert.equal((await execute(result, 'ex:m a ex:Reading ; ex:temperature "wrong datatype" .')).length, 0);
  const missing = generateSparqlConstruct({ ontology, shaclIn: provider, shaclOut: parse('ex:C sh:targetClass ex:Observation ; sh:property [ sh:path ex:missing ; sh:minCount 1 ] .') });
  assert.ok(missing.query);
  assert.equal((await execute(missing, 'ex:m a ex:Reading ; ex:temperature 1 .')).length, 0, 'Rules cannot fabricate missing required fields.');
  const optional = generateSparqlConstruct({ ontology, shaclIn: provider, shaclOut: parse('ex:C sh:targetClass ex:Observation ; sh:property [ sh:path ex:missing ] .') });
  assert.ok(optional.query);
  assert.equal((await execute(optional, 'ex:m a ex:Reading .')).length, 1);
  for (const constraint of ['sh:node ex:Nested', 'sh:or (ex:A ex:B)', 'sh:deactivated true']) {
    assert.equal(generateSparqlConstruct({ ontology, shaclIn: provider, shaclOut: parse(`ex:C sh:targetClass ex:Observation ; ${constraint} .`) }).query, null);
  }
  for (const path of ['[ sh:alternativePath (ex:value ex:time) ]', '[ sh:oneOrMorePath ex:value ]']) {
    assert.equal(generateSparqlConstruct({ ontology, shaclIn: provider, shaclOut: parse(`ex:C sh:property [ sh:path ${path} ] .`) }).query, null);
  }
  const unaligned = generateSparqlConstruct({ ontology: [], shaclIn: provider, shaclOut: consumer });
  assert.equal((await execute(unaligned, 'ex:m a ex:Reading ; ex:temperature 1 .')).length, 0, 'Do not invent class alignment.');
  const reverse = generateSparqlConstruct({ ontology: parse('ex:value rdfs:subPropertyOf ex:temperature .'), shaclIn: provider, shaclOut: parse('ex:C sh:property [ sh:path ex:value ; sh:minCount 1 ] .') });
  assert.equal((await execute(reverse, 'ex:m a ex:Reading ; ex:temperature 1 .')).length, 0, 'Subproperty mappings are directional.');
  const alternatives = generateSparqlConstruct({ ontology, shaclIn: parse('ex:P sh:targetClass ex:Reading ; sh:property [ sh:path [ sh:alternativePath (ex:temperature ex:value) ] ] .'), shaclOut: parse('ex:C sh:property [ sh:path ex:value ; sh:minCount 1 ] .') });
  assert.equal((await execute(alternatives, 'ex:m a ex:Reading ; ex:temperature 1 ; ex:value 2 .')).length, 2);
  const constants = generateSparqlConstruct({ ontology: [], shaclIn: parse('ex:P sh:targetSubjectsOf ex:label ; sh:property [ sh:path ex:label ] .'), shaclOut: parse('ex:C sh:property [ sh:path ex:label ; sh:hasValue "a\\\"b" ; sh:in ("a\\\"b" "other") ] .') });
  assert.equal((await execute(constants, 'ex:m ex:label "other" .')).length, 0, 'Never fabricate hasValue constants.');
  assert.equal((await execute(constants, 'ex:m ex:label "a\\\"b" .')).length, 1, 'Serialize escaped RDF literals.');
  const multiple = generateSparqlConstruct({ ontology: [], shaclIn: parse('ex:P sh:targetClass ex:A, ex:B ; sh:property [ sh:path ex:value ] .'), shaclOut: parse('ex:C sh:targetClass ex:A, ex:B ; sh:property [ sh:path ex:value ] .') });
  const multiOutput = await execute(multiple, 'ex:m a ex:A ; ex:value 1 . ex:n a ex:B ; ex:value 2 .');
  assert.deepEqual(new Set(multiOutput.map(key)), new Set(parse('ex:m a ex:A ; ex:value 1 . ex:n a ex:B ; ex:value 2 .').map(key)), 'Target classes are a union, and branch variables do not leak.');
  const namedProperty = generateSparqlConstruct({ ontology: [],
    shaclIn: parse('ex:P sh:targetClass ex:A ; sh:property ex:Field . ex:Field a sh:PropertyShape ; sh:path ex:value .'),
    shaclOut: parse('ex:C sh:targetClass ex:A ; sh:property ex:Field . ex:Field a sh:PropertyShape ; sh:path ex:value .') });
  assert.equal(namedProperty.mappings.length, 1, 'Attached named property shapes are not additional root shapes.');
  const targetUnion = generateSparqlConstruct({ ontology: [],
    shaclIn: parse('ex:P sh:targetClass ex:A ; sh:targetNode ex:untyped ; sh:property [ sh:path ex:value ] .'),
    shaclOut: parse('ex:C sh:targetClass ex:A ; sh:property [ sh:path ex:value ] .') });
  assert.equal((await execute(targetUnion, 'ex:untyped ex:value 1 .')).length, 0, 'Target nodes do not imply target-class membership.');
  const cycle = parse('ex:temperature owl:equivalentProperty ex:measurement . ex:measurement rdfs:subPropertyOf ex:temperature, ex:value .');
  assert.ok(generateSparqlConstruct({ ontology: cycle, shaclIn: provider, shaclOut: parse('ex:C sh:property [ sh:path ex:value ; sh:minCount 1 ] .') }).query);
  assert.throws(() => generateSparqlConstruct({ ontology: [], shaclIn: parse('ex:P sh:property [ sh:path <urn:a> ] .'), shaclOut: parse('ex:C sh:targetNode [] ; sh:property [ sh:path <urn:a> ] .') }), /Blank nodes/);
  const context = vm.createContext({ console, AbortController, AbortSignal, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval });
  context.self = context;
  vm.runInContext(readFileSync('browser/rdfjs-inference-engine.min.js', 'utf8'), context);
  assert.equal(typeof context.RdfjsInferenceEngine.generateSparqlConstruct, 'function');
  const browserResult = context.RdfjsInferenceEngine.generateSparqlConstruct({ ontology, shaclIn: provider, shaclOut: consumer });
  assert.equal(browserResult.query, result.query, 'Browser and Node API produce the same query.');
  await testPlayground(context.RdfjsInferenceEngine);
  console.log('SPARQL CONSTRUCT: executed mappings, diagnostics, and browser/Node parity verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

async function testPlayground(api: any): Promise<void> {
  const elements = new Map<string, any>();
  const editors = new Map<string, any>();
  const names = ['ontology', 'shaclIn', 'shaclOut'];
  for (const id of [...names.flatMap(name => [`${name}Text`, `${name}Url`, `${name}Load`, `${name}Status`]),
    'queryText', 'status', 'diagnostics', 'generateButton', 'resetButton', 'copyButton', 'downloadButton',
    'exampleSelect', 'exampleDescription', 'ndeGuidance', 'dataText', 'dataUrl', 'dataLoad', 'dataLoadStatus',
    'rulesText', 'runtimeText', 'translatedText', 'runtimePanel', 'resultText', 'executionPanel', 'executionStatus', 'runQueryButton', 'stopQueryButton']) {
    elements.set(id, { id, value: '', textContent: '', disabled: false, handlers: {} as Record<string, (...args: any[]) => unknown>,
      appendChild: () => {}, reportValidity: () => true, addEventListener(event: string, handler: (...args: any[]) => unknown) { this.handlers[event] = handler; } });
  }
  let resolveLoad: (result: any) => void = () => {};
  const workers: any[] = [];
  class FakeWorker {
    request: any;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request: any) { this.request = request; }
    terminate() { this.terminated = true; }
  }
  const sandbox = vm.createContext({ AbortController, AbortSignal, URL, Blob, setTimeout, clearTimeout, Worker: FakeWorker,
    navigator: { clipboard: { writeText: async () => {} } },
    document: { baseURI: 'https://example.org/sparql-construct.html', getElementById: (id: string) => elements.get(id), createElement: () => ({}) },
    RdfjsInferenceEngine: { ...api, dereferenceRdfUrl: () => new Promise(resolve => { resolveLoad = resolve; }) },
    CodeMirror: { fromTextArea: (element: any) => {
      let text = element.value;
      const listeners: (() => void)[] = [];
      const editor = { refresh: () => {}, getValue: () => text, setValue: (value: string) => { text = value; listeners.forEach(listener => listener()); },
        on: (_event: string, listener: () => void) => listeners.push(listener) };
      editors.set(element.id, editor);
      return editor;
    } },
  });
  sandbox.self = sandbox;
  vm.runInContext(readFileSync('browser/sparql-construct-playground.min.js', 'utf8'), sandbox);
  assert.ok(editors.get('queryText').getValue().startsWith('CONSTRUCT'));
  assert.equal(editors.size, 9, 'Mapping inputs, rules, generated runtime, query, data and result use CodeMirror.');
  assert.equal(elements.get('executionPanel').hidden, false);
  assert.equal(elements.get('exampleSelect').value, 'nde-amsterdam-photograph');
  assert.ok(editors.get('ontologyText').getValue().includes('dcterms:title rdfs:subPropertyOf schema:name'));
  elements.get('runQueryButton').handlers.click();
  assert.equal(workers[0].request.query, editors.get('queryText').getValue(), 'Send the displayed query unchanged to Comunica.');
  assert.equal(workers[0].request.dataSource, editors.get('dataText').getValue());
  elements.get('stopQueryButton').handlers.click();
  assert.equal(workers[0].terminated, true);
  elements.get('runQueryButton').handlers.click();
  workers[1].onmessage({ data: { type: 'result', output: 'constructed RDF', processedMessages: 2, outputQuads: 10, elapsedMs: 10 } });
  assert.equal(editors.get('resultText').getValue(), 'constructed RDF');
  assert.equal(workers[1].terminated, true);
  elements.get('runQueryButton').handlers.click();
  editors.get('dataText').setValue('changed input');
  assert.equal(workers[2].terminated, true, 'Editing data stops the active execution.');
  assert.ok(editors.get('queryText').getValue(), 'Editing data preserves the generated query.');
  workers[2].onmessage({ data: { type: 'result', output: 'stale result', processedMessages: 1, outputQuads: 1, elapsedMs: 1 } });
  assert.equal(editors.get('resultText').getValue(), '', 'Late results cannot replace current output.');
  const input = elements.get('ontologyUrl');
  const load = elements.get('ontologyLoad');
  input.value = 'https://example.org/ontology.ttl';
  load.handlers.click();
  assert.equal(load.disabled, true);
  const loaded = parse('ex:temperature owl:equivalentProperty ex:value .');
  resolveLoad({ quads: loaded, prefixes: {}, url: input.value, statusCode: 200 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(load.disabled, false);
  assert.ok(editors.get('ontologyText').getValue().includes('equivalentProperty'));
  assert.equal(editors.get('queryText').getValue(), '', 'Loading or editing invalidates stale queries.');
  assert.equal(elements.get('executionPanel').hidden, true, 'Execution is hidden until a current query exists.');
  load.handlers.click();
  editors.get('ontologyText').setValue('edited while loading');
  resolveLoad({ quads: loaded, prefixes: {}, url: input.value });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(editors.get('ontologyText').getValue(), 'edited while loading', 'Loading preserves edits made during the request.');
  elements.get('resetButton').handlers.click();
  assert.ok(editors.get('queryText').getValue().startsWith('CONSTRUCT'));
  load.handlers.click(); // Reset removed the URL.
  assert.match(elements.get('ontologyStatus').textContent, /valid document URL/);
  input.value = 'https://example.org/bad.ttl';
  load.handlers.click();
  resolveLoad({ quads: [], prefixes: {}, url: input.value, statusCode: 404 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(elements.get('ontologyStatus').textContent, /HTTP 404/);
  assert.ok(editors.get('ontologyText').getValue().includes('subClassOf'), 'Failed loading preserves editor contents.');
  elements.get('exampleSelect').value = 'qudt-museum-dimensions';
  elements.get('exampleSelect').handlers.change();
  assert.ok(editors.get('translatedText').getValue().includes('BIND'));
  assert.ok(editors.get('rulesText').getValue().includes('math:product'));
  elements.get('runQueryButton').handlers.click();
  assert.ok(workers.at(-1).request.program.rules.length);
  editors.get('rulesText').setValue('@prefix math: <http://www.w3.org/2000/10/swap/math#>. { (1 2) math:exponentiation ?x } => { <urn:s> <urn:p> ?x }.');
  assert.equal(workers.at(-1).terminated, true);
  elements.get('generateButton').handlers.click();
  assert.equal(editors.get('queryText').getValue(), '');
  assert.match(elements.get('diagnostics').textContent, /Unsupported N3 built-in/);
  assert.ok(editors.get('ontologyText').getValue().includes('conversionMultiplier'));
  assert.ok(editors.get('dataText').getValue().includes('450'));
  elements.get('exampleSelect').value = 'sensor-reading';
  elements.get('exampleSelect').handlers.change();
  assert.ok(editors.get('ontologyText').getValue().includes('SensorReading'));
  assert.ok(editors.get('queryText').getValue().includes('Observation'));
  assert.equal(elements.get('ndeGuidance').hidden, true);
}
