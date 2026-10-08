import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { generateSparqlConstruct, type SparqlRuntimeProgram } from '../src';
import type { ConstructWorkerMessage, ConstructWorkerRequest } from '../browser-src/sparql-construct-worker';

const directory = 'examples/sparql-construct/nde-amsterdam-photograph/';
const read = (file: string) => readFileSync(directory + file, 'utf8');
const parse = (text: string): Quad[] => new Parser().parse(text) as Quad[];
const key = (q: Quad) => [q.subject, q.predicate, q.object].map(t => `${t.termType}:${t.value}${t.termType === 'Literal' ? ':' + t.datatype.value + ':' + t.language : ''}`).join(' ');
const apiSource = readFileSync('browser/rdfjs-inference-engine.min.js', 'utf8');
const workerSource = readFileSync('browser/sparql-construct-worker.min.js', 'utf8');

async function execute(query: string, dataSource: string, program?: SparqlRuntimeProgram): Promise<ConstructWorkerMessage> {
  const sandbox = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, performance,
    AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
    fetch: () => { throw new Error('Execution must not fetch background data.'); },
  });
  sandbox.self = sandbox;
  sandbox.importScripts = () => { vm.runInContext(apiSource, sandbox); };
  vm.runInContext(workerSource, sandbox);
  const request: ConstructWorkerRequest = { apiScriptUrl: 'https://example.org/api.js', query, program, dataSource, baseIRI: 'https://example.org/input/' };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Comunica worker did not finish.')), 10000);
    sandbox.postMessage = (message: ConstructWorkerMessage) => {
      if (message.type !== 'status') { clearTimeout(timeout); resolve(message); }
    };
    void sandbox.onmessage({ data: request });
  });
}
async function main(): Promise<void> {
  const compiled = generateSparqlConstruct({ ontology: parse(read('ontology.ttl')),
    shaclIn: parse(read('shapes-in.ttl')), shaclOut: parse(read('shapes-out.ttl')) });
  assert.ok(compiled.query);
  assert.equal(compiled.mappings.length, 5);
  assert.ok(!compiled.diagnostics.some(d => d.severity === 'error'));
  const result = await execute(compiled.query, read('input.messages.trig'), compiled.program!);
  assert.equal(result.type, 'result');
  if (result.type !== 'result') throw new Error(JSON.stringify(result));
  assert.equal(result.processedMessages, 2);
  assert.equal(result.outputQuads, 10);
  const apiContext = vm.createContext({ AbortController, AbortSignal, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval });
  apiContext.self = apiContext;
  vm.runInContext(apiSource, apiContext);
  const api = apiContext.RdfjsInferenceEngine;
  const expected = api.parseRdfOrMessages(read('expected-output.messages.trig'));
  const actual = api.parseRdfOrMessages(result.output);
  assert.equal(actual.isMessages, true);
  assert.equal(actual.messages.length, expected.messages.length);
  actual.messages.forEach((message: Quad[], index: number) => {
    assert.deepEqual(new Set(message.map(key)), new Set(expected.messages[index].map(key)), 'Browser Comunica output must match the heritage fixture per message.');
  });
  assert.match(result.output, /@prefix schema:/, 'Output-only namespaces use prefix.cc defaults.');
  assert.match(result.output, /@prefix photo:/, 'Keep prefixes from the input message log.');
  assert.ok(!result.output.includes('@prefix archive:') && !result.output.includes('@prefix dcterms:'), 'Do not declare unused source prefixes.');
  assert.ok(actual.quads.some((q: Quad) => q.object.termType === 'Literal' && q.object.language === 'nl'), 'Dutch title language tags survive execution.');
  const qudtDirectory = 'examples/sparql-construct/qudt-museum-dimensions/';
  const qudtRead = (file: string) => readFileSync(qudtDirectory + file, 'utf8');
  const qudtCompiled = generateSparqlConstruct({ ontology: parse(qudtRead('ontology.ttl')),
    shaclIn: parse(qudtRead('shapes-in.ttl')), shaclOut: parse(qudtRead('shapes-out.ttl')) });
  const qudtQuery = qudtCompiled.query;
  assert.ok(qudtQuery);
  assert.equal(api.generateSparqlConstruct({ ontology: parse(qudtRead('ontology.ttl')), shaclIn: parse(qudtRead('shapes-in.ttl')), shaclOut: parse(qudtRead('shapes-out.ttl')) }).query, qudtQuery, 'Browser and Node generate the same QUDT arithmetic.');
  const qudtResult = await execute(qudtQuery, qudtRead('input.messages.trig'), qudtCompiled.program!);
  if (qudtResult.type !== 'result') throw new Error(JSON.stringify(qudtResult));
  assert.equal(qudtResult.processedMessages, 3);
  assert.equal(qudtResult.outputQuads, 12);
  const qudtActual = api.parseRdfOrMessages(qudtResult.output);
  const qudtExpected = api.parseRdfOrMessages(qudtRead('expected-output.messages.trig'));
  assert.equal(qudtActual.messages.length, 3);
  qudtActual.messages.forEach((message: Quad[], index: number) => {
    const normalize = (q: Quad) => q.predicate.value.endsWith('/numericValue') ? key(q).replace(q.object.value, String(Number(q.object.value))) : key(q);
    assert.deepEqual(new Set(message.map(normalize)), new Set(qudtExpected.messages[index].map(normalize)), 'Browser Comunica performs the QUDT conversion in each message.');
  });
  const noOntology = generateSparqlConstruct({ ontology: [], shaclIn: parse(read('shapes-in.ttl')), shaclOut: parse(read('shapes-out.ttl')) });
  const unmapped = await execute(noOntology.query!, read('input.messages.trig'), noOntology.program!);
  assert.equal(unmapped.type === 'result' && unmapped.outputQuads, 0, 'The example mapping depends on the explicit ontology.');
  const ordinary = await execute('CONSTRUCT { ?s <urn:result> ?o } WHERE { ?s <urn:source> ?o }', '<urn:s> <urn:source> "ordinary" .');
  assert.equal(ordinary.type, 'result');
  if (ordinary.type === 'result') {
    assert.equal(ordinary.processedMessages, 1);
    assert.equal(api.parseRdfOrMessages(ordinary.output).quads[0].predicate.value, 'urn:result', 'Execute exactly the supplied query.');
  }
  const prefixed = await execute('CONSTRUCT { ?s <https://schema.org/name> ?o } WHERE { ?s <urn:source> ?o }', '@prefix schema: <https://example.org/items/>. schema:one <urn:source> "title".');
  assert.equal(prefixed.type, 'result');
  if (prefixed.type === 'result') assert.match(prefixed.output, /schema:one schema2:name/, 'Source labels take priority over conflicting registry names.');
  const named = await execute('CONSTRUCT { ?s <urn:result> ?o } WHERE { ?s <urn:source> ?o }', '<urn:g> { <urn:s> <urn:source> "named" . }');
  assert.equal(named.type, 'result');
  if (named.type === 'result') assert.equal(named.outputQuads, 1, 'Treat message contents as the default graph.');
  const isolated = await execute('CONSTRUCT { ?s <urn:result> ?b } WHERE { ?s <urn:a> ?a ; <urn:b> ?b }', 'VERSION "1.2-messages"\n<urn:s> <urn:a> "a" .\nMESSAGE\n<urn:s> <urn:b> "b" .');
  assert.equal(isolated.type, 'result');
  if (isolated.type === 'result') assert.equal(isolated.outputQuads, 0, 'Query joins cannot leak across message boundaries.');
  assert.equal((await execute('not a query', '<urn:s> <urn:p> "x" .')).type, 'error');
  assert.equal((await execute(compiled.query, 'not RDF')).type, 'error');
  console.log('Browser Comunica worker: heritage mappings, exact-query execution, message isolation and errors verified.');
}
void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
