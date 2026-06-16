import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InferenceEngine } from '../../src';
import { parseToQuads, writeQuads } from '../util';

const exampleDir = 'examples/shacl-shape-planning';
const args = new Set(process.argv.slice(2));
const useShapes = !args.has('--no-shapes');
const saveRuntime = args.has('--save-runtime');

async function main(): Promise<void> {
  const ontology = parseToQuads(readFileSync(join(exampleDir, 'ontology.n3'), 'utf8'));
  const input = parseToQuads(readFileSync(join(exampleDir, 'input.trig'), 'utf8'));
  const shaclIn = parseToQuads(readFileSync(join(exampleDir, 'shapes-in.n3'), 'utf8'));
  const shaclOut = parseToQuads(readFileSync(join(exampleDir, 'shapes-out.n3'), 'utf8'));

  const reasoner = new InferenceEngine();
  reasoner.load(ontology, useShapes ? { shaclIn, shaclOut } : {});

  if (saveRuntime) {
    writeFileSync('generated/shacl-shape-planning-runtime.n3', reasoner.getRuntime(), 'utf8');
  }

  const planning = reasoner.getShapePlanning();
  if (planning) {
    console.error(`Shape planning enabled: input predicates=${planning.relevantInputPredicates.length}, output predicates=${planning.relevantOutputPredicates.length}, classes=${planning.relevantClasses.length}`);
    console.error(`Input paths: ${planning.input?.pathTexts.join(' | ') ?? 'none'}`);
    console.error(`Output paths: ${planning.output?.pathTexts.join(' | ') ?? 'none'}`);
  } else {
    console.error('Shape planning disabled. Pass no --no-shapes flag to enable the SHACL in/out hints.');
  }

  const inferred = Array.from(reasoner.infer(input));
  const inputOptimization = reasoner.getLastInputOptimization();
  if (inputOptimization) {
    console.error(`Input optimization: ${inputOptimization.originalQuadCount} input quad(s) -> ${inputOptimization.optimizedQuadCount} optimized quad(s), compact records=${inputOptimization.compactRecords.length}`);
    console.error(`Temporary indexes: ${inputOptimization.indexesBuilt.map((index) => `${index.kind}${index.predicate ? `(${index.predicate})` : ''}`).join(', ') || 'none'}`);
  }
  process.stdout.write(await writeQuads(inferred, {
    ex: 'https://example.org/shape-planning#',
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    sosa: 'http://www.w3.org/ns/sosa/',
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
