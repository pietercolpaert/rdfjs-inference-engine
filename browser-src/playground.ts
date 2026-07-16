import { bundledRuleFiles, bundledRuleProfiles } from 'bundled-rules';
import { bundledExamples } from 'bundled-examples';

declare const CodeMirror: any;

type InputMode = 'text' | 'url';

type Editor = {
  getValue(): string;
  setValue(value: string): void;
  replaceRange?(replacement: string, from: { line: number; ch: number }): void;
  lastLine?(): number;
  getLine?(line: number): string;
  refresh(): void;
  on(event: string, listener: () => void): void;
  setOption?(option: string, value: unknown): void;
};

type PlaygroundState = {
  example?: string;
  backgroundMode?: InputMode;
  dataMode?: InputMode;
  statefulMaterialization?: boolean;
  disabledRuleFiles?: string[];
  backgroundUrl?: string;
  dataUrl?: string;
  backgroundText?: string;
  dataText?: string;
  shaclInText?: string;
  shaclOutText?: string;
};

type BundledRuleProfile = {
  file: string;
  n3: string;
  precompiledRuntime?: string;
};

type BundledExample = {
  id: string;
  label: string;
  backgroundFile: string;
  dataFile: string;
  background: string;
  data: string;
  shaclInFile?: string;
  shaclOutFile?: string;
  shaclIn?: string;
  shaclOut?: string;
};

type ActiveRun = {
  controller: AbortController;
  worker?: Worker;
  startedAt: number;
  finishedAt?: number;
  elapsedTimer?: number;
  runtimeMessage?: string;
  statusMessage?: string;
  averageMessageProcessingMs?: number;
};

type WorkerMetrics = {
  processedMessageCount: number;
  messageProcessingMs: number;
  averageMessageProcessingMs: number;
};

type WorkerRequest = {
  apiScriptUrl: string;
  bundledRules: string;
  bundledRuleProfiles: BundledRuleProfile[];
  bundledRuleCount: number;
  bundledRuleLabels: string[];
  backgroundSource: string;
  dataMode: InputMode;
  statefulMaterialization: boolean;
  selectRuntimeRules?: boolean;
  statefulStoreName?: string;
  shaclInSource?: string;
  shaclOutSource?: string;
  dataSource?: string;
  dataUrl?: string;
};

type WorkerMessage =
  | { type: 'status'; message: string }
  | { type: 'runtime'; message: string; runtime?: string }
  | { type: 'append'; chunk: string }
  | { type: 'result'; output?: string; status: string; metrics?: WorkerMetrics }
  | { type: 'error'; message: string };

const defaultState = {
  backgroundMode: 'text' as InputMode,
  dataMode: 'text' as InputMode,
  backgroundText: defaultExample().background,
  dataText: defaultExample().data,
};

const editors = {
  backgroundText: createEditor('backgroundText', defaultState.backgroundText),
  dataText: createEditor('dataText', defaultState.dataText),
  shaclInText: createEditor('shaclInText', defaultExample().shaclIn ?? ''),
  shaclOutText: createEditor('shaclOutText', defaultExample().shaclOut ?? ''),
  outputText: createEditor('outputText', '', { readOnly: true }),
};

const generatedRuntimeEditor = createEditor('generatedRuntimeText', '', { readOnly: true });

const controls = {
  exampleSelect: getSelect('exampleSelect'),
  backgroundMode: getSelect('backgroundMode'),
  dataMode: getSelect('dataMode'),
  statefulMaterialization: getInput('statefulMaterialization'),
  backgroundUrl: getInput('backgroundUrl'),
  dataUrl: getInput('dataUrl'),
  backgroundUrlPanel: getElement('backgroundUrlPanel'),
  backgroundTextPanel: getElement('backgroundTextPanel'),
  dataUrlPanel: getElement('dataUrlPanel'),
  dataTextPanel: getElement('dataTextPanel'),
  generatedRuntimePanel: getElement('generatedRuntimePanel') as HTMLDetailsElement,
  runButton: getButton('runButton'),
  stopButton: getButton('stopButton'),
  resetButton: getButton('resetButton'),
  shareButton: getButton('shareButton'),
  status: getElement('status'),
  runtimeStats: getElement('runtimeStats'),
  rulesSummary: getOptionalElement('rulesSummary'),
  ruleProfileList: getOptionalElement('ruleProfileList'),
};

let suppressStateUpdate = false;
let stateUpdateTimer = 0;
let activeRun: ActiveRun | null = null;
let outputAppendBuffer = '';
let outputAppendTimer = 0;

populateExamples();
populateRuleProfiles();
loadStateFromHash();
applyModeVisibility();
wireControls();
scheduleStateUpdate();
setRunning(false);
setStatus('Ready. Choose an example, URL, or text input, then run inference.');

function createEditor(id: string, value: string, options: Record<string, unknown> = {}): Editor {
  const textarea = document.getElementById(id) as HTMLTextAreaElement | null;
  if (!textarea) {
    throw new Error(`Missing textarea #${id}`);
  }
  textarea.value = value;
  return CodeMirror.fromTextArea(textarea, {
    mode: 'text/turtle',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    viewportMargin: Infinity,
    ...options,
  });
}

function hideGeneratedRuntime(): void {
  generatedRuntimeEditor.setValue('');
  controls.generatedRuntimePanel.open = false;
  controls.generatedRuntimePanel.hidden = true;
}

function showGeneratedRuntime(runtime: string): void {
  generatedRuntimeEditor.setValue(runtime);
  controls.generatedRuntimePanel.hidden = false;
  window.setTimeout(() => generatedRuntimeEditor.refresh(), 0);
}

function wireControls(): void {
  controls.runButton.addEventListener('click', () => void runInference());
  controls.stopButton.addEventListener('click', stopActiveRun);
  controls.resetButton.addEventListener('click', resetDefaults);
  controls.exampleSelect.addEventListener('change', () => loadBundledExample(controls.exampleSelect.value));
  controls.shareButton.addEventListener('click', () => {
    updateHashNow();
    void navigator.clipboard?.writeText(window.location.href);
    setStatus('Shareable URL copied when clipboard access is available.');
  });

  for (const select of [controls.backgroundMode, controls.dataMode]) {
    select.addEventListener('change', () => {
      applyModeVisibility();
      scheduleStateUpdate();
    });
  }
  for (const editor of Object.values(editors)) {
    editor.on('change', scheduleStateUpdate);
  }
  controls.generatedRuntimePanel.addEventListener('toggle', () => {
    window.setTimeout(() => generatedRuntimeEditor.refresh(), 0);
  });
  for (const input of [controls.backgroundUrl, controls.dataUrl]) {
    input.addEventListener('input', scheduleStateUpdate);
  }
  controls.statefulMaterialization.addEventListener('change', scheduleStateUpdate);
}

