import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import type { Quad } from '@rdfjs/types';
const { Store } = require('n3');

export interface ConstructWorkerRequest {
  apiScriptUrl: string;
  query: string;
  dataSource: string;
  baseIRI: string;
}
export type ConstructWorkerMessage =
  | { type: 'status'; message: string }
  | { type: 'result'; output: string; processedMessages: number; outputQuads: number; elapsedMs: number }
  | { type: 'error'; message: string };
const scope = globalThis as unknown as {
  importScripts(url: string): void;
  RdfjsInferenceEngine: any;
  postMessage(message: ConstructWorkerMessage): void;
  onmessage: (event: MessageEvent<ConstructWorkerRequest>) => void;
};
scope.onmessage = async ({ data: request }) => {
  const started = performance.now();
  try {
    scope.importScripts(request.apiScriptUrl);
    const api = scope.RdfjsInferenceEngine;
    const parsed = api.parseRdfOrMessages(request.dataSource, { baseIRI: request.baseIRI });
    const messages: Quad[][] = parsed.isMessages ? parsed.messages : [parsed.quads];
    const engine = new QueryEngine();
    const output: Quad[][] = [];
    let outputQuads = 0;
    for (const [index, message] of messages.entries()) {
      scope.postMessage({ type: 'status', message: `Executing the generated query on ${parsed.isMessages ? `message ${index + 1} of ${messages.length}` : 'input RDF'}…` });
      // Each input message is the default graph, including input originally carried in named graphs.
      const source = new Store(message.map(q => api.DataFactory.quad(q.subject, q.predicate, q.object)));
      const stream = await engine.queryQuads(request.query, { sources: [source], baseIRI: request.baseIRI });
      const result = await stream.toArray();
      output.push(result);
      outputQuads += result.length;
    }
    const prefixes = { schema: 'https://schema.org/', ex: 'https://example.org/',
      photo: 'https://example.org/nde-photo/objects/', person: 'https://example.org/nde-photo/people/',
      term: 'https://example.org/nde-photo/terms/', xsd: 'http://www.w3.org/2001/XMLSchema#' };
    const text = parsed.isMessages ? await api.writeMessages(output, prefixes) : await api.writeQuads(output[0], prefixes);
    scope.postMessage({ type: 'result', output: text, processedMessages: messages.length, outputQuads, elapsedMs: performance.now() - started });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
