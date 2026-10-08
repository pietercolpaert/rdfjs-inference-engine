import type { DataFactory, Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';

/** Eyeling 2.35 strips language tags in its RDF/JS conversion, while its
 * serialized derived triple retains them. Recover the literal without
 * reparsing subject identifiers or changing blank-node identity.
 */
export function preserveEyelingLanguage(quad: Quad, triple: string | undefined, factory: DataFactory): Quad {
  if (!triple || quad.object.termType !== 'Literal' || quad.object.language) return quad;
  const literal = /("(?:\\.|[^"\\])*"@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--(?:ltr|rtl))?)\s*\.\s*$/.exec(triple)?.[1];
  if (!literal) return quad;
  const parsed = new Parser({ factory }).parse(`<urn:literal> <urn:value> ${literal} .`) as Quad[];
  const object = parsed[0].object;
  if (object.value !== quad.object.value) return quad;
  return factory.quad(quad.subject, quad.predicate, object, quad.graph);
}
