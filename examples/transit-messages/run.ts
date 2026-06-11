import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InferenceEngine } from '../../src';
import { parseRdfOrMessages, parseToQuads, writeMessages } from '../util';

async function main(): Promise<void> {
  const ontology = parseToQuads(readFileSync('examples/transit-messages/ontology.n3', 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(ontology);
  mkdirSync(dirname('generated/transit-messages-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/transit-messages-runtime.n3');

  const input = parseRdfOrMessages(readFileSync('examples/transit-messages/input.messages.trig', 'utf8'));
  if (!input.isMessages) {
    throw new Error('Expected RDF Messages input.');
  }

  const inferredMessages = input.messages.map((message) => Array.from(reasoner.infer(message)));
  const output = await writeMessages(inferredMessages, { '': 'https://example.org/transit#' });

  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
