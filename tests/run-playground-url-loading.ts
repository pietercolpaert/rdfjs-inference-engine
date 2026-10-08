import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRdfUrlLoader } from '../browser-src/rdf-url-loader';
import type { RdfUrlLoaderOptions } from '../browser-src/rdf-url-loader';

async function main(): Promise<void> {
  const context = vm.createContext({ console, AbortController, AbortSignal, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval });
  context.self = context;
  vm.runInContext(readFileSync('browser/rdfjs-inference-engine.min.js', 'utf8'), context);
  const api = context.RdfjsInferenceEngine;
  Object.assign(globalThis, { document: { baseURI: 'https://example.org/index.html' } });
  let contents = 'original input';
  const changeListeners: (() => void)[] = [];
  const editor = {
    getValue: () => contents,
    setValue: (value: string) => { contents = value; changeListeners.forEach(listener => listener()); },
    on: (_event: string, listener: () => void) => { changeListeners.push(listener); },
  };
  const input = { value: 'https://example.org/messages.trig', reportValidity: () => true, addEventListener: () => {} } as unknown as HTMLInputElement;
  const button = { disabled: false, addEventListener: () => {} } as unknown as HTMLButtonElement;
  const status = { textContent: '' } as unknown as HTMLElement;
  let resolveLoad: (value: any) => void = () => {};
  let pending = 0;
  const loader = createRdfUrlLoader({ input, button, status, editor,
    api: { ...api, dereferenceRdfUrl: () => new Promise(resolve => { resolveLoad = resolve; }) },
    onPendingChange: value => { pending += value ? 1 : -1; },
  } as RdfUrlLoaderOptions);
  const messages = api.parseRdfOrMessages(readFileSync('examples/transit-messages/input.messages.trig', 'utf8'));
  assert.ok(messages.messages.length > 1);
  const response = { ...messages, prefixes: {}, url: input.value, statusCode: 200 };
  const first = loader.load();
  assert.equal(pending, 1);
  assert.equal(button.disabled, true);
  resolveLoad(response);
  await first;
  assert.equal(pending, 0);
  assert.equal(button.disabled, false);
  const reloaded = api.parseRdfOrMessages(contents);
  assert.equal(reloaded.isMessages, true);
  assert.deepEqual(reloaded.messages.map((m: any[]) => m.length), messages.messages.map((m: any[]) => m.length), 'Message boundaries survive loading into CodeMirror.');
  assert.match(status.textContent!, /RDF messages/);

  const second = loader.load();
  editor.setValue('edited');
  resolveLoad(response);
  await second;
  assert.equal(contents, 'edited', 'A load must not overwrite edits made while fetching.');
  assert.match(status.textContent!, /edited while loading/);

  const third = loader.load();
  loader.reset();
  editor.setValue('new example');
  resolveLoad(response);
  await third;
  assert.equal(contents, 'new example', 'Resetting or changing examples discards a stale response.');
  assert.equal(input.value, '');
  assert.equal(status.textContent, '');
  assert.equal(pending, 0);

  input.value = 'https://example.org/missing.ttl';
  const fourth = loader.load();
  resolveLoad({ ...response, statusCode: 404 });
  await fourth;
  assert.match(status.textContent!, /HTTP 404/);
  assert.equal(contents, 'new example', 'Failed fetches preserve editor content.');

  input.value = 'https://example.org/ontology.ttl';
  const rdf = api.parseRdfOrMessages('<https://example.org/s> <https://example.org/p> "value" .');
  const fifth = loader.load();
  resolveLoad({ ...rdf, prefixes: {}, url: input.value });
  await fifth;
  assert.equal(api.parseRdfOrMessages(contents).quads.length, 1);
  assert.match(status.textContent!, /1 triples/);
  input.value = 'file:///tmp/private.ttl';
  await loader.load();
  assert.match(status.textContent!, /HTTP or HTTPS/);
  assert.equal(pending, 0);
  console.log('Playground URL loading: RDF, message boundaries, fetch failures, edits and resets verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
