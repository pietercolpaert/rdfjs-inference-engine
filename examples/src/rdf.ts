import type { Quad } from '@rdfjs/types';
import { DataFactory, isMessageQuad, Parser, Writer } from 'rdf-parser-ts';

export function parseToQuads(source: string): Quad[] {
  const parser = new Parser({ factory: DataFactory });
  const parsed = parser.parse(source) ?? [];
  return Array.from(parsed as Iterable<unknown>, (item) => (isMessageQuad(item) ? item.quad : item) as Quad);
}

export async function writeQuads(quads: Iterable<Quad>, prefixes: Record<string, string> = {}): Promise<string> {
  const writer = new Writer({ prefixes });
  writer.addQuads(quads);

  return new Promise<string>((resolve, reject) => {
    writer.end((error, result) => error ? reject(error) : resolve(result ?? ''));
  });
}
