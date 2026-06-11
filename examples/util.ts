import type { Quad } from '@rdfjs/types';
import { DataFactory, isMessageQuad, Parser, toMessages, Writer } from 'rdf-parser-ts';

export interface ParsedRdfInput {
  isMessages: boolean;
  quads: Quad[];
  messages: Quad[][];
}

export function parseToQuads(source: string): Quad[] {
  return parseRdfOrMessages(source).quads;
}

export function parseRdfOrMessages(source: string): ParsedRdfInput {
  const parsed = parseWithAutomaticMessages(source);
  const raw = Array.from(parsed as Iterable<unknown>);
  const messageQuads = raw.filter((item) => isMessageQuad(item));

  if (messageQuads.length > 0) {
    const messages = toMessages(messageQuads as any[]).map((message) => Array.from(message as Iterable<unknown>, (quad) => quad as Quad));
    return {
      isMessages: true,
      quads: messageQuads.map((item: any) => item.quad as Quad),
      messages,
    };
  }

  return {
    isMessages: false,
    quads: raw as Quad[],
    messages: [],
  };
}

export async function writeQuads(quads: Iterable<Quad>, prefixes: Record<string, string> = {}): Promise<string> {
  const writer = new Writer({ prefixes });
  writer.addQuads(quads);

  return new Promise<string>((resolve, reject) => {
    writer.end((error, result) => error ? reject(error) : resolve(result ?? ''));
  });
}

export async function writeMessages(messages: Iterable<Iterable<Quad>>, prefixes: Record<string, string> = {}): Promise<string> {
  const writer = new Writer({ prefixes, rdfMessages: true, format: 'N-Quads' });
  for (const message of messages) {
    writer.addMessage(message);
  }

  return new Promise<string>((resolve, reject) => {
    writer.end((error, result) => error ? reject(error) : resolve(result ?? ''));
  });
}

export function assertContainsQuads(actual: Quad[], expected: Quad[], label: string): void {
  const actualKeys = new Set(actual.map(quadKey));
  const missing = expected.filter((quad) => !actualKeys.has(quadKey(quad)));

  if (missing.length > 0) {
    throw new Error(`${label} missed ${missing.length} expected entailment(s):\n${missing.map(quadKey).join('\n')}`);
  }
}

function parseWithAutomaticMessages(source: string): Iterable<unknown> {
  try {
    return new Parser({ factory: DataFactory }).parse(source) ?? [];
  } catch (error) {
    if (!hasMessageSyntax(source)) {
      throw error;
    }
    return new Parser({ factory: DataFactory, rdfMessages: true }).parse(source) ?? [];
  }
}

function hasMessageSyntax(source: string): boolean {
  return /(?:@version\s+["']1\.2-messages["']|VERSION\s+["']1\.2-messages["']|@message\b|^\s*MESSAGE\b)/im.test(source);
}

function quadKey(quad: Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph].map(termKey).join(' ');
}

function termKey(term: Quad['subject'] | Quad['predicate'] | Quad['object'] | Quad['graph']): string {
  if (term.termType === 'Literal') {
    return `"${term.value}"@${term.language}^^${term.datatype.value}`;
  }
  return `${term.termType}:${term.value}`;
}
