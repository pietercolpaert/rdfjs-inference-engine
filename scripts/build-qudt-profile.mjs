import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Parser } from 'rdf-parser-ts';
import { InferenceEngine } from '../dist/src/index.js';

const QUDT_URL = 'https://qudt.org/qudt-all';
const PROFILE_PATH = resolve('rules/qudt/qudt-cdt-normalization.n3');
const OUTPUT_PATH = resolve('rules/qudt/qudt-cdt-normalization.runtime.n3');
const sourceArgument = process.argv.indexOf('--source');

const qudtSource = sourceArgument >= 0
  ? await readFile(resolve(process.argv[sourceArgument + 1]), 'utf8')
  : await downloadQudt();
const sourceHash = argumentValue('--source-hash') ?? createHash('sha256').update(qudtSource).digest('hex');
const sourceLabel = argumentValue('--source-label')
  ?? /rdfs:label\s+"([^"]*QUDT[^"\n]*)"/.exec(qudtSource)?.[1]
  ?? 'QUDT';
const qudtQuads = Array.from(new Parser().parse(qudtSource) ?? []);
const runtimeQuads = selectNormalizationQuads(qudtQuads);
const sourceStatementCount = Number(argumentValue('--source-statements') ?? qudtQuads.length);
const projectedStatementCount = Number(argumentValue('--projected-statements') ?? runtimeQuads.length);
const profileN3 = await readFile(PROFILE_PATH, 'utf8');
const engine = new InferenceEngine();

engine.load({ n3: profileN3, label: 'rules/qudt/qudt-cdt-normalization.n3' }, runtimeQuads, { selectRuntimeRules: false });

const header = [
  '# Generated QUDT/CDT normalization runtime. Do not edit by hand.',
  `# Source: ${QUDT_URL} (${sourceLabel})`,
  `# Source SHA-256: ${sourceHash}`,
  `# Projected ${projectedStatementCount}/${sourceStatementCount} QUDT statements used by the normalization profile.`,
  '# QUDT is licensed under CC BY 4.0; attribution: QUDT.org.',
  '',
].join('\n');

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, header + engine.getRuntime(), 'utf8');
console.log(`Wrote ${OUTPUT_PATH} from ${runtimeQuads.length} relevant QUDT statements.`);

async function downloadQudt() {
  const response = await fetch(QUDT_URL, { headers: { accept: 'text/turtle' } });
  if (!response.ok) {
    throw new Error(`Could not download ${QUDT_URL}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function selectNormalizationQuads(quads) {
  const qudt = 'http://qudt.org/schema/qudt/';
  const predicates = new Set([
    'conversionMultiplier',
    'conversionOffset',
    'expression',
    'hasDimensionVector',
    'symbol',
    'ucumCode',
  ].map((name) => qudt + name));
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const logarithmicUnit = qudt + 'LogarithmicUnit';

  return quads.filter((quad) => predicates.has(quad.predicate.value)
    || (quad.predicate.value === rdfType && quad.object.value === logarithmicUnit));
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
