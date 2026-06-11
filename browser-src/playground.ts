import { bundledRuleFiles, bundledRules } from 'bundled-rules';
import defaultBackground from '../ontologies/transit.n3';
import defaultData from '../examples/input/data.trig';

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

type ActiveRun = {
  controller: AbortController;
  worker?: Worker;
};

type WorkerRequest = {
  apiScriptUrl: string;
  bundledRules: string;
  bundledRuleCount: number;
  backgroundSource: string;
  dataSource: string;
};

type WorkerMessage =
  | { type: 'status'; message: string }
  | { type: 'runtime'; message: string }
  | { type: 'result'; output: string; status: string }
  | { type: 'error'; message: string };

const defaultState = {
  backgroundMode: 'text' as InputMode,
  dataMode: 'text' as InputMode,
  backgroundText: defaultBackground,
  dataText: defaultData,
};

const editors = {
  backgroundText: createEditor('backgroundText', defaultState.backgroundText),
  dataText: createEditor('dataText', defaultState.dataText),
  outputText: createEditor('outputText', ''),
};

const controls = {
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
  controls.rulesSummary.textContent = `Bundled rules: ${bundledRuleFiles.join(', ') || 'none'}`;
}
loadStateFromHash();
applyModeVisibility();
wireControls();
scheduleStateUpdate();
setRunning(false);
setStatus('Ready. Choose URL or text input, then run the bundled rule profile.');

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

  const run: ActiveRun = { controller: new AbortController() };
  activeRun = run;

  try {
    setRunning(true);
    controls.runtimeStats.textContent = '';
    setStatus('Preparing inference…');
    editors.outputText.setValue('');

    const backgroundSource = await getSource('background', run.controller.signal);
    throwIfAborted(run.controller.signal);
    const dataSource = await getSource('data', run.controller.signal);
    throwIfAborted(run.controller.signal);

    await runWorkerInference(run, {
      apiScriptUrl: new URL('browser/rdfjs-inference-engine.min.js', window.location.href).href,
      bundledRules,
      bundledRuleCount: bundledRuleFiles.length,
      backgroundSource,
      dataSource,
    });
  } catch (error) {
    if (isAbortError(error)) {
      setStatus('Stopped. No more messages or quads will be processed.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Error: ${message}`);
      editors.outputText.setValue(message);
    }
  } finally {
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
        controls.runtimeStats.textContent = message.message;
      } else if (message.type === 'result') {
        editors.outputText.setValue(message.output);
        setStatus(message.status);
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
    self.postMessage({ type: 'status', message: 'Parsed ' + background.quads.length + ' background quad(s). Parsing input data…' });

    const data = api.parseRdfOrMessages(request.dataSource);
    if (data.isMessages) {
      self.postMessage({ type: 'status', message: 'Parsed ' + data.messages.length + ' message(s) containing ' + data.quads.length + ' quad(s). Compiling runtime…' });
    } else {
      self.postMessage({ type: 'status', message: 'Parsed ' + data.quads.length + ' input quad(s). Compiling runtime…' });
    }

    const reasoner = new api.InferenceEngine();
    const started = performance.now();
    const runtime = reasoner.load({ n3: request.bundledRules, label: 'Bundled rules folder profile' }, background.quads);
    const compiledAt = performance.now();
    self.postMessage({ type: 'runtime', message: background.quads.length + ' background quads, ' + request.bundledRuleCount + ' rule file(s), runtime ' + (runtime.length / 1024).toFixed(1) + ' KiB' });

    if (data.isMessages) {
      const inferredMessages = [];
      let inferredCount = 0;
      const total = data.messages.length;
      for (let index = 0; index < total; index += 1) {
        self.postMessage({ type: 'status', message: 'Processed ' + index + ' of ' + total + ' message(s)…' });
        const inferred = Array.from(reasoner.infer(data.messages[index]));
        inferredMessages.push(inferred);
        inferredCount += inferred.length;
      }
      self.postMessage({ type: 'status', message: 'Processed ' + total + ' of ' + total + ' message(s). Serializing ' + inferredCount + ' inferred quad(s)…' });
      const output = await api.writeMessages(inferredMessages);
      self.postMessage({ type: 'result', output, status: 'Done. Processed ' + total + ' message(s), inferred ' + inferredCount + ' quad(s) as RDF Messages. Compile ' + (compiledAt - started).toFixed(0) + ' ms, infer ' + (performance.now() - compiledAt).toFixed(0) + ' ms.' });
    } else {
      const total = data.quads.length;
      self.postMessage({ type: 'status', message: 'Processed 0 of ' + total + ' input quad(s)…' });
      const inferred = Array.from(reasoner.infer(data.quads));
      self.postMessage({ type: 'status', message: 'Processed ' + total + ' of ' + total + ' input quad(s). Serializing ' + inferred.length + ' inferred quad(s)…' });
      const output = await api.writeQuads(inferred, { ex: 'https://example.org/transit#' });
      self.postMessage({ type: 'result', output, status: 'Done. Processed ' + total + ' input quad(s), inferred ' + inferred.length + ' quad(s). Compile ' + (compiledAt - started).toFixed(0) + ' ms, infer ' + (performance.now() - compiledAt).toFixed(0) + ' ms.' });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
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
  suppressStateUpdate = true;
  controls.backgroundMode.value = defaultState.backgroundMode;
  controls.dataMode.value = defaultState.dataMode;
  controls.backgroundUrl.value = '';
  controls.dataUrl.value = '';
  editors.backgroundText.setValue(defaultState.backgroundText);
  editors.dataText.setValue(defaultState.dataText);
  editors.outputText.setValue('');
  suppressStateUpdate = false;
  applyModeVisibility();
  updateHashNow();
  setStatus('Reset to the bundled example.');
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
