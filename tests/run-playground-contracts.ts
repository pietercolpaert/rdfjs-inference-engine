import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Quad } from '@rdfjs/types';
import { InferenceEngine, loadDefaultRuleProfiles } from '../src';
import { parseRdfOrMessages, parseToQuads } from '../examples/util';
import { quadKey } from './utils';

const EXAMPLES = 'examples';
const expectedOutputs: Record<string, string> = {
  'owl-skos-catalog': 'expected-selected-output.n3',
  'shipment-logistics': 'expected-selected-output.n3',
  'skos-taxonomy': 'expected-selected-output.n3',
  'transit-fleet': 'expected-output.n3',
  'transit-messages': 'expected-output.messages.nq',
};

async function main(): Promise<void> {
  const directories = discoverExamples(EXAMPLES).sort();

  assert.equal(directories.length, 17, 'Both playgrounds must include the fourteen original and three mapping examples.');

  let messages = 0;
  for (const directory of directories) {
    const name = directory.split('/').at(-1)!;
    const inputPath = fixture(directory, ['input.messages.trig', 'input.ttl']);
    const shaclInPath = fixture(directory, ['shapes-in.n3', 'shapes-in.ttl']);
    const shaclOutPath = fixture(directory, ['shapes-out.n3', 'shapes-out.ttl']);

    const input = parseRdfOrMessages(readFileSync(inputPath, 'utf8'));
    const inputMessages = input.isMessages ? input.messages : [input.quads];
    assert.ok(inputMessages.length > 0, `${name} must provide input data.`);
    messages += inputMessages.length;

    const reasoner = new InferenceEngine();
    reasoner.load(
      loadDefaultRuleProfiles(),
      parseToQuads(readFileSync(fixture(directory, ['ontology.n3', 'ontology.ttl']), 'utf8')),
      {
        shaclIn: parseToQuads(readFileSync(shaclInPath, 'utf8')),
        shaclOut: parseToQuads(readFileSync(shaclOutPath, 'utf8')),
        // Keep the complete OWL/SKOS runtime for this complex restriction fixture.
        // SHACL input pruning and output projection remain enabled.
        selectRuntimeRules: name === 'shipment-logistics' ? false : undefined,
      },
    );
    const output = inputMessages.flatMap((message) => Array.from(reasoner.infer(message)));
    if (name === 'qudt-museum-dimensions') {
      assert.deepEqual(output.filter(q => q.predicate.value === 'http://qudt.org/schema/qudt/numericValue')
        .map(q => Number(q.object.value)), [0.32, 0.45, 1.2], 'The shared museum example also normalizes heights in the main playground.');
    }
    if (name === 'nde-amsterdam-photograph') {
      const expected = parseToQuads(readFileSync(join(directory, 'expected-output.messages.trig'), 'utf8'))
        .filter(q => q.predicate.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
      // The main playground projects inferred properties; the CONSTRUCT
      // projection additionally emits the consumer's target class.
      assertContains(output, expected, 'Shared NDE example, including Dutch language tags');
    }
    if (name === 'sensor-reading') {
      assert.ok(output.some(q => q.predicate.value === 'https://example.org/value' && q.object.value === '18.4'), 'The shared sensor example maps temperature in the main playground.');
    }

    const expectedFile = expectedOutputs[name];
    if (expectedFile) {
      const expected = parseRdfOrMessages(readFileSync(join(directory, expectedFile), 'utf8')).quads;
      assertContains(output, expected, `${name} shape-guided output`);
    }
  }

  console.log(`Playground contracts: ${directories.length} shared examples and ${messages} input messages verified.`);
  await checkLanguageTags();
}

async function checkLanguageTags(): Promise<void> {
  const input = parseToQuads(`
@prefix ex: <urn:language:> .
_:photo ex:title "A quoted \\"title\\""@nl .
ex:second ex:title "Hello"@en-US .
ex:third ex:title "Plain @nl" .
ex:fourth ex:title ex:identifier .`);
  const engine = new InferenceEngine({ runtime: '{ ?s <urn:language:title> ?v } => { ?s <urn:language:name> ?v } .' });
  for (const output of [Array.from(engine.infer(input)), engine.inferWithDiagnostics(input).quads,
    await engine.inferAsync(input), (await engine.inferAsyncWithDiagnostics(input)).quads]) {
    assert.equal(output.length, input.length);
    for (const quad of input) {
      assert.ok(output.some(result => result.subject.equals(quad.subject) && result.object.equals(quad.object)),
        'Sync and async inference preserve literal language, escaping, ordinary terms and blank-node identity.');
    }
  }
}

function fixture(directory: string, names: string[]): string {
  const path = names.map(name => join(directory, name)).find(path => existsSync(path));
  assert.ok(path, `${directory} must provide ${names.join(' or ')}.`);
  return path;
}

function discoverExamples(directory: string): string[] {
  if (['ontology.n3', 'ontology.ttl'].some(file => existsSync(join(directory, file)))) return [directory];
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'src')
    .flatMap(entry => discoverExamples(join(directory, entry.name)));
}

function assertContains(actual: Quad[], expected: Quad[], label: string): void {
  const keys = new Set(actual.map(quadKey));
  const missing = expected.filter((quad) => !keys.has(quadKey(quad)));
  assert.equal(missing.length, 0, `${label} missed ${missing.length} expected quad(s):\n${missing.map(quadKey).join('\n')}\nActual:\n${actual.map(quadKey).join('\n')}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
