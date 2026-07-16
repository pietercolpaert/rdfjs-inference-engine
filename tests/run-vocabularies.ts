import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Quad } from '@rdfjs/types';
import { RdfaParser } from 'rdfa-streaming-parser';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_PROPERTY = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property';
const RDFS_CLASS = 'http://www.w3.org/2000/01/rdf-schema#Class';
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const SKOS_CONCEPT = 'http://www.w3.org/2004/02/skos/core#Concept';
const ROOT = 'https://www.pieter.pm/rdfjs-inference-engine/ns/';

const vocabularies = [
  {
    name: 'inconsistencies',
    path: 'ns/inconsistencies/index.html',
    sourcePaths: ['rules/owl2rl/owl2rl-eyeling.n3'],
    prefixes: ['inconsistencies'],
  },
  {
    name: 'internal',
    path: 'ns/internal/index.html',
    sourcePaths: [
      'rules/owl2rl/owl2rl-eyeling.n3',
      'rules/qudt/qudt-cdt-normalization.n3',
      'rules/shacl-experimental/shacl-core-eyeling.n3',
      'rules/shacl-experimental/shacl12-core-eyeling.n3',
    ],
    prefixes: ['internal', 'shn'],
  },
  {
    name: 'qudt-inference',
    path: 'ns/qudt-inference/index.html',
    sourcePaths: [
      'rules/qudt/qudt-cdt-normalization.n3',
      'examples/qudt-mixed-speed/shapes-in.n3',
    ],
    prefixes: ['qcr'],
  },
] as const;

async function main(): Promise<void> {
  let assertionCount = 0;
  for (const vocabulary of vocabularies) {
    const documentIri = ROOT + vocabulary.name;
    const namespace = documentIri + '#';
    const quads = await parseRdfa(vocabulary.path, documentIri + '/');
    const subjects = new Set(quads.map((quad) => quad.subject.value));

    assert.ok(hasTriple(quads, documentIri, RDF_TYPE, OWL_ONTOLOGY), `${vocabulary.name} must describe an owl:Ontology.`);
    assertionCount += 1;

    for (const term of sourceTerms(vocabulary.sourcePaths, vocabulary.prefixes)) {
      assert.ok(subjects.has(namespace + term), `${vocabulary.name} RDFa does not define #${term}.`);
      assertionCount += 1;
    }
  }

  const inconsistencies = await parseRdfa('ns/inconsistencies/index.html', ROOT + 'inconsistencies/');
  assert.ok(hasTriple(inconsistencies, ROOT + 'inconsistencies#Inconsistency', RDF_TYPE, RDFS_CLASS));
  assert.ok(hasTriple(inconsistencies, ROOT + 'inconsistencies#rule', RDF_TYPE, RDF_PROPERTY));
  assertionCount += 2;

  const qudt = await parseRdfa('ns/qudt-inference/index.html', ROOT + 'qudt-inference/');
  assert.ok(hasTriple(qudt, ROOT + 'qudt-inference#UcumUnitIn', RDF_TYPE, RDF_PROPERTY));
  assert.ok(hasTriple(qudt, ROOT + 'qudt-inference#SpeedProfile', RDF_TYPE, SKOS_CONCEPT));
  assertionCount += 2;

  console.log(`Vocabulary RDFa: ${vocabularies.length} documents, ${assertionCount} assertions.`);
}

async function parseRdfa(path: string, baseIRI: string): Promise<Quad[]> {
  const parser = new RdfaParser({ baseIRI });
  const quads: Quad[] = [];
  parser.on('data', (quad: Quad) => quads.push(quad));
  await new Promise<void>((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', reject);
    Readable.from([readFileSync(path, 'utf8')]).pipe(parser);
  });
  return quads;
}

function sourceTerms(paths: readonly string[], prefixes: readonly string[]): Set<string> {
  const terms = new Set<string>();
  const pattern = new RegExp(`\\b(?:${prefixes.join('|')}):([A-Za-z][A-Za-z0-9_-]*)`, 'g');
  for (const path of paths) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(pattern)) {
      terms.add(match[1]);
    }
  }
  return terms;
}

function hasTriple(quads: Quad[], subject: string, predicate: string, object: string): boolean {
  return quads.some((quad) => quad.subject.value === subject
    && quad.predicate.value === predicate
    && quad.object.value === object);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
