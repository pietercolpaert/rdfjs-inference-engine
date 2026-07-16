import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InferenceEngine } from '../../src';
import { parseToQuads, writeQuads } from '../util';

async function main(): Promise<void> {
  const ontology = parseToQuads(readFileSync('examples/transit-fleet/ontology.n3', 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(ontology);
  mkdirSync(dirname('generated/transit-fleet-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/transit-fleet-runtime.n3');

  const data = parseToQuads(readFileSync('examples/transit-fleet/input.messages.trig', 'utf8'));
  const inferred = reasoner.infer(data);

  const output = await writeQuads(inferred, { '': 'https://example.org/transit#' });

  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
