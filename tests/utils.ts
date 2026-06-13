import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { get } from 'node:https';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory, isMessageQuad, Parser } from 'rdf-parser-ts';
import { RdfXmlParser } from 'rdfxml-streaming-parser';

const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';

export function parseRdf(source: string): Quad[] {
  const parser = new Parser({ factory: DataFactory });
  const parsed = parser.parse(source) ?? [];
  return Array.from(parsed as Iterable<unknown>, (item) => (isMessageQuad(item) ? item.quad : item) as Quad);
}

export function parseRdfWithBase(source: string, baseIRI: string): Quad[] {
  const parser = new Parser({ factory: DataFactory, baseIRI, relax: true });
  const parsed = parser.parse(source.replace(/\]([.;,])/g, '] $1')) ?? [];
  return Array.from(parsed as Iterable<unknown>, (item) => (isMessageQuad(item) ? item.quad : item) as Quad);
}

export async function parseRdfXml(source: string, baseIRI: string): Promise<Quad[]> {
  return new Promise<Quad[]>((resolve, reject) => {
    const parser = new RdfXmlParser({
      baseIRI,
      validateUri: false,
      allowDuplicateRdfIds: true,
    });
    const quads: Quad[] = [];

    parser.on('data', (quad: Quad) => quads.push(quad));
    parser.on('error', reject);
    parser.on('end', () => resolve(quads));
    Readable.from([source]).pipe(parser);
  });
}

export async function readCachedUrl(url: string, cachePath: string): Promise<string> {
  if (existsSync(cachePath) && statSync(cachePath).size > 0) {
    return readFileSync(cachePath, 'utf8');
  }

  mkdirSync(dirname(cachePath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(cachePath, { encoding: 'utf8' });
    fetchToStream(url, stream, 0, true, (error) => error ? reject(error) : resolve());
  });

  return readFileSync(cachePath, 'utf8');
}

export async function readCachedBinaryUrl(url: string, cachePath: string): Promise<Buffer> {
  if (existsSync(cachePath) && statSync(cachePath).size > 0) {
    return readFileSync(cachePath);
  }

  mkdirSync(dirname(cachePath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(cachePath);
    fetchToStream(url, stream, 0, false, (error) => error ? reject(error) : resolve());
  });

  return readFileSync(cachePath);
}

export function graphContainsAll(actual: Quad[], expected: Quad[]): boolean {
  const actualSet = new Set(actual.map(quadKey));
  const expectedBlankNodes = Array.from(blankNodes(expected));
  const expectedGround = expected.filter(isGroundQuad);
  const expectedWithBlankNodes = expected.filter((quad) => !isGroundQuad(quad));

  if (!expectedGround.every((quad) => actualSet.has(quadKey(quad)))) {
    return false;
  }

  if (expectedWithBlankNodes.length === 0) {
    return true;
  }

  const candidates = Array.from(candidateTerms(actual));
  const mapping = new Map<string, Term>();

  return matchBlankNode(0);

  function matchBlankNode(index: number): boolean {
    if (index === expectedBlankNodes.length) {
      return expectedWithBlankNodes.every((quad) => actualSet.has(quadKeyWithMapping(quad, mapping)));
    }

    const label = expectedBlankNodes[index];
    for (const candidate of candidates) {
      mapping.set(label, candidate);
      if (matchBlankNode(index + 1)) {
        return true;
      }
      mapping.delete(label);
    }

    return false;
  }
}

export function addReflexiveSameAsClosure(quads: Quad[]): Quad[] {
  const result = [...quads];
  const seen = new Set(result.map(quadKey));
  for (const term of allConcreteTerms(quads)) {
    const quad = DataFactory.quad(term as any, DataFactory.namedNode(OWL_SAME_AS), term as any) as Quad;
    const key = quadKey(quad);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(quad);
    }
  }
  return result;
}

export function quadKey(quad: Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph].map(termKey).join(' ');
}

export function termKey(term: Term): string {
  if (term.termType === 'Literal') {
    return `"${term.value}"@${term.language}^^${term.datatype.value}`;
  }
  return `${term.termType}:${term.value}`;
}

function fetchToStream(url: string, stream: NodeJS.WritableStream, redirects: number, text: boolean, done: (error?: Error) => void): void {
  get(url, (response) => {
    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location && redirects < 5) {
      response.resume();
      fetchToStream(new URL(location, url).toString(), stream, redirects + 1, text, done);
      return;
    }

    if (status < 200 || status >= 300) {
      response.resume();
      done(new Error(`Failed to download ${url}: HTTP ${status}`));
      return;
    }

    if (text) {
      response.setEncoding('utf8');
    }
    response.pipe(stream);
    stream.on('finish', () => done());
    stream.on('error', done);
  }).on('error', done);
}

function blankNodes(quads: Quad[]): Set<string> {
  const labels = new Set<string>();
  for (const quad of quads) {
    for (const term of [quad.subject, quad.predicate, quad.object, quad.graph]) {
      if (term.termType === 'BlankNode') {
        labels.add(term.value);
      }
    }
  }
  return labels;
}

function candidateTerms(quads: Quad[]): Set<Term> {
  const termsByKey = new Map<string, Term>();
  for (const quad of quads) {
    for (const term of [quad.subject, quad.object]) {
      if (term.termType === 'NamedNode' || term.termType === 'BlankNode') {
        termsByKey.set(termKey(term), term);
      }
    }
  }
  return new Set(termsByKey.values());
}

function allConcreteTerms(quads: Quad[]): Set<Term> {
  const termsByKey = new Map<string, Term>();
  for (const quad of quads) {
    for (const term of [quad.subject, quad.predicate, quad.object, quad.graph]) {
      if (term.termType !== 'DefaultGraph') {
        termsByKey.set(termKey(term), term);
      }
    }
  }
  return new Set(termsByKey.values());
}

function isGroundQuad(quad: Quad): boolean {
  return ![quad.subject, quad.predicate, quad.object, quad.graph].some((term) => term.termType === 'BlankNode');
}

function quadKeyWithMapping(quad: Quad, mapping: Map<string, Term>): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph].map((term) => termKey(applyMapping(term, mapping))).join(' ');
}

function applyMapping(term: Term, mapping: Map<string, Term>): Term {
  return term.termType === 'BlankNode' && mapping.has(term.value) ? mapping.get(term.value)! : term;
}
