import { bundledRuleFiles, bundledRules } from 'bundled-rules';
import { bundledExamples } from 'bundled-examples';

declare const CodeMirror: any;

type InputMode = 'text' | 'url';

type Editor = {
  getValue(): string;
  setValue(value: string): void;
  refresh(): void;
  on(event: string, listener: () => void): void;
};

type PlaygroundState = {
  backgroundMode?: InputMode;
  dataMode?: InputMode;
  backgroundUrl?: string;
  dataUrl?: string;
  backgroundText?: string;
  dataText?: string;
};

type BundledExample = {
  id: string;
  label: string;
  backgroundFile: string;
  dataFile: string;
  background: string;
  data: string;
};

type ActiveRun = {
  controller: AbortController;
  worker?: Worker;
  startedAt: number;
  finishedAt?: number;
  elapsedTimer?: number;
  runtimeMessage?: string;
};

type WorkerRequest = {
  apiScriptUrl: string;
  bundledRules: string;
  bundledRuleCount: number;
  backgroundSource: string;
  dataMode: InputMode;
  dataSource?: string;
  dataUrl?: string;
};

type WorkerMessage =
  | { type: 'status'; message: string }
  | { type: 'runtime'; message: string }
  | { type: 'append'; chunk: string }
  | { type: 'result'; output?: string; status: string }
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
  outputText: createEditor('outputText', ''),
};

const controls = {
  exampleSelect: getSelect('exampleSelect'),
  backgroundMode: getSelect('backgroundMode'),
  dataMode: getSelect('dataMode'),
  backgroundUrl: getInput('backgroundUrl'),
  dataUrl: getInput('dataUrl'),
  backgroundUrlPanel: getElement('backgroundUrlPanel'),
  backgroundTextPanel: getElement('backgroundTextPanel'),
  dataUrlPanel: getElement('dataUrlPanel'),
  dataTextPanel: getElement('dataTextPanel'),
  runButton: getButton('runButton'),
  stopButton: getButton('stopButton'),
  resetButton: getButton('resetButton'),
  shareButton: getButton('shareButton'),
  status: getElement('status'),
  runtimeStats: getElement('runtimeStats'),
  rulesSummary: getOptionalElement('rulesSummary'),
};

let suppressStateUpdate = false;
let stateUpdateTimer = 0;
let activeRun: ActiveRun | null = null;

if (controls.rulesSummary) {
  controls.rulesSummary.textContent = `Bundled inference profiles: ${bundledRuleFiles.join(', ') || 'none'}`;
}
populateExamples();
loadStateFromHash();
applyModeVisibility();
wireControls();
scheduleStateUpdate();
setRunning(false);
setStatus('Ready. Choose an example, URL, or text input, then run OWL 2 RL + SKOS Core inference.');

