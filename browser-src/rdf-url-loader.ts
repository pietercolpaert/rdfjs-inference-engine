import type { Quad } from '@rdfjs/types';

export interface RdfUrlLoaderOptions {
  input: HTMLInputElement;
  button: HTMLButtonElement;
  status: HTMLElement;
  editor: { getValue(): string; setValue(value: string): void; on(event: string, listener: () => void): void };
  api: {
    dereferenceRdfUrl(url: string): Promise<{ quads: Quad[]; messages: Quad[][]; isMessages: boolean; prefixes: Record<string, string>; url: string; statusCode?: number }>;
    writeQuads(quads: Quad[], prefixes: Record<string, string>): Promise<string>;
    writeMessages(messages: Quad[][], prefixes: Record<string, string>): Promise<string>;
  };
  onPendingChange?: (pending: boolean) => void;
}

/** Load a URL into an always-visible editor, preserving RDF Message boundaries. */
export function createRdfUrlLoader(options: RdfUrlLoaderOptions): { load(): Promise<void>; reset(): void } {
  const { input, button, status, editor, api } = options;
  let generation = 0;
  let revision = 0;
  let pending = false;
  editor.on('change', () => { revision++; });
  const setPending = (value: boolean) => {
    if (pending === value) return;
    pending = value;
    button.disabled = value;
    options.onPendingChange?.(value);
  };
  const load = async () => {
    if (pending) return;
    if (!input.value.trim() || !input.reportValidity()) {
      status.textContent = 'Enter a valid document URL.';
      return;
    }
    const currentGeneration = ++generation;
    const currentRevision = revision;
    setPending(true);
    status.textContent = 'Loading…';
    try {
      const url = new URL(input.value.trim(), document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
      const result = await api.dereferenceRdfUrl(url.href);
      if (result.statusCode !== undefined && result.statusCode >= 400) throw new Error(`HTTP ${result.statusCode}`);
      const text = result.isMessages
        ? await api.writeMessages(result.messages, result.prefixes)
        : await api.writeQuads(result.quads, result.prefixes);
      if (generation !== currentGeneration) return;
      if (revision !== currentRevision) {
        status.textContent = 'Contents were edited while loading. Press Load again to replace them.';
        return;
      }
      editor.setValue(text);
      status.textContent = result.isMessages
        ? `Loaded ${result.messages.length} RDF messages from ${result.url}.`
        : `Loaded ${result.quads.length} triples from ${result.url}.`;
    } catch (error) {
      if (generation === currentGeneration) status.textContent = `Could not load URL: ${error instanceof Error ? error.message : String(error)}. Check the URL and browser CORS access.`;
    } finally {
      if (generation === currentGeneration) setPending(false);
    }
  };
  button.addEventListener('click', () => { void load(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void load(); }
  });
  return { load, reset: () => {
    generation++;
    setPending(false);
    input.value = '';
    status.textContent = '';
  } };
}
