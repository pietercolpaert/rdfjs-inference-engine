import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { generateSparqlConstruct } from '../src';
import type { ConstructWorkerMessage, ConstructWorkerRequest } from '../browser-src/sparql-construct-worker';

const directory = 'examples/sparql-construct/nde-amsterdam-photograph/';
const read = (file: string) => readFileSync(directory + file, 'utf8');
const parse = (text: string): Quad[] => new Parser().parse(text) as Quad[];
const key = (q: Quad) => [q.subject, q.predicate, q.object].map(t => `${t.termType}:${t.value}${t.termType === 'Literal' ? ':' + t.datatype.value + ':' + t.language : ''}`).join(' ');
const apiSource = readFileSync('browser/rdfjs-inference-engine.min.js', 'utf8');
const workerSource = readFileSync('browser/sparql-construct-worker.min.js', 'utf8');

async function execute(query: string, dataSource: string): Promise<ConstructWorkerMessage> {
  const sandbox = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, performance,
    AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
    fetch: () => { throw new Error('Execution must not fetch background data.'); },
  });
  sandbox.self = sandbox;
  sandbox.importScripts = () => { vm.runInContext(apiSource, sandbox); };
  vm.runInContext(workerSource, sandbox);
  const request: ConstructWorkerRequest = { apiScriptUrl: 'https://example.org/api.js', query, dataSource, baseIRI: 'https://example.org/input/' };
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
  assert.equal(compiled.diagnostics.length, 0);
  const result = await execute(compiled.query, read('input.messages.trig'));
  assert.equal(result.type, 'result');
  if (result.type !== 'result') throw new Error(JSON.stringify(result));
  assert.equal(result.processedMessages, 2);
  assert.equal(result.outputQuads, 10);
  const apiContext = vm.createContext({ URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(apiSource, apiContext);
  const api = apiContext.RdfjsInferenceEngine;
  const expected = api.parseRdfOrMessages(read('expected-output.messages.trig'));
  const actual = api.parseRdfOrMessages(result.output);
  assert.equal(actual.isMessages, true);
  assert.equal(actual.messages.length, expected.messages.length);
  actual.messages.forEach((message: Quad[], index: number) => {
    assert.deepEqual(new Set(message.map(key)), new Set(expected.messages[index].map(key)), 'Browser Comunica output must match the heritage fixture per message.');
  });
  assert.ok(actual.quads.some((q: Quad) => q.object.termType === 'Literal' && q.object.language === 'nl'), 'Dutch title language tags survive execution.');
  const noOntology = generateSparqlConstruct({ ontology: [], shaclIn: parse(read('shapes-in.ttl')), shaclOut: parse(read('shapes-out.ttl')) });
  assert.equal(noOntology.query, null, 'The example mapping depends on the explicit ontology.');
  const ordinary = await execute('CONSTRUCT { ?s <urn:result> ?o } WHERE { ?s <urn:source> ?o }', '<urn:s> <urn:source> "ordinary" .');
  assert.equal(ordinary.type, 'result');
  if (ordinary.type === 'result') {
    assert.equal(ordinary.processedMessages, 1);
    assert.equal(api.parseRdfOrMessages(ordinary.output).quads[0].predicate.value, 'urn:result', 'Execute exactly the supplied query.');
  }
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