function createEditor(id: string, value: string): Editor {
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
  });
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
  for (const input of [controls.backgroundUrl, controls.dataUrl]) {
    input.addEventListener('input', scheduleStateUpdate);
  }
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
    startElapsedCounter(run);
    setStatus('Preparing inference…');
    editors.outputText.setValue('');

    const backgroundSource = await getSource('background', run.controller.signal);
    throwIfAborted(run.controller.signal);
    const dataMode = getMode('data');
    const dataSource = dataMode === 'text' ? editors.dataText.getValue() : undefined;
    const dataUrl = dataMode === 'url' ? controls.dataUrl.value.trim() : undefined;
    if (dataMode === 'url' && !dataUrl) {
      throw new Error('Enter a data URL or switch to text input.');
    }

    await runWorkerInference(run, {
      apiScriptUrl: new URL('browser/rdfjs-inference-engine.min.js', window.location.href).href,
      bundledRules,
      bundledRuleCount: bundledRuleFiles.length,
      backgroundSource,
      dataMode,
      dataSource,
      dataUrl,
    });
  } catch (error) {
    finishElapsedCounter(run);
    if (isAbortError(error)) {
      setStatus(`Stopped after ${formatDuration(getElapsedMs(run))}. No more messages or quads will be processed.`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Error after ${formatDuration(getElapsedMs(run))}: ${message}`);
      editors.outputText.setValue(message);
    }
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
        setStatus(message.message);
      } else if (message.type === 'runtime') {
        run.runtimeMessage = message.message;
        updateElapsedCounter(run);
      } else if (message.type === 'append') {
        editors.outputText.setValue(editors.outputText.getValue() + message.chunk);
      } else if (message.type === 'result') {
        finishElapsedCounter(run);
        if (message.output !== undefined) {
          editors.outputText.setValue(message.output);
        }
        setStatus(`${message.status} Total elapsed ${formatDuration(getElapsedMs(run))}.`);
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

function createInferenceWorker(): Worker {
  const source = `
self.onmessage = async (event) => {
  const request = event.data;
  try {
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
    const runtime = reasoner.load({ n3: request.bundledRules, label: 'Bundled OWL 2 RL + SKOS Core profiles' }, background.quads);
    const compiledAt = performance.now();
    self.postMessage({ type: 'runtime', message: background.quads.length + ' background quads, ' + request.bundledRuleCount + ' rule file(s), runtime ' + (runtime.length / 1024).toFixed(1) + ' KiB' });

    await processInputData(api, reasoner, request, compiledAt, started);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
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
  const state = createStreamingState(api, reasoner, compiledAt, started, 'text input');
  handleParsedItems(state, state.parser.write(source));
  handleParsedItems(state, state.parser.end());
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

  const state = createStreamingState(api, reasoner, compiledAt, started, url);
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
    handleParsedItems(state, state.parser.write(text));
    self.postMessage({ type: 'status', message: progressMessage(state, 'Streaming input: read ' + Math.round(bytes / 1024) + ' KiB') });
  }

  const tail = decoder.decode();
  if (tail) {
    handleParsedItems(state, state.parser.write(tail));
  }
  handleParsedItems(state, state.parser.end());
  await finishStreamingState(state);
}

function createStreamingState(api, reasoner, compiledAt, started, sourceLabel) {
  return {
    api,
    reasoner,
    parser: new api.IncrementalParser({ factory: api.DataFactory }),
    sourceLabel,
    compiledAt,
    started,
    messagesMode: false,
    ordinaryQuads: [],
    currentMessage: [],
    currentMessageCounter: 0,
    parsedQuadCount: 0,
    processedMessageCount: 0,
    inferredCount: 0,
    writer: null,
  };
}

function handleParsedItems(state, items) {
  for (const item of items) {
    if (state.api.isMessageQuad(item)) {
      state.messagesMode = true;
      while (state.currentMessageCounter < item.messageCounter) {
        processCurrentMessage(state);
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
    processCurrentMessage(state);
    if (state.writer) {
      await endWriter(state.writer);
    }
    self.postMessage({ type: 'result', status: 'Done. Streamed ' + state.parsedQuadCount + ' RDF Messages quad(s) in ' + state.processedMessageCount + ' message(s), inferred ' + state.inferredCount + ' quad(s). Compile ' + (state.compiledAt - state.started).toFixed(0) + ' ms, infer ' + (performance.now() - state.compiledAt).toFixed(0) + ' ms.' });
    return;
  }

  const total = state.ordinaryQuads.length;
  self.postMessage({ type: 'status', message: 'Parsed ' + total + ' input quad(s). Running inference…' });
  const inferred = Array.from(state.reasoner.infer(state.ordinaryQuads));
  self.postMessage({ type: 'status', message: 'Processed ' + total + ' input quad(s). Serializing ' + inferred.length + ' inferred quad(s)…' });
  const output = await state.api.writeQuads(inferred, outputPrefixes());
  self.postMessage({ type: 'result', output, status: 'Done. Processed ' + total + ' input quad(s), inferred ' + inferred.length + ' quad(s). Compile ' + (state.compiledAt - state.started).toFixed(0) + ' ms, infer ' + (performance.now() - state.compiledAt).toFixed(0) + ' ms.' });
}

function processCurrentMessage(state) {
  if (!state.writer) {
    state.writer = createMessageWriter(state.api);
  }
  self.postMessage({ type: 'status', message: 'Processing message ' + (state.currentMessageCounter + 1) + ' after parsing ' + state.parsedQuadCount + ' quad(s)…' });
  const inferred = Array.from(state.reasoner.infer(state.currentMessage));
  state.writer.addMessage(inferred);
  state.inferredCount += inferred.length;
  state.processedMessageCount += 1;
}

function createMessageWriter(api) {
  return new api.Writer({
    write(chunk, _encoding, callback) {
      self.postMessage({ type: 'append', chunk });
      callback?.(null);
    },
    end(callback) {
      callback?.(null, '');
    },
  }, { prefixes: outputPrefixes(), rdfMessages: true, format: 'N-Quads' });
}

function endWriter(writer) {
  return new Promise((resolve, reject) => {
    writer.end((error) => error ? reject(error) : resolve());
  });
}

function progressMessage(state, prefix) {
  if (state.messagesMode) {
    return prefix + '; parsed ' + state.parsedQuadCount + ' RDF Messages quad(s), processed ' + state.processedMessageCount + ' message(s), inferred ' + state.inferredCount + ' quad(s)…';
  }
  return prefix + '; parsed ' + state.parsedQuadCount + ' input quad(s)…';
}

function outputPrefixes() {
  return {
    transit: 'https://example.org/transit#',
    logistics: 'https://example.org/logistics#',
    subjects: 'https://example.org/subjects#',
    catalog: 'https://example.org/catalog#',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
  };
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

function startElapsedCounter(run: ActiveRun): void {
  updateElapsedCounter(run);
  run.elapsedTimer = window.setInterval(() => updateElapsedCounter(run), 100);
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
  const label = run.finishedAt === undefined ? 'Elapsed' : 'Total elapsed';
  const parts = [`${label} ${formatDuration(getElapsedMs(run))}`];
  if (run.runtimeMessage) {
    parts.push(run.runtimeMessage);
  }
  controls.runtimeStats.textContent = parts.join(' · ');
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
  controls.backgroundUrl.value = '';
  controls.dataUrl.value = '';
  editors.backgroundText.setValue(example.background);
  editors.dataText.setValue(example.data);
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
    option.textContent = `${example.label} — ${example.backgroundFile} + ${example.dataFile}`;
    controls.exampleSelect.appendChild(option);
  }
  controls.exampleSelect.value = defaultExample().id;
}

function loadBundledExample(id: string): void {
  const example = findExample(id) ?? defaultExample();
  suppressStateUpdate = true;
  controls.backgroundMode.value = 'text';
  controls.dataMode.value = 'text';
  controls.backgroundUrl.value = '';
  controls.dataUrl.value = '';
  editors.backgroundText.setValue(example.background);
  editors.dataText.setValue(example.data);
  editors.outputText.setValue('');
  suppressStateUpdate = false;
  applyModeVisibility();
  updateHashNow();
  setStatus(`Loaded ${example.label} from ${example.backgroundFile} and ${example.dataFile}.`);
}

function defaultExample(): BundledExample {
  return findExample('owl-skos-catalog') ?? (bundledExamples as BundledExample[])[0];
}

function findExample(id: string): BundledExample | undefined {
  return (bundledExamples as BundledExample[]).find((example) => example.id === id);
}

function collectState(): PlaygroundState {
  const state: PlaygroundState = {
    backgroundMode: getMode('background') === defaultState.backgroundMode ? undefined : getMode('background'),
    dataMode: getMode('data') === defaultState.dataMode ? undefined : getMode('data'),
    backgroundUrl: controls.backgroundUrl.value.trim() || undefined,
    dataUrl: controls.dataUrl.value.trim() || undefined,
  };

  const backgroundText = editors.backgroundText.getValue();
  const dataText = editors.dataText.getValue();

  if (backgroundText !== defaultState.backgroundText) {
    state.backgroundText = backgroundText;
  }
  if (dataText !== defaultState.dataText) {
    state.dataText = dataText;
  }

  return state;
}

function loadStateFromHash(): void {
  const state = decodeState(window.location.hash);
  if (!state) {
    return;
  }

  suppressStateUpdate = true;
  controls.backgroundMode.value = state.backgroundMode ?? defaultState.backgroundMode;
  controls.dataMode.value = state.dataMode ?? defaultState.dataMode;
  controls.backgroundUrl.value = state.backgroundUrl ?? '';
  controls.dataUrl.value = state.dataUrl ?? '';
  if (state.backgroundText !== undefined) {
    editors.backgroundText.setValue(state.backgroundText);
  }
  if (state.dataText !== undefined) {
    editors.dataText.setValue(state.dataText);
  }
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
  const nextUrl = `${window.location.pathname}${window.location.search}${encoded ? `#state=${encoded}` : ''}`;
  window.history.replaceState(null, '', nextUrl);
}

function encodeState(state: PlaygroundState): string {
  const json = JSON.stringify(state);
  if (json === '{}') {
    return '';
  }
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeState(hash: string): PlaygroundState | null {
  const value = hash.startsWith('#state=') ? hash.slice('#state='.length) : '';
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
