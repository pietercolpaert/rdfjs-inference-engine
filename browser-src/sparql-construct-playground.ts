import { generateSparqlConstruct } from '../src/sparql-construct';
import type { Quad } from '@rdfjs/types';

declare const CodeMirror: any;
const api = (globalThis as any).RdfjsInferenceEngine;
const prefixes = '@prefix ex: <https://example.org/> .\n@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n';
const example = {
  ontology: prefixes + 'ex:SensorReading rdfs:subClassOf ex:Observation .\nex:temperature rdfs:subPropertyOf ex:value .\nex:recordedAt owl:equivalentProperty ex:time .\n',
  shaclIn: prefixes + 'ex:ProviderShape a sh:NodeShape ;\n  sh:targetClass ex:SensorReading ;\n  sh:property [ sh:path ex:temperature ; sh:datatype xsd:decimal ; sh:minCount 1 ] ;\n  sh:property [ sh:path ex:recordedAt ; sh:datatype xsd:dateTime ] .\n',
  shaclOut: prefixes + 'ex:ConsumerShape a sh:NodeShape ;\n  sh:targetClass ex:Observation ;\n  sh:property [ sh:path ex:value ; sh:datatype xsd:decimal ; sh:minCount 1 ] ;\n  sh:property [ sh:path ex:time ; sh:datatype xsd:dateTime ] .\n',
};
const names = ['ontology', 'shaclIn', 'shaclOut'] as const;
const editors = Object.fromEntries(names.map(name => [name, editor(`${name}Text`, example[name])])) as Record<typeof names[number], any>;
const output = editor('queryText', '', true);
const status = document.getElementById('status')!;
const diagnostics = document.getElementById('diagnostics')!;
const copy = document.getElementById('copyButton') as HTMLButtonElement;
const download = document.getElementById('downloadButton') as HTMLButtonElement;
const baseIris: Partial<Record<typeof names[number], string>> = {};
const generations: Partial<Record<typeof names[number], number>> = {};
function editor(id: string, value: string, readOnly = false): any {
  const textarea = document.getElementById(id) as HTMLTextAreaElement;
  textarea.value = value;
  return CodeMirror.fromTextArea(textarea, { mode: readOnly ? 'application/sparql-query' : 'text/turtle',
    lineNumbers: true, lineWrapping: true, tabSize: 2, readOnly });
}
function invalidate(): void {
  output.setValue('');
  copy.disabled = download.disabled = true;
  diagnostics.textContent = '';
  status.textContent = 'Inputs changed. Generate a query to use the current contents.';
}
for (const name of names) {
  editors[name].on('change', invalidate);
  const input = document.getElementById(`${name}Url`) as HTMLInputElement;
  const button = document.getElementById(`${name}Load`) as HTMLButtonElement;
  const loadStatus = document.getElementById(`${name}Status`)!;
  const load = async () => {
    if (!input.value.trim() || !input.reportValidity()) {
      loadStatus.textContent = 'Enter a valid document URL.';
      return;
    }
    const generation = (generations[name] ?? 0) + 1;
    generations[name] = generation;
    button.disabled = true;
    loadStatus.textContent = 'Loading…';
    const oldContents = editors[name].getValue();
    try {
      const url = new URL(input.value.trim(), document.baseURI);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
      // ldfetch negotiates RDF formats and extracts RDF from pages, then shows editable Turtle.
      const result = await api.dereferenceRdfUrl(url.href);
      if (result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}`);
      const text = await api.writeQuads(result.quads, result.prefixes);
      if (generations[name] !== generation) return;
      if (editors[name].getValue() !== oldContents) {
        loadStatus.textContent = 'Contents were edited while loading. Press Load again to replace them.';
        return;
      }
      baseIris[name] = result.url;
      editors[name].setValue(text);
      loadStatus.textContent = `Loaded ${result.quads.length} triples from ${result.url}.`;
    } catch (error) {
      if (generations[name] === generation) loadStatus.textContent = `Could not load URL: ${error instanceof Error ? error.message : String(error)}. Check the URL and browser CORS access.`;
    } finally {
      if (generations[name] === generation) button.disabled = false;
    }
  };
  button.addEventListener('click', () => { void load(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (!button.disabled) void load(); } });
}
function generate(): void {
  invalidate();
  try {
    const inputs = Object.fromEntries(names.map(name => {
      try {
        if (!editors[name].getValue().trim()) throw new Error('Input is empty.');
        return [name, api.parseRdfOrMessages(editors[name].getValue(), { baseIRI: baseIris[name] ?? document.baseURI }).quads as Quad[]];
      } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    })) as { ontology: Quad[]; shaclIn: Quad[]; shaclOut: Quad[] };
    const result = generateSparqlConstruct(inputs);
    diagnostics.textContent = result.diagnostics.map(d => `${d.severity.toUpperCase()}: ${d.message}${d.path ? `\nPath: ${d.path}` : ''}${d.shape ? `\nShape: ${d.shape}` : ''}`).join('\n\n');
    if (result.query) {
      output.setValue(result.query);
      copy.disabled = download.disabled = false;
      status.textContent = `Generated query with ${result.mappings.length} property mappings.`;
    } else status.textContent = 'Could not generate a complete mapping. See the diagnostics below.';
  } catch (error) { status.textContent = `Could not generate query: ${error instanceof Error ? error.message : String(error)}`; }
}
document.getElementById('generateButton')!.addEventListener('click', generate);
document.getElementById('resetButton')!.addEventListener('click', () => {
  for (const name of names) {
    generations[name] = (generations[name] ?? 0) + 1;
    delete baseIris[name];
    (document.getElementById(`${name}Url`) as HTMLInputElement).value = '';
    (document.getElementById(`${name}Load`) as HTMLButtonElement).disabled = false;
    document.getElementById(`${name}Status`)!.textContent = '';
    editors[name].setValue(example[name]);
  }
  generate();
});
copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(output.getValue()); status.textContent = 'Query copied.'; }
  catch { status.textContent = 'Clipboard access is unavailable. Select and copy the query from the editor.'; }
});
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([output.getValue()], { type: 'application/sparql-query' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mapping.rq';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
generate();
