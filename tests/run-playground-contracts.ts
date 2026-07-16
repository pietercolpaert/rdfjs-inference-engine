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
  const directories = readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(EXAMPLES, entry.name, 'ontology.n3')))
    .map((entry) => entry.name)
    .sort();

  assert.equal(directories.length, 14, 'Expected all fourteen repository examples in the playground contract suite.');

  let messages = 0;
  for (const name of directories) {
    const directory = join(EXAMPLES, name);
    const inputPath = join(directory, 'input.messages.trig');
    const shaclInPath = join(directory, 'shapes-in.n3');
    const shaclOutPath = join(directory, 'shapes-out.n3');
    assert.ok(existsSync(inputPath), `${name} must use input.messages.trig.`);
    assert.ok(existsSync(shaclInPath), `${name} must provide shapes-in.n3.`);
    assert.ok(existsSync(shaclOutPath), `${name} must provide shapes-out.n3.`);

    const input = parseRdfOrMessages(readFileSync(inputPath, 'utf8'));
    assert.ok(input.isMessages && input.messages.length > 0, `${name} input must parse as an RDF Message log.`);
    messages += input.messages.length;

    const reasoner = new InferenceEngine();
    reasoner.load(
      loadDefaultRuleProfiles(),
      parseToQuads(readFileSync(join(directory, 'ontology.n3'), 'utf8')),
      {
        shaclIn: parseToQuads(readFileSync(shaclInPath, 'utf8')),
        shaclOut: parseToQuads(readFileSync(shaclOutPath, 'utf8')),
        // Keep the complete OWL/SKOS runtime for this complex restriction fixture.
        // SHACL input pruning and output projection remain enabled.
        selectRuntimeRules: name === 'shipment-logistics' ? false : undefined,
      },
    );
    const output = input.messages.flatMap((message) => Array.from(reasoner.infer(message)));

    const expectedFile = expectedOutputs[name];
    if (expectedFile) {
      const expected = parseRdfOrMessages(readFileSync(join(directory, expectedFile), 'utf8')).quads;
      assertContains(output, expected, `${name} shape-guided output`);
    }
  }

  console.log(`Playground contracts: ${directories.length} examples and ${messages} RDF Messages verified.`);
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
