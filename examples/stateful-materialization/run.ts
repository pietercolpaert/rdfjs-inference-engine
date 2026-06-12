import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Quad } from '@rdfjs/types';
import { InferenceEngine } from '../../src';
import { parseRdfOrMessages, parseToQuads, writeMessages } from '../util';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const FAMILY = 'https://example.org/family#';
const SELECTED_TYPES = new Set([FAMILY + 'Parent', FAMILY + 'Mother']);

async function main(): Promise<void> {
  const statefulMaterialization = process.argv.includes('--stateful-materialization');
  const ontologyPath = 'examples/stateful-materialization/ontology.n3';
  const inputPath = 'examples/stateful-materialization/input.messages.trig';
  const ontology = parseToQuads(readFileSync(ontologyPath, 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(ontology);
  mkdirSync(dirname('generated/stateful-materialization-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/stateful-materialization-runtime.n3');

  const input = parseRdfOrMessages(readFileSync(inputPath, 'utf8'));
  if (!input.isMessages) {
    throw new Error('Expected RDF Messages input.');
  }

  const stateStore = createStateStoreOptions(ontologyPath, inputPath);
  const resumeStorage = process.argv.includes('--resume-storage');
  const inferredMessages: Quad[][] = [];
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    const delta = statefulMaterialization
      ? await reasoner.inferAsync(message, {
          store: {
            name: stateStore.name,
            path: stateStore.path,
            clear: index === 0 && !resumeStorage,
          },
        })
      : Array.from(reasoner.infer(message));
    inferredMessages.push(delta.filter(isSelectedOutput));
  }

  const output = await writeMessages(inferredMessages, { '': FAMILY });

  process.stdout.write(output);
}

function createStateStoreOptions(ontologyPath: string, inputPath: string): { name: string; path: string } {
  const explicitName = readArgValue('--storage-name');
  const storagePath = readArgValue('--storage-path') ?? '.cache/eyeling-stores';
  if (explicitName) {
    return { name: explicitName, path: storagePath };
  }

  const datasetKey = [process.cwd(), resolve(ontologyPath), resolve(inputPath)].join('\0');
  const digest = createHash('sha256').update(datasetKey).digest('hex').slice(0, 16);
  return {
    name: `rdfjs-inference-engine:stateful-materialization:${digest}`,
    path: storagePath,
  };
}

function readArgValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) {
    return match.slice(prefix.length);
  }

  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isSelectedOutput(quad: Quad): boolean {
  return quad.subject.termType === 'NamedNode'
    && quad.subject.value === FAMILY + 'alice'
    && quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && SELECTED_TYPES.has(quad.object.value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