async function runInference(): Promise<void> {
  if (activeRun) {
    return;
  }

  const run: ActiveRun = { controller: new AbortController(), startedAt: performance.now() };
  activeRun = run;

  try {
    setRunning(true);
    controls.runtimeStats.textContent = '';
    controls.runtimeStats.hidden = true;
    hideGeneratedRuntime();
    clearOutputAppendBuffer();
    startElapsedCounter(run);
    editors.outputText.setValue('');
    setRunStatus(run, 'Preparing inference…');

    const backgroundSource = await getSource('background', run.controller.signal);
    throwIfAborted(run.controller.signal);
    const dataMode = getMode('data');
    const dataSource = dataMode === 'text' ? editors.dataText.getValue() : undefined;
    const dataUrl = dataMode === 'url' ? controls.dataUrl.value.trim() : undefined;
    const shaclInSource = editors.shaclInText.getValue().trim() || undefined;
    const shaclOutSource = editors.shaclOutText.getValue().trim() || undefined;
    if (dataMode === 'url' && !dataUrl) {
      throw new Error('Enter a data URL or switch to text input.');
    }

    const selectedProfiles = selectedRuleProfiles();
    if (selectedProfiles.length === 0) {
      throw new Error('Select at least one bundled N3 rule file in the advanced rule profile selection.');
    }

    await runWorkerInference(run, {
      apiScriptUrl: new URL('browser/rdfjs-inference-engine.min.js', window.location.href).href,
      bundledRules: selectedProfiles.map((profile) => profile.n3).join('\n\n'),
      bundledRuleProfiles: selectedProfiles,
      bundledRuleCount: selectedProfiles.length,
      bundledRuleLabels: selectedProfiles.map((profile) => profile.file),
      backgroundSource,
      dataMode,
      statefulMaterialization: controls.statefulMaterialization.checked,
      // This fixture exercises OWL list and restriction rules that the selector cannot yet
      // reduce soundly. Its SHACL contracts still prune input and project output.
      selectRuntimeRules: controls.exampleSelect.value === 'shipment-logistics' ? false : undefined,
      statefulStoreName: controls.statefulMaterialization.checked
        ? createStatefulStoreName(backgroundSource, dataMode === 'url' ? dataUrl ?? '' : dataSource ?? '')
        : undefined,
      shaclInSource,
      shaclOutSource,
      dataSource,
      dataUrl,
    });
  } catch (error) {
    if (isAbortError(error)) {
      flushOutputAppendBuffer();
      run.statusMessage = 'Stopped. No more messages or quads will be processed.';
    } else {
      const message = error instanceof Error ? error.message : String(error);
      clearOutputAppendBuffer();
      run.statusMessage = `Error: ${message}`;
      editors.outputText.setValue(message);
    }
    finishElapsedCounter(run);
  } finally {
    finishElapsedCounter(run);
    if (activeRun === run) {
      activeRun = null;
    }
    run.worker?.terminate();
    setRunning(false);
  }
}

function runWorkerInference(run: ActiveRun, request: WorkerRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const worker = createInferenceWorker();
    run.worker = worker;

    const abort = () => {
      worker.terminate();
      reject(new DOMException('Inference was stopped.', 'AbortError'));
    };

    run.controller.signal.addEventListener('abort', abort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'status') {
        setRunStatus(run, message.message);
      } else if (message.type === 'runtime') {
        run.runtimeMessage = message.message;
        controls.runtimeStats.textContent = message.message;
        controls.runtimeStats.hidden = false;
        if (message.runtime !== undefined) {
          showGeneratedRuntime(message.runtime);
        }
        updateElapsedCounter(run);
      } else if (message.type === 'append') {
        appendOutput(message.chunk);
      } else if (message.type === 'result') {
        run.statusMessage = message.status;
        run.averageMessageProcessingMs = message.metrics?.averageMessageProcessingMs;
        if (message.output !== undefined) {
          clearOutputAppendBuffer();
          editors.outputText.setValue(message.output);
        } else {
          flushOutputAppendBuffer();
        }
        finishElapsedCounter(run);
        resolve();
      } else if (message.type === 'error') {
        reject(new Error(message.message));
      }
    };

    worker.onerror = (event) => {
      reject(new Error(event.message));
    };

    worker.postMessage(request);
  });
}

function createStatefulStoreName(backgroundSource: string, dataKey: string): string {
  const projectKey = [window.location.origin, window.location.pathname, backgroundSource, dataKey].join('\0');
  return `rdfjs-inference-engine:playground:${stableHash(projectKey)}`;
}

function stableHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function createInferenceWorker(): Worker {
  const source = `
self.onmessage = async (event) => {
  const request = event.data;
  try {
    self.currentWorkerRequest = request;
    importScripts(request.apiScriptUrl);
    const api = self.RdfjsInferenceEngine;
    if (!api) {
      throw new Error('Could not load the browser inference engine bundle.');
    }

    self.postMessage({ type: 'status', message: 'Parsing background knowledge…' });
    const background = api.parseRdfOrMessages(request.backgroundSource);
    self.postMessage({ type: 'status', message: 'Parsed ' + background.quads.length + ' background quad(s). Compiling runtime…' });

    const reasoner = new api.InferenceEngine();
    const started = performance.now();
    const loadOptions = {};
    if (request.selectRuntimeRules === false) {
      loadOptions.selectRuntimeRules = false;
    }
    if (request.statefulMaterialization) {
      loadOptions.skolemKey = request.statefulStoreName || 'rdfjs-inference-engine:playground:default';
    }
    if (request.shaclInSource) {
      loadOptions.shaclIn = request.shaclInSource;
    }
    if (request.shaclOutSource) {
      loadOptions.shaclOut = request.shaclOutSource;
    }
    const ruleLabel = request.bundledRuleLabels && request.bundledRuleLabels.length
      ? 'Bundled profiles: ' + request.bundledRuleLabels.join(', ')
      : 'Bundled N3 rule profiles';
    const ruleProfiles = request.bundledRuleProfiles && request.bundledRuleProfiles.length
      ? request.bundledRuleProfiles.map((profile) => ({ n3: profile.n3, label: profile.file, precompiledRuntime: profile.precompiledRuntime }))
      : [{ n3: request.bundledRules, label: ruleLabel }];
    const runtime = reasoner.load(ruleProfiles, background.quads, Object.keys(loadOptions).length ? loadOptions : undefined);
    const compiledAt = performance.now();
    const shapeHintSummary = (request.shaclInSource || request.shaclOutSource) ? ' · SHACL hints ' + [request.shaclInSource ? 'in' : '', request.shaclOutSource ? 'out' : ''].filter(Boolean).join('/') : '';
    self.postMessage({ type: 'runtime', message: 'Background ' + countLabel(background.quads.length, 'quad') + ' · Rule profiles ' + request.bundledRuleCount + shapeHintSummary + ' · Runtime ' + (runtime.length / 1024).toFixed(1) + ' KiB', runtime });

    await processInputData(api, reasoner, request, compiledAt, started);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    self.currentWorkerRequest = null;
  }
};

async function processInputData(api, reasoner, request, compiledAt, started) {
  if (request.dataMode === 'url') {
    await processUrlInput(api, reasoner, request.dataUrl, compiledAt, started);
    return;
  }

  await processTextInput(api, reasoner, request.dataSource || '', compiledAt, started);
}

async function processTextInput(api, reasoner, source, compiledAt, started) {
  self.postMessage({ type: 'status', message: 'Parsing text input…' });
  const state = createStreamingState(api, reasoner, compiledAt, started, 'text input', requestStatefulMaterialization(), requestStatefulStoreName());
  await handleParsedItems(state, state.parser.write(source));
  await handleParsedItems(state, state.parser.end());
  await finishStreamingState(state);
}

async function processUrlInput(api, reasoner, url, compiledAt, started) {
  if (!url) {
    throw new Error('Missing data URL.');
  }

  self.postMessage({ type: 'status', message: 'Fetching input data stream…' });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not fetch ' + url + ': ' + response.status + ' ' + response.statusText);
  }
  if (!response.body) {
    const source = await response.text();
    await processTextInput(api, reasoner, source, compiledAt, started);
    return;
  }

  const state = createStreamingState(api, reasoner, compiledAt, started, url, requestStatefulMaterialization(), requestStatefulStoreName());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;

  for (;;) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    bytes += read.value.byteLength;
    const text = decoder.decode(read.value, { stream: true });
    await handleParsedItems(state, state.parser.write(text));
    postProgressStatus(state, progressMessage(state, 'Streaming input: read ' + Math.round(bytes / 1024) + ' KiB'));
  }

  const tail = decoder.decode();
  if (tail) {
    await handleParsedItems(state, state.parser.write(tail));
  }
  await handleParsedItems(state, state.parser.end());
  await finishStreamingState(state);
}

function requestStatefulMaterialization() {
  return Boolean(self.currentWorkerRequest && self.currentWorkerRequest.statefulMaterialization);
}

function requestStatefulStoreName() {
  return self.currentWorkerRequest && self.currentWorkerRequest.statefulStoreName
    ? String(self.currentWorkerRequest.statefulStoreName)
    : 'rdfjs-inference-engine:playground:default';
}

function createStreamingState(api, reasoner, compiledAt, started, sourceLabel, statefulMaterialization, statefulStoreName) {
  const state = {
    api,
    reasoner,
    parser: null,
    sourceLabel,
    compiledAt,
    started,
    statefulMaterialization,
    statefulStoreName,
    outputPrefixes: outputPrefixes(),
    messagesMode: false,
    ordinaryQuads: [],
    currentMessage: [],
    currentMessageCounter: 0,
    parsedQuadCount: 0,
    processedMessageCount: 0,
    messageProcessingMs: 0,
    inferredCount: 0,
    inconsistencyComments: [],
    lastStatusAt: 0,
    writer: null,
  };
  state.parser = new api.IncrementalParser({ factory: api.DataFactory }, {
    prefix: (prefix, iri) => addInputPrefix(state, prefix, iri),
  });
  return state;
}

function addInputPrefix(state, prefix, iri) {
  if (!prefix && prefix !== '') {
    return;
  }
  const value = typeof iri === 'string' ? iri : iri && iri.value;
  if (!value) {
    return;
  }
  state.outputPrefixes[prefix] = value;
  if (state.writer && typeof state.writer.addPrefix === 'function') {
    state.writer.addPrefix(prefix, value);
  }
}

function outputPrefixes() {
  return {
    transit: 'https://example.org/transit#',
    logistics: 'https://example.org/logistics#',
    subjects: 'https://example.org/subjects#',
    catalog: 'https://example.org/catalog#',
    family: 'https://example.org/family#',
    test: 'https://example.org/test#',
    inconsistencies: 'https://www.pieter.pm/rdfjs-inference-engine/ns/inconsistencies#',
    qcr: 'https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#',
    shacl: 'https://example.org/shacl#',
    gen: 'https://eyereasoner.github.io/.well-known/genid/',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    sh: 'http://www.w3.org/ns/shacl#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
  };
}

async function handleParsedItems(state, items) {
  for (const item of items) {
    if (state.api.isMessageQuad(item)) {
      state.messagesMode = true;
      while (state.currentMessageCounter < item.messageCounter) {
        await processCurrentMessage(state);
        state.currentMessageCounter += 1;
        state.currentMessage = [];
      }
      state.currentMessage.push(item.quad);
      state.parsedQuadCount += 1;
    } else if (state.messagesMode) {
      throw new Error('Cannot mix RDF Messages and ordinary RDF parser output in one input stream.');
    } else {
      state.ordinaryQuads.push(item);
      state.parsedQuadCount += 1;
    }
  }
}

async function finishStreamingState(state) {
  if (state.messagesMode) {
    await processCurrentMessage(state);
    if (state.writer) {
      await endWriter(state.writer);
    }
    appendInconsistencyComments(state.inconsistencyComments);
    self.postMessage({
      type: 'result',
      status: 'Done · RDF Messages: ' + state.processedMessageCount + ' message(s), ' + state.parsedQuadCount + ' quad(s), ' + state.inferredCount + ' inferred' + diagnosticStatusSuffix(state.inconsistencyComments) + statefulStoreSummary(state),
      metrics: messageTimingMetrics(state),
    });
    return;
  }

  const total = state.ordinaryQuads.length;
  self.postMessage({ type: 'status', message: 'Parsed ' + total + ' input quad(s). Running inference…' });
  const inference = state.reasoner.inferWithDiagnostics(state.ordinaryQuads);
  const comments = formatInconsistencyComments(inference.inconsistencies);
  self.postMessage({ type: 'status', message: 'Processed ' + total + ' input quad(s). Serializing ' + inference.quads.length + ' inferred quad(s)…' });
  const output = await state.api.writeQuads(inference.quads, state.outputPrefixes);
  self.postMessage({ type: 'result', output: comments + output, status: 'Done · RDF input: ' + total + ' quad(s), ' + inference.quads.length + ' inferred' + diagnosticStatusSuffix(comments) });
}

async function processCurrentMessage(state) {
  if (!state.writer) {
    state.writer = createMessageWriter(state.api, state.outputPrefixes);
  }
  const messageNumber = state.currentMessageCounter + 1;
  postProgressStatus(state, 'Processing message ' + messageNumber + ' after parsing ' + state.parsedQuadCount + ' quad(s)…', state.processedMessageCount === 0);
  const messageStartedAt = performance.now();
  const inference = state.statefulMaterialization
    ? await state.reasoner.inferAsyncWithDiagnostics(state.currentMessage, {
        store: {
          name: state.statefulStoreName,
          clear: state.processedMessageCount === 0,
        },
      })
    : state.reasoner.inferWithDiagnostics(state.currentMessage);
  state.messageProcessingMs += performance.now() - messageStartedAt;
  state.inconsistencyComments.push(formatInconsistencyComments(inference.inconsistencies, 'message ' + messageNumber));
  state.writer.addMessage(inference.quads);
  state.inferredCount += inference.quads.length;
  state.processedMessageCount += 1;
  postProgressStatus(state, 'Processed message ' + messageNumber + '; ' + state.processedMessageCount + ' message(s), ' + state.parsedQuadCount + ' input quad(s), ' + state.inferredCount + ' inferred' + statefulStoreSummary(state) + '…');
}

function messageTimingMetrics(state) {
  if (state.processedMessageCount === 0) {
    return undefined;
  }
  return {
    processedMessageCount: state.processedMessageCount,
    messageProcessingMs: state.messageProcessingMs,
    averageMessageProcessingMs: state.messageProcessingMs / state.processedMessageCount,
  };
}

function statefulStoreSummary(state) {
  return state.statefulMaterialization ? ', stateful store enabled' : '';
}

function countLabel(count, singular) {
  return count + ' ' + singular + (count === 1 ? '' : 's');
}

function postProgressStatus(state, message, force = false) {
  const now = performance.now();
  if (!force && now - state.lastStatusAt < 500) {
    return;
  }
  state.lastStatusAt = now;
  self.postMessage({ type: 'status', message });
}

function formatWorkerDuration(ms) {
  if (ms < 1000) {
    return ms.toFixed(0) + ' ms';
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return seconds.toFixed(1) + ' s';
  }
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60).toString().padStart(2, '0');
  return minutes + ' min ' + wholeSeconds + ' s';
}

function createMessageWriter(api, prefixes) {
  return new api.Writer({
    write(chunk, _encoding, callback) {
      self.postMessage({ type: 'append', chunk });
      callback?.(null);
    },
    end(callback) {
      callback?.(null, '');
    },
  }, { prefixes, rdfMessages: true });
}

function endWriter(writer) {
  return new Promise((resolve, reject) => {
    writer.end((error) => error ? reject(error) : resolve());
  });
}

function appendInconsistencyComments(comments) {
  const text = comments.filter(Boolean).join('');
  if (text) {
    self.postMessage({ type: 'append', chunk: text });
  }
}

function diagnosticStatusSuffix(comments) {
  const text = Array.isArray(comments) ? comments.join('') : comments;
  const count = (text.match(/^# Inconsistency detected/gm) || []).length;
  return count > 0 ? ', found ' + count + ' inconsistency diagnostic(s)' : '';
}

const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_SAME_AS_IRI = 'http://www.w3.org/2002/07/owl#sameAs';
const OWL_DIFFERENT_FROM_IRI = 'http://www.w3.org/2002/07/owl#differentFrom';
const OWL_ALL_DIFFERENT_IRI = 'http://www.w3.org/2002/07/owl#AllDifferent';
const OWL_ALL_DISJOINT_CLASSES_IRI = 'http://www.w3.org/2002/07/owl#AllDisjointClasses';
const OWL_ALL_DISJOINT_PROPERTIES_IRI = 'http://www.w3.org/2002/07/owl#AllDisjointProperties';
const OWL_IRREFLEXIVE_PROPERTY_IRI = 'http://www.w3.org/2002/07/owl#IrreflexiveProperty';
const OWL_ASYMMETRIC_PROPERTY_IRI = 'http://www.w3.org/2002/07/owl#AsymmetricProperty';
const OWL_PROPERTY_DISJOINT_WITH_IRI = 'http://www.w3.org/2002/07/owl#propertyDisjointWith';
const OWL_SOURCE_INDIVIDUAL_IRI = 'http://www.w3.org/2002/07/owl#sourceIndividual';
const OWL_ASSERTION_PROPERTY_IRI = 'http://www.w3.org/2002/07/owl#assertionProperty';
const OWL_TARGET_INDIVIDUAL_IRI = 'http://www.w3.org/2002/07/owl#targetIndividual';
const OWL_TARGET_VALUE_IRI = 'http://www.w3.org/2002/07/owl#targetValue';
const OWL_NOTHING_IRI = 'http://www.w3.org/2002/07/owl#Nothing';
const OWL_THING_IRI = 'http://www.w3.org/2002/07/owl#Thing';
const OWL_COMPLEMENT_OF_IRI = 'http://www.w3.org/2002/07/owl#complementOf';
const OWL_MAX_CARDINALITY_IRI = 'http://www.w3.org/2002/07/owl#maxCardinality';
const OWL_MAX_QUALIFIED_CARDINALITY_IRI = 'http://www.w3.org/2002/07/owl#maxQualifiedCardinality';
const OWL_ON_PROPERTY_IRI = 'http://www.w3.org/2002/07/owl#onProperty';
const OWL_ON_CLASS_IRI = 'http://www.w3.org/2002/07/owl#onClass';
const OWL_ON_DATA_RANGE_IRI = 'http://www.w3.org/2002/07/owl#onDataRange';
const XSD_STRING_IRI = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_NON_NEGATIVE_INTEGER_IRI = 'http://www.w3.org/2001/XMLSchema#nonNegativeInteger';
const GENERATED_SKOLEM_IRI_PREFIX = 'https://eyereasoner.github.io/.well-known/genid/';

function formatInconsistencyComments(reports, context) {
  if (!reports || reports.length === 0) {
    return '';
  }
  const prefix = context ? ' in ' + context : '';
  const visible = reports.slice(0, 20);
  const lines = [];
  visible.forEach((report, index) => {
    const rule = report.rule ? shortIri(report.rule) : 'unknown rule';
    const description = describeInconsistencyRule(rule);
    lines.push('# Inconsistency detected' + prefix + ': ' + summarizeInconsistency(report, rule, description));
    lines.push('#   Rule: ' + rule + (description ? ' — ' + description : ''));
    const evidence = externalEvidenceForReport(report, rule);
    if (evidence.length > 0) {
      lines.push('#   Why this fails (public evidence):');
      evidence.forEach((item, itemIndex) => lines.push('#     ' + (itemIndex + 1) + '. ' + item));
    } else {
      const publicTerms = publicDiagnosticTerms(report.terms || []);
      if (publicTerms.length > 0) {
        lines.push('#   Public terms: ' + publicTerms.map(termToComment).join(', '));
      }
      lines.push('#   Why this fails: no public triple-only explanation is available for this rule.');
    }
    if (hasHiddenDiagnosticTerms(report.terms || [])) {
      lines.push('#   Internal OWL helper terms were hidden from this explanation.');
    }
    if (index < visible.length - 1) {
      lines.push('#');
    }
  });
  if (reports.length > visible.length) {
    lines.push('# ... ' + (reports.length - visible.length) + ' more inconsistency diagnostic(s) omitted.');
  }
  return lines.map(commentLine).join('\\n') + '\\n\\n';
}

function summarizeInconsistency(report, rule, fallbackDescription) {
  const terms = report.terms || [];
  if (rule === 'eq-diff1') {
    return safeTermLabel(terms[0]) + ' is asserted as both owl:sameAs and owl:differentFrom ' + safeTermLabel(terms[1]) + '.';
  }
  if (rule === 'eq-diff2' || rule === 'eq-diff3') {
    return safeTermLabel(terms[1]) + ' and ' + safeTermLabel(terms[2]) + ' are listed as different but are also owl:sameAs.';
  }
  if (rule === 'prp-irp') {
    return safeTermLabel(terms[1]) + ' uses irreflexive property ' + safeTermLabel(terms[0]) + ' on itself.';
  }
  if (rule === 'prp-asyp') {
    return safeTermLabel(terms[0]) + ' is asymmetric, but it relates ' + safeTermLabel(terms[1]) + ' to ' + safeTermLabel(terms[2]) + ' in both directions.';
  }
  if (rule === 'prp-pdw') {
    return safeTermLabel(terms[0]) + ' and ' + safeTermLabel(terms[1]) + ' are disjoint properties used for the same subject/object pair.';
  }
  if (rule === 'prp-adp') {
    return safeTermLabel(terms[1]) + ' and ' + safeTermLabel(terms[2]) + ' are all-disjoint properties used for the same subject/object pair.';
  }
  if (rule === 'prp-npa1' || rule === 'prp-npa2') {
    return 'a negative property assertion is contradicted by an actual property value.';
  }
  if (rule === 'cls-nothing2') {
    return safeTermLabel(terms[0]) + ' is typed as owl:Nothing.';
  }
  if (rule === 'cls-com') {
    return safeTermLabel(terms[2]) + ' is typed as both a class and its complement.';
  }
  if (rule === 'cls-maxc1' || rule === 'cls-maxqc1' || rule === 'cls-maxqc2' || rule === 'cls-maxqd1') {
    return safeTermLabel(terms[1]) + ' has a value for ' + safeTermLabel(terms[2]) + ' although a maximum-cardinality 0 restriction applies.';
  }
  if (rule === 'cax-dw') {
    return safeTermLabel(terms[2]) + ' is typed as both disjoint classes ' + safeTermLabel(terms[0]) + ' and ' + safeTermLabel(terms[1]) + '.';
  }
  if (rule === 'cax-adc') {
    return safeTermLabel(terms[3]) + ' is typed as two classes from an owl:AllDisjointClasses axiom.';
  }
  if (rule === 'dt-not-type') {
    return safeTermLabel(terms[0]) + ' is not a valid value for datatype ' + safeTermLabel(terms[1]) + '.';
  }
  return fallbackDescription ? fallbackDescription + '.' : 'an OWL 2 RL contradiction was derived.';
}

function externalEvidenceForReport(report, rule) {
  const terms = report.terms || [];
  const evidence = [];
  if (rule === 'eq-diff1') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_SAME_AS_IRI), terms[1]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_DIFFERENT_FROM_IRI), terms[1]);
  } else if (rule === 'eq-diff2') {
    addEvidenceTriple(evidence, terms[0], namedTerm(RDF_TYPE_IRI), namedTerm(OWL_ALL_DIFFERENT_IRI));
    addEvidenceText(evidence, [terms[0], terms[1], terms[2]], 'The owl:members list of ' + termToComment(terms[0]) + ' contains ' + termToComment(terms[1]) + ' and ' + termToComment(terms[2]) + '.');
    addEvidenceTriple(evidence, terms[1], namedTerm(OWL_SAME_AS_IRI), terms[2]);
  } else if (rule === 'eq-diff3') {
    addEvidenceTriple(evidence, terms[0], namedTerm(RDF_TYPE_IRI), namedTerm(OWL_ALL_DIFFERENT_IRI));
    addEvidenceText(evidence, [terms[0], terms[1], terms[2]], 'The owl:distinctMembers list of ' + termToComment(terms[0]) + ' contains ' + termToComment(terms[1]) + ' and ' + termToComment(terms[2]) + '.');
    addEvidenceTriple(evidence, terms[1], namedTerm(OWL_SAME_AS_IRI), terms[2]);
  } else if (rule === 'prp-irp') {
    addEvidenceTriple(evidence, terms[0], namedTerm(RDF_TYPE_IRI), namedTerm(OWL_IRREFLEXIVE_PROPERTY_IRI));
    addEvidenceTriple(evidence, terms[1], terms[0], terms[1]);
  } else if (rule === 'prp-asyp') {
    addEvidenceTriple(evidence, terms[0], namedTerm(RDF_TYPE_IRI), namedTerm(OWL_ASYMMETRIC_PROPERTY_IRI));
    addEvidenceTriple(evidence, terms[1], terms[0], terms[2]);
    addEvidenceTriple(evidence, terms[2], terms[0], terms[1]);
  } else if (rule === 'prp-pdw') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_PROPERTY_DISJOINT_WITH_IRI), terms[1]);
    addEvidenceTriple(evidence, terms[2], terms[0], terms[3]);
    addEvidenceTriple(evidence, terms[2], terms[1], terms[3]);
  } else if (rule === 'prp-adp') {
    addEvidenceTriple(evidence, terms[0], namedTerm(RDF_TYPE_IRI), namedTerm(OWL_ALL_DISJOINT_PROPERTIES_IRI));
    addEvidenceText(evidence, [terms[0], terms[1], terms[2]], 'The owl:members list of ' + termToComment(terms[0]) + ' contains properties ' + termToComment(terms[1]) + ' and ' + termToComment(terms[2]) + '.');
    addEvidenceTriple(evidence, terms[3], terms[1], terms[4]);
    addEvidenceTriple(evidence, terms[3], terms[2], terms[4]);
  } else if (rule === 'prp-npa1') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_SOURCE_INDIVIDUAL_IRI), terms[1]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ASSERTION_PROPERTY_IRI), terms[2]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_TARGET_INDIVIDUAL_IRI), terms[3]);
    addEvidenceTriple(evidence, terms[1], terms[2], terms[3]);
  } else if (rule === 'prp-npa2') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_SOURCE_INDIVIDUAL_IRI), terms[1]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ASSERTION_PROPERTY_IRI), terms[2]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_TARGET_VALUE_IRI), terms[3]);
    addEvidenceTriple(evidence, terms[1], terms[2], terms[3]);
  } else if (rule === 'cls-nothing2') {
    addEvidenceTriple(evidence, terms[0], namedTerm(RDF_TYPE_IRI), namedTerm(OWL_NOTHING_IRI));
  } else if (rule === 'cls-com') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_COMPLEMENT_OF_IRI), terms[1]);
    addEvidenceTriple(evidence, terms[2], namedTerm(RDF_TYPE_IRI), terms[0]);
    addEvidenceTriple(evidence, terms[2], namedTerm(RDF_TYPE_IRI), terms[1]);
  } else if (rule === 'cls-maxc1') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_MAX_CARDINALITY_IRI), cardinalityZeroTerm());
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ON_PROPERTY_IRI), terms[2]);
    addEvidenceTriple(evidence, terms[1], namedTerm(RDF_TYPE_IRI), terms[0]);
    addEvidenceTriple(evidence, terms[1], terms[2], terms[3]);
  } else if (rule === 'cls-maxqc1') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_MAX_QUALIFIED_CARDINALITY_IRI), cardinalityZeroTerm());
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ON_PROPERTY_IRI), terms[2]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ON_CLASS_IRI), terms[4]);
    addEvidenceTriple(evidence, terms[1], namedTerm(RDF_TYPE_IRI), terms[0]);
    addEvidenceTriple(evidence, terms[1], terms[2], terms[3]);
    addEvidenceTriple(evidence, terms[3], namedTerm(RDF_TYPE_IRI), terms[4]);
  } else if (rule === 'cls-maxqc2') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_MAX_QUALIFIED_CARDINALITY_IRI), cardinalityZeroTerm());
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ON_PROPERTY_IRI), terms[2]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ON_CLASS_IRI), namedTerm(OWL_THING_IRI));
    addEvidenceTriple(evidence, terms[1], namedTerm(RDF_TYPE_IRI), terms[0]);
    addEvidenceTriple(evidence, terms[1], terms[2], terms[3]);
  } else if (rule === 'cls-maxqd1') {
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_MAX_QUALIFIED_CARDINALITY_IRI), cardinalityZeroTerm());
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ON_PROPERTY_IRI), terms[2]);
    addEvidenceTriple(evidence, terms[0], namedTerm(OWL_ON_DATA_RANGE_IRI), terms[4]);
    addEvidenceTriple(evidence, terms[1], namedTerm(RDF_TYPE_IRI), terms[0]);
    addEvidenceTriple(evidence, terms[1], terms[2], terms[3]);
    addEvidenceTriple(evidence, terms[3], namedTerm(RDF_TYPE_IRI), terms[4]);
  } else if (rule === 'cax-dw') {
    addEvidenceTriple(evidence, terms[0], namedTerm('http://www.w3.org/2002/07/owl#disjointWith'), terms[1]);
    addEvidenceTriple(evidence, terms[2], namedTerm(RDF_TYPE_IRI), terms[0]);
    addEvidenceTriple(evidence, terms[2], namedTerm(RDF_TYPE_IRI), terms[1]);
  } else if (rule === 'cax-adc') {
    addEvidenceTriple(evidence, terms[0], namedTerm(RDF_TYPE_IRI), namedTerm(OWL_ALL_DISJOINT_CLASSES_IRI));
    addEvidenceText(evidence, [terms[0], terms[1], terms[2]], 'The owl:members list of ' + termToComment(terms[0]) + ' contains classes ' + termToComment(terms[1]) + ' and ' + termToComment(terms[2]) + '.');
    addEvidenceTriple(evidence, terms[3], namedTerm(RDF_TYPE_IRI), terms[1]);
    addEvidenceTriple(evidence, terms[3], namedTerm(RDF_TYPE_IRI), terms[2]);
  } else if (rule === 'dt-not-type') {
    addEvidenceText(evidence, [terms[0], terms[1]], termToComment(terms[0]) + ' is explicitly typed as ' + termToComment(terms[1]) + ', but the lexical value is not valid for that datatype.');
  }
  return evidence;
}

function addEvidenceTriple(target, subject, predicate, object) {
  if (!subject || !predicate || !object || subject.termType === 'Literal' || hasHiddenDiagnosticTerms([subject, predicate, object])) {
    return;
  }
  target.push(termToComment(subject) + ' ' + termToComment(predicate) + ' ' + termToComment(object) + ' .');
}

function addEvidenceText(target, terms, text) {
  if (hasHiddenDiagnosticTerms(terms)) {
    return;
  }
  target.push(text);
}

function publicDiagnosticTerms(terms) {
  return terms.filter((term) => term && !isHiddenDiagnosticTerm(term));
}

function hasHiddenDiagnosticTerms(terms) {
  return terms.some(isHiddenDiagnosticTerm);
}

function isHiddenDiagnosticTerm(term) {
  return Boolean(term && term.termType === 'NamedNode' && term.value.indexOf(GENERATED_SKOLEM_IRI_PREFIX) === 0);
}

function safeTermLabel(term) {
  return term && !isHiddenDiagnosticTerm(term) ? termToComment(term) : 'a hidden OWL helper node';
}

function namedTerm(value) {
  return { termType: 'NamedNode', value };
}

function cardinalityZeroTerm() {
  return { termType: 'Literal', value: '0', language: '', datatype: namedTerm(XSD_NON_NEGATIVE_INTEGER_IRI) };
}

function commentLine(value) {
  return String(value).replace(/[\\r\\n]+/g, ' ');
}

function shortIri(value) {
  const match = String(value).match(/[\/#]([^\/#]+)$/);
  return match ? match[1] : String(value);
}

function describeInconsistencyRule(rule) {
  return {
    'eq-diff1': 'same individual is also differentFrom',
    'eq-diff2': 'AllDifferent members are sameAs',
    'eq-diff3': 'AllDifferent distinctMembers are sameAs',
    'prp-irp': 'irreflexive property used reflexively',
    'prp-asyp': 'asymmetric property used in both directions',
    'prp-pdw': 'disjoint properties share a subject/object pair',
    'prp-adp': 'AllDisjointProperties members share a subject/object pair',
    'prp-npa1': 'negative object property assertion is contradicted',
    'prp-npa2': 'negative data property assertion is contradicted',
    'cls-nothing2': 'resource is typed as owl:Nothing',
    'cls-com': 'complement classes share an instance',
    'cls-maxc1': 'maxCardinality 0 restriction has a value',
    'cls-maxqc1': 'qualified maxCardinality 0 restriction has a value of the qualified class',
    'cls-maxqc2': 'qualified maxCardinality 0 restriction has a value',
    'cls-maxqd1': 'qualified maxCardinality 0 data restriction has a typed value',
    'cax-dw': 'disjoint classes share an instance',
    'cax-adc': 'AllDisjointClasses members share an instance',
    'dt-not-type': 'literal is not valid for its datatype',
  }[rule] || '';
}

function termToComment(term) {
  if (!term) {
    return 'unknown';
  }
  if (term.termType === 'NamedNode') {
    return prefixedName(term.value) || '<' + term.value + '>';
  }
  if (term.termType === 'BlankNode') {
    return '_:' + term.value;
  }
  if (term.termType === 'Literal') {
    let literal = JSON.stringify(term.value);
    if (term.language) {
      literal += '@' + term.language;
    } else if (term.datatype && term.datatype.value !== XSD_STRING_IRI) {
      literal += '^^' + termToComment(term.datatype);
    }
    return literal;
  }
  return term.termType + ':' + term.value;
}

function prefixedName(value) {
  const prefixes = Object.assign({
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
  }, outputPrefixes());
  const names = Object.keys(prefixes).sort((left, right) => prefixes[right].length - prefixes[left].length);
  for (const name of names) {
    const iri = prefixes[name];
    if (value.indexOf(iri) === 0) {
      const local = value.slice(iri.length);
      if (/^[A-Za-z_][A-Za-z0-9._-]*$/.test(local)) {
        return name + ':' + local;
      }
    }
  }
  return '';
}

function progressMessage(state, prefix) {
  if (state.messagesMode) {
    return prefix + '; parsed ' + state.parsedQuadCount + ' RDF Messages quad(s), processed ' + state.processedMessageCount + ' message(s), emitted ' + state.inferredCount + ' inferred quad(s)…';
  }
  return prefix + '; parsed ' + state.parsedQuadCount + ' input quad(s)…';
}

`;
  const blob = new Blob([source], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

async function getSource(kind: 'background' | 'data', signal: AbortSignal): Promise<string> {
  const mode = getMode(kind);
  if (mode === 'text') {
    return kind === 'background' ? editors.backgroundText.getValue() : editors.dataText.getValue();
  }

  const input = kind === 'background' ? controls.backgroundUrl : controls.dataUrl;
  const url = input.value.trim();
  if (!url) {
    throw new Error(`Enter a ${kind === 'background' ? 'background RDF' : 'data'} URL or switch to text input.`);
  }

  setStatus(`Fetching ${kind === 'background' ? 'background RDF' : 'input data'} before processing…`);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function stopActiveRun(): void {
  if (!activeRun) {
    return;
  }
  setStatus('Stopping after the current worker step…');
  controls.stopButton.disabled = true;
  activeRun.controller.abort();
}

function setRunning(running: boolean): void {
  controls.runButton.disabled = running;
  controls.stopButton.hidden = !running;
  controls.stopButton.disabled = !running;
}

function setRunStatus(run: ActiveRun, message: string): void {
  run.statusMessage = message;
  renderRunStatus(run);
}

function startElapsedCounter(run: ActiveRun): void {
  updateElapsedCounter(run);
  run.elapsedTimer = window.setInterval(() => updateElapsedCounter(run), 250);
}

function finishElapsedCounter(run: ActiveRun): void {
  if (run.finishedAt === undefined) {
    run.finishedAt = performance.now();
  }
  if (run.elapsedTimer !== undefined) {
    window.clearInterval(run.elapsedTimer);
    run.elapsedTimer = undefined;
  }
  updateElapsedCounter(run);
}

function updateElapsedCounter(run: ActiveRun): void {
  controls.runtimeStats.textContent = '';
  controls.runtimeStats.hidden = true;
  renderRunStatus(run);
}

function renderRunStatus(run: ActiveRun): void {
  if (!run.statusMessage) {
    return;
  }
  const label = run.finishedAt === undefined ? 'Elapsed' : 'Total elapsed';
  const parts = [trimDiagnosticSentence(run.statusMessage), `${label} ${formatDuration(getElapsedMs(run))}`];
  if (run.averageMessageProcessingMs !== undefined) {
    parts.push(`Avg message inference ${formatMessageDuration(run.averageMessageProcessingMs)}`);
  }
  if (run.runtimeMessage) {
    parts.push(trimDiagnosticSentence(run.runtimeMessage));
  }
  setStatus(parts.filter(Boolean).join(' · '));
}

function trimDiagnosticSentence(value: string): string {
  return value.trim().replace(/[.。]\s*$/, '');
}

function appendOutput(chunk: string): void {
  outputAppendBuffer += chunk;
  if (!outputAppendTimer) {
    outputAppendTimer = window.setTimeout(flushOutputAppendBuffer, 100);
  }
}

function flushOutputAppendBuffer(): void {
  if (outputAppendTimer) {
    window.clearTimeout(outputAppendTimer);
    outputAppendTimer = 0;
  }
  if (!outputAppendBuffer) {
    return;
  }
  const chunk = outputAppendBuffer;
  outputAppendBuffer = '';
  if (editors.outputText.replaceRange && editors.outputText.lastLine && editors.outputText.getLine) {
    const line = editors.outputText.lastLine();
    editors.outputText.replaceRange(chunk, { line, ch: editors.outputText.getLine(line).length });
  } else {
    editors.outputText.setValue(editors.outputText.getValue() + chunk);
  }
}

function clearOutputAppendBuffer(): void {
  if (outputAppendTimer) {
    window.clearTimeout(outputAppendTimer);
    outputAppendTimer = 0;
  }
  outputAppendBuffer = '';
}

function getElapsedMs(run: ActiveRun): number {
  return (run.finishedAt ?? performance.now()) - run.startedAt;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) {
    return `${seconds.toFixed(1)} s`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(0)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes} min ${wholeSeconds} s`;
}

function formatMessageDuration(ms: number): string {
  const duration = Math.max(0, ms);
  if (duration < 1) {
    return `${duration.toFixed(2)} ms`;
  }
  if (duration < 100) {
    return `${duration.toFixed(1)} ms`;
  }
  if (duration < 1000) {
    return `${duration.toFixed(0)} ms`;
  }
  return formatDuration(duration);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Inference was stopped.', 'AbortError');
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function applyModeVisibility(): void {
  setPanelVisibility(controls.backgroundUrlPanel, getMode('background') === 'url');
  setPanelVisibility(controls.backgroundTextPanel, getMode('background') === 'text');
  setPanelVisibility(controls.dataUrlPanel, getMode('data') === 'url');
  setPanelVisibility(controls.dataTextPanel, getMode('data') === 'text');
  window.setTimeout(() => {
    editors.backgroundText.refresh();
    editors.dataText.refresh();
    editors.shaclInText.refresh();
    editors.shaclOutText.refresh();
    editors.outputText.refresh();
  }, 0);
}

function setPanelVisibility(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

function getMode(kind: 'background' | 'data'): InputMode {
  const value = kind === 'background' ? controls.backgroundMode.value : controls.dataMode.value;
  return value === 'url' ? 'url' : 'text';
}

function resetDefaults(): void {
  const example = defaultExample();
  suppressStateUpdate = true;
  controls.exampleSelect.value = example.id;
  controls.backgroundMode.value = defaultState.backgroundMode;
  controls.dataMode.value = defaultState.dataMode;
  controls.statefulMaterialization.checked = false;
  controls.backgroundUrl.value = '';
  controls.dataUrl.value = '';
  setDisabledRuleFiles([]);
  editors.backgroundText.setValue(example.background);
  editors.dataText.setValue(example.data);
  editors.shaclInText.setValue(example.shaclIn ?? '');
  editors.shaclOutText.setValue(example.shaclOut ?? '');
  editors.outputText.setValue('');
  suppressStateUpdate = false;
  applyModeVisibility();
  updateHashNow();
  setStatus(`Reset to ${example.label}.`);
}

function populateExamples(): void {
  controls.exampleSelect.textContent = '';
  for (const example of bundledExamples as BundledExample[]) {
    const option = document.createElement('option');
    option.value = example.id;
    option.textContent = example.label;
    controls.exampleSelect.appendChild(option);
  }
  controls.exampleSelect.value = defaultExample().id;
}

function exampleFilesLabel(example: BundledExample): string {
  const files = [example.backgroundFile, example.dataFile];
  if (example.shaclInFile) {
    files.push(example.shaclInFile);
  }
  if (example.shaclOutFile) {
    files.push(example.shaclOutFile);
  }
  return files.join(' + ');
}

function populateRuleProfiles(): void {
  if (!controls.ruleProfileList) {
    updateRuleProfileSummary();
    return;
  }

  controls.ruleProfileList.textContent = '';
  for (const profile of bundledRuleProfiles as BundledRuleProfile[]) {
    const copy = ruleProfileCopy(profile.file);
    const id = `ruleProfile-${stableHash(profile.file)}`;
    const option = document.createElement('div');
    option.className = 'rule-profile-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = id;
    checkbox.checked = true;
    checkbox.dataset.ruleFile = profile.file;
    checkbox.addEventListener('change', () => {
      updateRuleProfileSummary();
      scheduleStateUpdate();
    });

    const text = document.createElement('div');
    text.className = 'rule-profile-copy';

    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = copy.label;

    const description = document.createElement('span');
    description.className = 'hint';
    description.textContent = copy.description;

    text.append(label, description);
    option.append(checkbox, text);
    controls.ruleProfileList.appendChild(option);
  }

  updateRuleProfileSummary();
}

function ruleProfileCopy(file: string): { label: string; description: string } {
  const profiles: Record<string, { label: string; description: string }> = {
    'owl2rl/owl2rl-eyeling.n3': {
      label: 'OWL 2 RL / RDF rules',
      description: 'Materializes OWL 2 RL and RDFS-style consequences such as subclass, subproperty, domain/range, equivalence, property chains, selected restrictions, sameAs, and inconsistency diagnostics.',
    },
    'skos/skos-entailment.n3': {
      label: 'SKOS Core entailment rules',
      description: 'Materializes SKOS Core consequences such as concept-scheme membership, broader/narrower inverses and transitive closures, semantic relation hierarchy, labels, notes, collections, and mapping properties.',
    },
    'qudt/qudt-cdt-normalization.n3': {
      label: 'QUDT/CDT normalization rules',
      description: 'Normalizes QUDT quantity values and cdt: quantity literals, using the bundled precompiled QUDT projection when this profile is selected or QUDT/CDT vocabulary is loaded.',
    },
  };
  return profiles[file] ?? {
    label: file,
    description: 'Additional bundled N3 rule profile loaded from the repository rules folder.',
  };
}

function ruleProfileCheckboxes(): HTMLInputElement[] {
  if (!controls.ruleProfileList) {
    return [];
  }
  return Array.from(controls.ruleProfileList.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-rule-file]'));
}

function selectedRuleProfiles(): BundledRuleProfile[] {
  const disabled = new Set(disabledRuleFiles());
  return (bundledRuleProfiles as BundledRuleProfile[]).filter((profile) => !disabled.has(profile.file));
}

function disabledRuleFiles(): string[] {
  return ruleProfileCheckboxes()
    .filter((checkbox) => !checkbox.checked)
    .map((checkbox) => checkbox.dataset.ruleFile ?? '')
    .filter(Boolean)
    .sort();
}

function setDisabledRuleFiles(files: string[]): void {
  const disabled = new Set(files);
  for (const checkbox of ruleProfileCheckboxes()) {
    checkbox.checked = !disabled.has(checkbox.dataset.ruleFile ?? '');
  }
  updateRuleProfileSummary();
}

function updateRuleProfileSummary(): void {
  if (!controls.rulesSummary) {
    return;
  }
  const selected = selectedRuleProfiles().map((profile) => profile.file);
  if (selected.length === bundledRuleFiles.length) {
    controls.rulesSummary.textContent = `Rule profiles: all ${selected.length} enabled`;
  } else if (selected.length === 0) {
    controls.rulesSummary.textContent = 'Rule profiles: none enabled';
  } else {
    controls.rulesSummary.textContent = `Rule profiles: ${selected.length}/${bundledRuleFiles.length} enabled`;
  }
}

function loadBundledExample(id: string): void {
  const example = findExample(id) ?? defaultExample();
  suppressStateUpdate = true;
  applyBundledExample(example);
  suppressStateUpdate = false;
  applyModeVisibility();
  updateHashNow();
  setStatus(`Loaded ${example.label} from ${exampleFilesLabel(example)}.`);
}

function applyBundledExample(example: BundledExample): void {
  controls.exampleSelect.value = example.id;
  controls.backgroundMode.value = 'text';
  controls.dataMode.value = 'text';
  controls.statefulMaterialization.checked = shouldEnableStatefulMaterialization(example.id);
  controls.backgroundUrl.value = '';
  controls.dataUrl.value = '';
  editors.backgroundText.setValue(example.background);
  editors.dataText.setValue(example.data);
  editors.shaclInText.setValue(example.shaclIn ?? '');
  editors.shaclOutText.setValue(example.shaclOut ?? '');
  editors.outputText.setValue('');
}

function shouldEnableStatefulMaterialization(exampleId: string): boolean {
  return exampleId === 'stateful-materialization';
}

function defaultExample(): BundledExample {
  return findExample('owl-skos-catalog') ?? (bundledExamples as BundledExample[])[0];
}

function findExample(id: string): BundledExample | undefined {
  return (bundledExamples as BundledExample[]).find((example) => example.id === id);
}

function collectState(): PlaygroundState {
  const selectedExample = findExample(controls.exampleSelect.value);
  const disabledRules = disabledRuleFiles();
  if (selectedExample && isUntouchedExample(selectedExample) && disabledRules.length === 0) {
    return selectedExample.id === defaultExample().id ? {} : { example: selectedExample.id };
  }

  const state: PlaygroundState = {
    disabledRuleFiles: disabledRules.length > 0 ? disabledRules : undefined,
    backgroundMode: getMode('background') === defaultState.backgroundMode ? undefined : getMode('background'),
    dataMode: getMode('data') === defaultState.dataMode ? undefined : getMode('data'),
    statefulMaterialization: controls.statefulMaterialization.checked || undefined,
    backgroundUrl: controls.backgroundUrl.value.trim() || undefined,
    dataUrl: controls.dataUrl.value.trim() || undefined,
  };

  const backgroundText = editors.backgroundText.getValue();
  const dataText = editors.dataText.getValue();
  const shaclInText = editors.shaclInText.getValue();
  const shaclOutText = editors.shaclOutText.getValue();

  if (selectedExample && isUntouchedExample(selectedExample) && selectedExample.id !== defaultExample().id) {
    state.example = selectedExample.id;
  }

  if (!state.example && backgroundText !== defaultState.backgroundText) {
    state.backgroundText = backgroundText;
  }
  if (!state.example && dataText !== defaultState.dataText) {
    state.dataText = dataText;
  }
  if (shaclInText.trim()) {
    state.shaclInText = shaclInText;
  }
  if (shaclOutText.trim()) {
    state.shaclOutText = shaclOutText;
  }

  return state;
}

function isUntouchedExample(example: BundledExample): boolean {
  return getMode('background') === 'text'
    && getMode('data') === 'text'
    && controls.statefulMaterialization.checked === shouldEnableStatefulMaterialization(example.id)
    && controls.backgroundUrl.value.trim() === ''
    && controls.dataUrl.value.trim() === ''
    && editors.backgroundText.getValue() === example.background
    && editors.dataText.getValue() === example.data
    && editors.shaclInText.getValue() === (example.shaclIn ?? '')
    && editors.shaclOutText.getValue() === (example.shaclOut ?? '');
}

function loadStateFromHash(): void {
  const exampleId = decodeExample(window.location.hash);
  if (exampleId) {
    const example = findExample(exampleId);
    if (example) {
      suppressStateUpdate = true;
      applyBundledExample(example);
      setDisabledRuleFiles([]);
      suppressStateUpdate = false;
      return;
    }
  }

  const state = decodeState(window.location.hash);
  if (!state) {
    return;
  }

  suppressStateUpdate = true;
  if (state.example) {
    const example = findExample(state.example);
    if (example) {
      applyBundledExample(example);
    }
  }
  controls.backgroundMode.value = state.backgroundMode ?? defaultState.backgroundMode;
  controls.dataMode.value = state.dataMode ?? defaultState.dataMode;
  if (state.statefulMaterialization !== undefined) {
    controls.statefulMaterialization.checked = state.statefulMaterialization;
  }
  controls.backgroundUrl.value = state.backgroundUrl ?? '';
  controls.dataUrl.value = state.dataUrl ?? '';
  if (state.backgroundText !== undefined) {
    editors.backgroundText.setValue(state.backgroundText);
  }
  if (state.dataText !== undefined) {
    editors.dataText.setValue(state.dataText);
  }
  if (state.shaclInText !== undefined) {
    editors.shaclInText.setValue(state.shaclInText);
  }
  if (state.shaclOutText !== undefined) {
    editors.shaclOutText.setValue(state.shaclOutText);
  }
  setDisabledRuleFiles(state.disabledRuleFiles ?? []);
  suppressStateUpdate = false;
}

function scheduleStateUpdate(): void {
  if (suppressStateUpdate) {
    return;
  }
  window.clearTimeout(stateUpdateTimer);
  stateUpdateTimer = window.setTimeout(updateHashNow, 400);
}

function updateHashNow(): void {
  const encoded = encodeState(collectState());
  const nextUrl = `${window.location.pathname}${window.location.search}${encoded ? `#${encoded}` : ''}`;
  window.history.replaceState(null, '', nextUrl);
}

function encodeState(state: PlaygroundState): string {
  if (state.example && Object.keys(state).length === 1) {
    return `example=${encodeURIComponent(state.example)}`;
  }

  const json = JSON.stringify(state);
  if (json === '{}') {
    return '';
  }
  return `state=${btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function decodeExample(hash: string): string {
  const value = hashValue(hash, '#example=');
  if (!value) {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function decodeState(hash: string): PlaygroundState | null {
  const value = hashValue(hash, '#state=');
  if (!value) {
    return null;
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return JSON.parse(decodeURIComponent(escape(atob(padded)))) as PlaygroundState;
  } catch {
    return null;
  }
}

function hashValue(hash: string, prefix: string): string {
  if (!hash.startsWith(prefix)) {
    return '';
  }
  const value = hash.slice(prefix.length);
  const trackingSuffix = value.indexOf('?');
  return trackingSuffix === -1 ? value : value.slice(0, trackingSuffix);
}

function setStatus(message: string): void {
  controls.status.textContent = message;
}

function getInput(id: string): HTMLInputElement {
  return getElement(id) as HTMLInputElement;
}

function getSelect(id: string): HTMLSelectElement {
  return getElement(id) as HTMLSelectElement;
}

function getButton(id: string): HTMLButtonElement {
  return getElement(id) as HTMLButtonElement;
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element;
}

function getOptionalElement(id: string): HTMLElement | null {
  return document.getElementById(id);
}
