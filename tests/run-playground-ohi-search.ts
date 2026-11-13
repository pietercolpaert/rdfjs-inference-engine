import assert from 'node:assert/strict';
import { createOhiSearch, pickRdfArtifact } from '../browser-src/ohi-search';
import type { OhiSearchOptions } from '../browser-src/ohi-search';

type FakeElement = {
  tagName: string;
  children: (FakeElement | string)[];
  textContent: string;
  className: string;
  hidden: boolean;
  type: string;
  value: string;
  href: string;
  attributes: Record<string, string>;
  listeners: Record<string, ((event: any) => void)[]>;
  append(...children: (FakeElement | string)[]): void;
  replaceChildren(...children: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(event: string, listener: (event: any) => void): void;
};

function element(tagName = 'div'): FakeElement {
  return {
    tagName, children: [], className: '', hidden: false, type: '', value: '', href: '', attributes: {}, listeners: {},
    get textContent(): string {
      return this.children.map(child => typeof child === 'string' ? child : child.textContent).join('');
    },
    set textContent(value: string) { this.children = value ? [value] : []; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(event, listener) { (this.listeners[event] ??= []).push(listener); },
  };
}

const child = (parent: FakeElement, index: number) => parent.children[index] as FakeElement;

const ssn = {
  base_url: 'https://api.ohi.dev/files/packages/w3c/ssn/2017/',
  namespace: 'w3c', name: 'ssn', version: '2017', title: 'Semantic Sensor Network Ontology',
  description: 'Sensors and observations.', licenses: ['W3C-20150513'], published_at: '2026-10-23T13:01:09.869Z',
  formats: ['linkml-yaml', 'owl-rdfxml', 'owl-turtle', 'rdfs-turtle'],
};
const otherHit = { ...ssn, base_url: 'https://api.ohi.dev/files/packages/x/y/1/', name: 'y', title: 'Other ontology' };
const artifact = (format: string, origin: string, file: string) => ({
  format, origin, roots: [file], sha256: '0'.repeat(64), size_bytes: 22714, url: `https://api.ohi.dev/files/packages/w3c/ssn/2017/${file}`,
});
const ssnPublication = {
  ...ssn, dependencies: [], keywords: [], publisher: 'W3C and OGC', schema_version: 2,
  artifacts: [
    artifact('owl-rdfxml', 'GENERATED', 'ssn.owl'),
    artifact('owl-turtle', 'GENERATED', 'ssn.generated.ttl'),
    artifact('owl-turtle', 'UPSTREAM', 'ssn.ttl'),
    artifact('rdfs-turtle', 'GENERATED', 'ssn.rdfs.ttl'),
  ],
};

async function main(): Promise<void> {
  Object.assign(globalThis, { document: { createElement: element } });

  assert.equal(pickRdfArtifact(ssnPublication.artifacts as any)?.url.endsWith('/ssn.ttl'), true, 'Upstream OWL Turtle is preferred.');
  assert.equal(pickRdfArtifact(ssnPublication.artifacts.filter(a => a.format !== 'owl-turtle') as any)?.format, 'rdfs-turtle');
  assert.equal(pickRdfArtifact([artifact('owl-rdfxml', 'UPSTREAM', 'x.owl')] as any)?.format, 'owl-rdfxml');
  assert.equal(pickRdfArtifact([artifact('linkml-yaml', 'GENERATED', 'x.yaml')] as any), undefined);

  const searches: { q: string; filter_by?: string; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  let inspected = '';
  const client = {
    search: (request: { q: string; filter_by?: string }) => new Promise((resolve, reject) => { searches.push({ ...request, resolve, reject }); }),
    inspect: async (baseUrl: string) => { inspected = baseUrl; return ssnPublication; },
  };
  const input = element('input');
  const results = element('ul');
  results.hidden = true;
  const status = element('p');
  const urlInput = element('input');
  let loadedUrl = '';
  const loader = { load: async () => { loadedUrl = urlInput.value; } };
  const search = createOhiSearch({ client, input, results, status, urlInput, loader } as unknown as OhiSearchOptions);
  const pressEnter = () => input.listeners.keydown.forEach(listener => listener({ key: 'Enter', preventDefault() {} }));

  input.value = 'sens';
  pressEnter();
  input.value = 'sensor';
  pressEnter();
  assert.deepEqual(searches.map(s => s.q), ['sens', 'sensor']);
  assert.equal(searches[1].filter_by, 'formats:=[owl-turtle,rdfs-turtle,owl-rdfxml]', 'Only ontologies with an RDF file are searched.');
  assert.match(status.textContent, /Searching ohi\.dev/);
  searches[1].resolve({ hits: [ssn], total: 1, page: 1, per_page: 10, search_cutoff: false });
  searches[0].resolve({ hits: [otherHit], total: 1, page: 1, per_page: 10, search_cutoff: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(results.children.length, 1, 'A stale response is ignored.');
  assert.equal(results.hidden, false);
  const hitButton = child(child(results, 0), 0);
  assert.equal(child(hitButton, 0).textContent, 'Semantic Sensor Network Ontology');
  assert.equal(child(hitButton, 1).textContent, 'w3c/ssn@2017 · W3C-20150513');
  const hitPage = child(child(results, 0), 1);
  assert.equal(hitPage.tagName, 'a', 'Each result links to its page on ohi.dev, outside the select button.');
  assert.equal(hitPage.href, 'https://ohi.dev/o/w3c/ssn@2017');
  assert.match(hitPage.attributes['aria-label'], /View Semantic Sensor Network Ontology 2017 on ohi\.dev/);
  assert.match(status.textContent, /1 result on ohi\.dev/);

  hitButton.listeners.click.forEach(listener => listener({}));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(inspected, ssn.base_url);
  assert.equal(urlInput.value, 'https://api.ohi.dev/files/packages/w3c/ssn/2017/ssn.ttl');
  assert.equal(loadedUrl, urlInput.value, 'The chosen file goes through the URL loader.');
  assert.equal(results.hidden, true);
  assert.match(status.textContent, /w3c\/ssn@2017, owl-turtle, 22 KB\) from ohi\.dev\. License: W3C-20150513\./);
  const statusLink = status.children.find(item => typeof item !== 'string') as FakeElement;
  assert.equal(statusLink.textContent, 'w3c/ssn@2017');
  assert.equal(statusLink.href, 'https://ohi.dev/o/w3c/ssn@2017', 'The loaded release links to its page on ohi.dev.');

  input.value = 'nothing';
  pressEnter();
  searches[2].resolve({ hits: [], total: 0, page: 1, per_page: 10, search_cutoff: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(status.textContent, /No ontologies with an RDF file/);
  assert.equal(results.hidden, true);

  input.value = 'broken';
  pressEnter();
  searches[3].reject(new Error('The HTTP transfer failed.'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(status.textContent, /Could not search ohi\.dev: The HTTP transfer failed\./);

  input.value = 'late';
  pressEnter();
  search.reset();
  searches[4].resolve({ hits: [ssn], total: 1, page: 1, per_page: 10, search_cutoff: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(input.value, '');
  assert.equal(status.textContent, '');
  assert.equal(results.children.length, 0, 'Changing examples discards a pending search.');

  input.value = 'typed';
  input.listeners.input.forEach(listener => listener({}));
  input.listeners.input.forEach(listener => listener({}));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(searches.slice(5).map(s => s.q), ['typed'], 'Typing searches once after a short pause.');
  console.log('Playground ohi.dev search: format filter, artifact choice, loading, stale responses, errors and resets verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
