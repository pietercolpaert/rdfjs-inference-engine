import assert from 'node:assert/strict';
import { Parser } from 'rdf-parser-ts';
import { InferenceEngine } from '../src';
import type { Quad } from '@rdfjs/types';

const parser = new Parser();
const rules = '@prefix : <http://example.org/> . { ?s :p ?o . } => { ?s :q ?o . } .';
const input = Array.from(parser.parse('<http://example.org/a> <http://example.org/p> <http://example.org/b> .') as Iterable<Quad>);

async function main(): Promise<void> {
  const reasoner = new InferenceEngine({ n3Reasoner: 'eyeron' });
  await reasoner.loadAsync(rules, []);
  const inferred = await reasoner.inferAsync(input);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].subject.value, 'http://example.org/a');
  assert.equal(inferred[0].predicate.value, 'http://example.org/q');
  assert.equal(inferred[0].object.value, 'http://example.org/b');
  console.log('Eyeron backend test passed.');
}

void main();
