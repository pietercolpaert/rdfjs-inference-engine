import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quad } from '@rdfjs/types';
import { Parser } from 'rdf-parser-ts';
import { InferenceEngine, loadDefaultRuleProfiles } from '../src';

const GENID_PREFIX = 'https://eyereasoner.github.io/.well-known/genid/';
const INCONSISTENCIES = 'https://www.pieter.pm/rdfjs-inference-engine/ns/inconsistencies#';
const INTERNAL = 'https://www.pieter.pm/rdfjs-inference-engine/ns/internal#';

const ontology = readFileSync('tests/fixtures/stateful-skolem-ontology.n3', 'utf8');
const messagesSource = readFileSync('tests/fixtures/stateful-skolem-messages.trig', 'utf8');
const background = Array.from(new Parser().parse(ontology) as Iterable<Quad>);
const messages = parseMessages(messagesSource);
const reasoner = new InferenceEngine();
reasoner.load(loadDefaultRuleProfiles(), background);

const storePath = mkdtempSync(join(tmpdir(), 'rdfjs-stateful-skolem-'));

async function main(): Promise<void> {
  try {
    assert.equal(messages.length, 10, 'Expected ten RDF Messages including empty messages.');
    assert.equal(messages[0].length, 1, 'Expected the first message to type :x as :B.');
    assert.equal(messages[9].length, 1, 'Expected the final message to type :x as :A.');

    const perMessage: Array<{ inputQuads: number; outputQuads: number; inconsistencies: number }> = [];
    let finalInconsistencyRules: string[] = [];
    let finalInconsistencyTerms: string[] = [];
    let finalOutput: Quad[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const inference = await reasoner.inferAsyncWithDiagnostics(messages[index], {
        store: {
          name: 'stateful-skolemization-regression',
          path: storePath,
          clear: index === 0,
        },
      });
      perMessage.push({
        inputQuads: messages[index].length,
        outputQuads: inference.quads.length,
        inconsistencies: inference.inconsistencies.length,
      });
      if (index === messages.length - 1) {
        finalOutput = inference.quads;
        finalInconsistencyRules = inference.inconsistencies.map((report) => report.rule ?? '');
        finalInconsistencyTerms = inference.inconsistencies.flatMap((report) => report.terms.map((term) => term.value));
      }
    }

    for (let index = 1; index < 9; index += 1) {
      assert.equal(
        perMessage[index].outputQuads,
        0,
        `Empty message ${index + 1} should not mint a fresh Skolemized closure. Report: ${JSON.stringify(perMessage)}`,
      );
    }

    const totalOutput = perMessage.reduce((sum, message) => sum + message.outputQuads, 0);
    assert.ok(totalOutput <= 30, `Expected bounded stateful output, got ${totalOutput}: ${JSON.stringify(perMessage)}`);
    assert.ok(perMessage[9].outputQuads <= 10, `Expected bounded final inconsistency output: ${JSON.stringify(perMessage)}`);
    assert.equal(perMessage[9].inconsistencies, 1, `Expected only the public disjointness inconsistency: ${JSON.stringify(perMessage)}`);
    assert.deepEqual(finalInconsistencyRules, ['https://www.pieter.pm/rdfjs-inference-engine/ns/inconsistencies#cax-dw']);
    assert.ok(
      finalOutput.some((quad) => quad.predicate.value === RDF_TYPE
        && quad.object.value === INCONSISTENCIES + 'Inconsistency'),
      'Expected the inferred RDF output to contain an inconsistency resource.',
    );
    assert.ok(
      finalOutput.some((quad) => quad.predicate.value === INCONSISTENCIES + 'rule'
        && quad.object.value === INCONSISTENCIES + 'cax-dw'),
      'Expected the inferred RDF output to identify the cax-dw rule.',
    );
    assert.equal(
      finalOutput.filter((quad) => quad.predicate.value.startsWith(INCONSISTENCIES + 'term')).length,
      3,
      'Expected three ordered evidence terms in the cax-dw RDF report.',
    );
    assert.ok(
      finalOutput.every((quad) => !quad.predicate.value.startsWith(INTERNAL)),
      'Internal rule-maintenance predicates must remain filtered from application output.',
    );
    assert.ok(
      finalInconsistencyTerms.every((value) => !value.startsWith(GENID_PREFIX)),
      `Expected public inconsistency terms only, got ${JSON.stringify(finalInconsistencyTerms)}`,
    );

    const firstRunSkolems = await firstMessageSkolemTerms('stateful-skolemization-stability');
    const secondRunSkolems = await firstMessageSkolemTerms('stateful-skolemization-stability');
    assert.deepEqual(secondRunSkolems, firstRunSkolems, 'Skolem IRIs should be stable for the same tuple and store key.');

    const otherStoreSkolems = await firstMessageSkolemTerms('stateful-skolemization-other-store');
    assert.notDeepEqual(otherStoreSkolems, firstRunSkolems, 'Different store keys should produce different Skolem IRIs.');

    console.log(`Stateful skolemization test: ${messages.length} messages emitted ${totalOutput} inferred quad(s).`);
  } finally {
    rmSync(storePath, { recursive: true, force: true });
  }
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function parseMessages(source: string): Quad[][] {
  const parser = new Parser({ rdfMessages: true });
  const messages: Quad[][] = [];
  for (const item of parser.parse(source) as Iterable<any>) {
    while (messages.length <= item.messageCounter) {
      messages.push([]);
    }
    messages[item.messageCounter].push(item.quad as Quad);
  }
  return messages;
}

async function firstMessageSkolemTerms(storeName: string): Promise<string[]> {
  const quads = await reasoner.inferAsync(messages[0], {
    outputMode: 'conformance',
    store: {
      name: storeName,
      path: storePath,
      clear: true,
    },
  });
  return Array.from(new Set(quads.flatMap(skolemTerms))).sort();
}

function skolemTerms(quad: Quad): string[] {
  return [quad.subject, quad.predicate, quad.object, quad.graph]
    .map((term) => term.termType !== 'DefaultGraph' && term.value.startsWith(GENID_PREFIX) ? term.value : '')
    .filter(Boolean);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
