import { generateSparqlConstruct } from '../src/sparql-construct';
import { constructExamples } from './sparql-construct-examples';
import { createRdfUrlLoader } from './rdf-url-loader';
import type { ConstructWorkerMessage, ConstructWorkerRequest } from './sparql-construct-worker';
import type { Quad } from '@rdfjs/types';

declare const CodeMirror: any;
const api = (globalThis as any).RdfjsInferenceEngine;
const names = ['ontology', 'shaclIn', 'shaclOut'] as const;
const get = (id: string) => document.getElementById(id)!;
const button = (id: string) => get(id) as HTMLButtonElement;
const exampleSelect = get('exampleSelect') as HTMLSelectElement;
const initialExample = constructExamples[0];
const editors = Object.fromEntries(names.map(name => [name, editor(`${name}Text`, initialExample[name])])) as Record<typeof names[number], any>;
const output = editor('queryText', '', true, 'application/sparql-query');
const dataEditor = editor('dataText', initialExample.data);
const resultEditor = editor('resultText', '', true);
const expectedEditor = editor('expectedText', initialExample.expected, true);
const status = get('status');
const diagnostics = get('diagnostics');
const copy = button('copyButton');
const download = button('downloadButton');
const executionPanel = get('executionPanel');
const executionStatus = get('executionStatus');
const run = button('runQueryButton');
const stop = button('stopQueryButton');
let activeWorker: Worker | null = null;
let pendingLoads = 0;

function editor(id: string, value: string, readOnly = false, mode = 'text/turtle'): any {
  const textarea = get(id) as HTMLTextAreaElement;
  textarea.value = value;
  return CodeMirror.fromTextArea(textarea, { mode, lineNumbers: true, lineWrapping: true, tabSize: 2, readOnly });
}
function updateRunControls(): void {
  run.disabled = !output.getValue() || Boolean(activeWorker) || pendingLoads > 0;
  stop.hidden = !activeWorker;
}
function stopExecution(message = 'Stopped.'): void {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
    executionStatus.textContent = message;
  }
  updateRunControls();
}
function invalidateExecution(): void {
  stopExecution('Input changed. Run the query again.');
  resultEditor.setValue('');
  executionStatus.textContent = 'Ready. Load or edit input data, then execute the generated query.';
}
function invalidate(): void {
  stopExecution('Mapping inputs changed. Generate a query again.');
  output.setValue('');
  resultEditor.setValue('');
  executionPanel.hidden = true;
  copy.disabled = download.disabled = true;
  diagnostics.textContent = '';
  status.textContent = 'Inputs changed. Generate a query to use the current contents.';
  updateRunControls();
}
const urlLoaders = Object.fromEntries([...names, 'data' as const].map(name => [name, createRdfUrlLoader({
  input: get(`${name}Url`) as HTMLInputElement,
  button: button(`${name}Load`),
  status: get(name === 'data' ? 'dataLoadStatus' : `${name}Status`),
  editor: name === 'data' ? dataEditor : editors[name],
  api,
  onPendingChange: pending => { pendingLoads += pending ? 1 : -1; updateRunControls(); },
})]));
for (const name of names) editors[name].on('change', invalidate);
dataEditor.on('change', invalidateExecution);

for (const example of constructExamples) {
  const option = document.createElement('option');
  option.value = example.id;
  option.textContent = example.label;
  exampleSelect.appendChild(option);
}
exampleSelect.value = initialExample.id;
function loadExample(): void {
  const example = constructExamples.find(example => example.id === exampleSelect.value) ?? initialExample;
  for (const loader of Object.values(urlLoaders)) loader.reset();
  for (const name of names) editors[name].setValue(example[name]);
  dataEditor.setValue(example.data);
  expectedEditor.setValue(example.expected);
  get('exampleDescription').textContent = example.description;
  get('ndeGuidance').hidden = example.id !== 'nde-amsterdam-photograph';
  generate();
}
function generate(): void {
  invalidate();
  try {
    const inputs = Object.fromEntries(names.map(name => {
      try {
        if (!editors[name].getValue().trim()) throw new Error('Input is empty.');
        return [name, api.parseRdfOrMessages(editors[name].getValue(), { baseIRI: document.baseURI }).quads as Quad[]];
      } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    })) as { ontology: Quad[]; shaclIn: Quad[]; shaclOut: Quad[] };
    const result = generateSparqlConstruct(inputs);
    diagnostics.textContent = result.diagnostics.map(d => `${d.severity.toUpperCase()}: ${d.message}${d.path ? `\nPath: ${d.path}` : ''}${d.shape ? `\nShape: ${d.shape}` : ''}`).join('\n\n');
    if (result.query) {
      output.setValue(result.query);
      copy.disabled = download.disabled = false;
      status.textContent = `Generated query with ${result.mappings.length} property mappings.`;
      executionPanel.hidden = false;
      invalidateExecution();
      setTimeout(() => { dataEditor.refresh(); resultEditor.refresh(); }, 0);
    } else status.textContent = 'Could not generate a complete mapping. See the diagnostics below.';
  } catch (error) { status.textContent = `Could not generate query: ${error instanceof Error ? error.message : String(error)}`; }
  updateRunControls();
}
function executeQuery(): void {
  if (run.disabled) return;
  if (!dataEditor.getValue().trim()) {
    executionStatus.textContent = 'Enter RDF input or load a document URL.';
    return;
  }
  resultEditor.setValue('');
  executionStatus.textContent = 'Starting Comunica…';
  try {
    const worker = new Worker(new URL('browser/sparql-construct-worker.min.js', document.baseURI));
    activeWorker = worker;
    updateRunControls();
    worker.onmessage = ({ data: message }: MessageEvent<ConstructWorkerMessage>) => {
      if (activeWorker !== worker) return;
      if (message.type === 'status') { executionStatus.textContent = message.message; return; }
      if (message.type === 'result') {
        resultEditor.setValue(message.output);
        executionStatus.textContent = `Finished: ${message.processedMessages} ${message.processedMessages === 1 ? 'message' : 'messages'}, ${message.outputQuads} output triples in ${(message.elapsedMs / 1000).toFixed(2)} s.`;
      } else executionStatus.textContent = `Could not execute query: ${message.message}`;
      worker.terminate();
      activeWorker = null;
      updateRunControls();
    };
    worker.onerror = event => {
      if (activeWorker !== worker) return;
      stopExecution(`Could not execute query: ${event.message || 'Comunica worker could not start.'}`);
    };
    const request: ConstructWorkerRequest = {
      apiScriptUrl: new URL('browser/rdfjs-inference-engine.min.js', document.baseURI).href,
      query: output.getValue(), dataSource: dataEditor.getValue(), baseIRI: document.baseURI,
    };
    worker.postMessage(request);
  } catch (error) {
    stopExecution();
    executionStatus.textContent = `Could not execute query: ${error instanceof Error ? error.message : String(error)}`;
  }
}
get('generateButton').addEventListener('click', generate);
get('resetButton').addEventListener('click', loadExample);
exampleSelect.addEventListener('change', loadExample);
run.addEventListener('click', executeQuery);
stop.addEventListener('click', () => stopExecution());
get('expectedPanel').addEventListener('toggle', () => { setTimeout(() => expectedEditor.refresh(), 0); });
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
loadExample();
