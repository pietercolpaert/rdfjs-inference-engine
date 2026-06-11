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

const api = (window as any).RdfjsInferenceEngine;

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
  resetButton: getButton('resetButton'),
  shareButton: getButton('shareButton'),
  status: getElement('status'),
  runtimeStats: getElement('runtimeStats'),
  rulesSummary: getElement('rulesSummary'),
};

let suppressStateUpdate = false;
let stateUpdateTimer = 0;

controls.rulesSummary.textContent = `Bundled rules: ${bundledRuleFiles.join(', ') || 'none'}`;
loadStateFromHash();
applyModeVisibility();
wireControls();
scheduleStateUpdate();
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
  try {
    controls.runButton.disabled = true;
    setStatus('Loading RDF, parsing quads, and compiling generated runtime…');
    editors.outputText.setValue('');

    const backgroundSource = await getSource('background');
    const dataSource = await getSource('data');
    const background = api.parseRdfOrMessages(backgroundSource);
    const data = api.parseRdfOrMessages(dataSource);

    const reasoner = new api.InferenceEngine();
    const started = performance.now();
    const runtime = reasoner.load({ n3: bundledRules, label: 'Bundled rules folder profile' }, background.quads);
    const compiledAt = performance.now();

    controls.runtimeStats.textContent = `${background.quads.length} background quads, ${bundledRuleFiles.length} rule file(s), runtime ${(runtime.length / 1024).toFixed(1)} KiB`;

    if (data.isMessages) {
      setStatus(`Detected RDF Messages log with ${data.messages.length} message(s). Streaming inference…`);
      await runStreamingInference(reasoner, data.messages);
    } else {
      const inferred = Array.from(reasoner.infer(data.quads));
      editors.outputText.setValue(await api.writeQuads(inferred, { ex: 'https://example.org/transit#' }));
      setStatus(`Done. ${inferred.length} inferred quad(s). Compile ${(compiledAt - started).toFixed(0)} ms, infer ${(performance.now() - compiledAt).toFixed(0)} ms.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Error: ${message}`);
    editors.outputText.setValue(message);
  } finally {
    controls.runButton.disabled = false;
  }
}

async function runStreamingInference(reasoner: any, messages: any[][]): Promise<void> {
  const inferredMessages: any[][] = [];
  let inferredCount = 0;
  let serializationQueue = Promise.resolve();
  const stream = reasoner.stream();

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (inferred: any[]) => {
      inferredMessages.push(inferred);
      inferredCount += inferred.length;
      serializationQueue = serializationQueue.then(async () => {
        editors.outputText.setValue(await api.writeMessages(inferredMessages));
      });
    });
    stream.on('error', reject);
    stream.on('end', () => {
      serializationQueue.then(resolve, reject);
    });

    for (const message of messages) {
      stream.write(message);
    }
    stream.end();
  });

  setStatus(`Done. Streamed ${messages.length} message(s), ${inferredCount} inferred quad(s) as RDF Messages.`);
}

async function getSource(kind: 'background' | 'data'): Promise<string> {
  const mode = getMode(kind);
  if (mode === 'text') {
    return kind === 'background' ? editors.backgroundText.getValue() : editors.dataText.getValue();
  }

  const input = kind === 'background' ? controls.backgroundUrl : controls.dataUrl;
  const url = input.value.trim();
  if (!url) {
    throw new Error(`Enter a ${kind === 'background' ? 'background RDF' : 'data'} URL or switch to text input.`);
  }

  setStatus(`Fetching ${kind === 'background' ? 'background RDF' : 'input data'}…`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
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
