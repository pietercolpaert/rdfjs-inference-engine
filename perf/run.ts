import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Quad } from '@rdfjs/types';
import { InferenceEngine, serializeQuadsAsN3 } from '../src';
import { parseRdfOrMessages, parseToQuads } from '../examples/util';

interface BenchmarkInput {
  ontology: Quad[];
  data: Quad[];
}

interface BenchmarkCase {
  id: string;
  label: string;
  description: string;
  load: () => BenchmarkInput;
}

interface Reasoner {
  id: string;
  label: string;
  kind: 'native' | 'external';
  availability: () => Availability;
  run: (testCase: BenchmarkCase, input: BenchmarkInput, context: RunContext) => SingleRunResult;
}

interface Availability {
  available: boolean;
  reason?: string;
}

interface SingleRunResult {
  loadMs?: number;
  inferMs?: number;
  parseMs?: number;
  totalMs: number;
  outputQuads?: number;
  closureQuads?: number;
  runtimeBytes?: number;
}

interface RunContext {
  timeoutMs: number;
  cacheDir: string;
}

interface SampleSummary {
  min: number;
  median: number;
  max: number;
}

interface BenchmarkResult {
  caseId: string;
  caseLabel: string;
  reasonerId: string;
  reasonerLabel: string;
  status: 'ok' | 'skipped' | 'failed';
  error?: string;
  samples?: SingleRunResult[];
  totalMs?: SampleSummary;
  loadMs?: SampleSummary;
  inferMs?: SampleSummary;
  outputQuads?: number;
  closureQuads?: number;
  runtimeBytes?: number;
}

interface ParsedArgs {
  cases?: Set<string>;
  reasoners?: Set<string>;
  iterations: number;
  warmup: number;
  timeoutMs: number;
  list: boolean;
  json: boolean;
  csv: boolean;
}

const DEFAULT_ITERATIONS = 3;
const DEFAULT_WARMUP = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const CACHE_DIR = resolve('.cache/perf');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = benchmarkCases();
  const reasoners = benchmarkReasoners();

  if (args.list) {
    printInventory(cases, reasoners);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const selectedCases = cases.filter((testCase) => !args.cases || args.cases.has(testCase.id));
  const selectedReasoners = reasoners.filter((reasoner) => !args.reasoners || args.reasoners.has(reasoner.id));

  if (selectedCases.length === 0) {
    throw new Error('No performance cases selected. Use --list to inspect available case identifiers.');
  }
  if (selectedReasoners.length === 0) {
    throw new Error('No performance reasoners selected. Use --list to inspect available reasoner identifiers.');
  }

  const context: RunContext = { timeoutMs: args.timeoutMs, cacheDir: CACHE_DIR };
  const results: BenchmarkResult[] = [];

  for (const testCase of selectedCases) {
    const input = testCase.load();
    for (const reasoner of selectedReasoners) {
      results.push(runBenchmark(testCase, input, reasoner, context, args));
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ iterations: args.iterations, warmup: args.warmup, timeoutMs: args.timeoutMs, results }, null, 2));
  } else if (args.csv) {
    printCsv(results);
  } else {
    printTable(results, args);
  }

  const nativeFailure = results.find((result) => result.reasonerId === 'rdfjs-inference-engine' && result.status === 'failed');
  if (nativeFailure) {
    throw new Error(`Native performance run failed for ${nativeFailure.caseId}: ${nativeFailure.error ?? 'unknown error'}`);
  }
}

function runBenchmark(testCase: BenchmarkCase, input: BenchmarkInput, reasoner: Reasoner, context: RunContext, args: ParsedArgs): BenchmarkResult {
  const availability = reasoner.availability();
  if (!availability.available) {
    return {
      caseId: testCase.id,
      caseLabel: testCase.label,
      reasonerId: reasoner.id,
      reasonerLabel: reasoner.label,
      status: 'skipped',
      error: availability.reason ?? 'not available',
    };
  }

  const samples: SingleRunResult[] = [];
  try {
    for (let index = 0; index < args.warmup + args.iterations; index += 1) {
      const sample = reasoner.run(testCase, input, context);
      if (index >= args.warmup) {
        samples.push(sample);
      }
    }
  } catch (error) {
    return {
      caseId: testCase.id,
      caseLabel: testCase.label,
      reasonerId: reasoner.id,
      reasonerLabel: reasoner.label,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    caseId: testCase.id,
    caseLabel: testCase.label,
    reasonerId: reasoner.id,
    reasonerLabel: reasoner.label,
    status: 'ok',
    samples,
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
    loadMs: summarize(samples.map((sample) => sample.loadMs).filter(isNumber)),
    inferMs: summarize(samples.map((sample) => sample.inferMs).filter(isNumber)),
    outputQuads: samples.at(-1)?.outputQuads,
    closureQuads: samples.at(-1)?.closureQuads,
    runtimeBytes: samples.at(-1)?.runtimeBytes,
  };
}

function benchmarkCases(): BenchmarkCase[] {
  return [
    {
      id: 'mobibench-subclass-chain',
      label: 'MobiBench-style subclass chain',
      description: 'Synthetic OWL 2 RL/RDFS subclass-transitivity workload inspired by benchmark micro-cases.',
      load: () => generatedSubclassChain(100),
    },
    {
      id: 'mobibench-property-chain',
      label: 'MobiBench-style property chains',
      description: 'Synthetic OWL 2 RL property-chain workload with many list-backed chain applications.',
      load: () => generatedPropertyChains(250),
    },
    {
      id: 'transit-fleet',
      label: 'Transit fleet example',
      description: 'Small project OWL/RDFS example with subclass, domain, and range materialization.',
      load: () => fileCase('examples/transit-fleet/ontology.n3', 'examples/transit-fleet/input.trig'),
    },
    {
      id: 'shipment-logistics',
      label: 'Shipment logistics example',
      description: 'Project OWL/RDFS logistics example.',
      load: () => fileCase('examples/shipment-logistics/ontology.n3', 'examples/shipment-logistics/input.trig'),
    },
    {
      id: 'marc-list-messages',
      label: 'MARC RDF-list messages',
      description: 'List-heavy MARC ontology and RDF Messages data regression workload.',
      load: () => fileCase('tests/fixtures/marc-list-ontology.n3', 'tests/fixtures/marc-list-messages.trig'),
    },
  ];
}

function benchmarkReasoners(): Reasoner[] {
  return [
    rdfjsReasoner(),
    pythonOwlrlReasoner(),
    ...externalCommandReasoners(),
  ];
}

function rdfjsReasoner(): Reasoner {
  return {
    id: 'rdfjs-inference-engine',
    label: 'rdfjs-inference-engine / Eyeling runtime',
    kind: 'native',
    availability: () => ({ available: true }),
    run: (_testCase, input) => {
      const reasoner = new InferenceEngine();
      const loadStart = performance.now();
      reasoner.load(input.ontology);
      const loadMs = performance.now() - loadStart;

      const inferStart = performance.now();
      const inferred = Array.from(reasoner.infer(input.data));
      const inferMs = performance.now() - inferStart;
      const closureQuads = uniqueQuads([...input.ontology, ...reasoner.getStaticClosure(), ...input.data, ...inferred]).length;

      return {
        loadMs,
        inferMs,
        totalMs: loadMs + inferMs,
        outputQuads: inferred.length,
        closureQuads,
        runtimeBytes: reasoner.getRuntime().length,
      };
    },
  };
}

function pythonOwlrlReasoner(): Reasoner {
  return {
    id: 'python-owlrl',
    label: 'Python owlrl / RDFLib',
    kind: 'external',
    availability: () => pythonAvailability('import rdflib, owlrl'),
    run: (testCase, input, context) => {
      const inputPath = writeMergedInput(testCase, input, context.cacheDir);
      const script = String.raw`
import json
import sys
import time
from rdflib import Graph
from owlrl import DeductiveClosure, OWLRL_Semantics

path = sys.argv[1]
parse_start = time.perf_counter()
graph = Graph()
graph.parse(path, format='n3')
parse_ms = (time.perf_counter() - parse_start) * 1000
before = len(graph)
infer_start = time.perf_counter()
DeductiveClosure(OWLRL_Semantics, rdfs_closure=True, axiomatic_triples=False, datatype_axioms=False).expand(graph)
infer_ms = (time.perf_counter() - infer_start) * 1000
print(json.dumps({
  'parseMs': parse_ms,
  'loadMs': 0,
  'inferMs': infer_ms,
  'totalMs': parse_ms + infer_ms,
  'outputQuads': max(0, len(graph) - before),
  'closureQuads': len(graph),
}))
`;
      const result = spawnSync(pythonExecutable(), ['-c', script, inputPath], {
        encoding: 'utf8',
        timeout: context.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return parseExternalJson(result, 'python-owlrl');
    },
  };
}

function externalCommandReasoners(): Reasoner[] {
  const raw = process.env.PERF_EXTERNAL_REASONERS;
  if (!raw) {
    return [];
  }

  let configured: Array<{ id?: string; label?: string; command?: string }>;
  try {
    configured = JSON.parse(raw) as Array<{ id?: string; label?: string; command?: string }>;
  } catch (error) {
    throw new Error(`PERF_EXTERNAL_REASONERS must be a JSON array: ${error instanceof Error ? error.message : String(error)}`);
  }

  return configured.map((entry, index): Reasoner => {
    if (!entry.id || !entry.command) {
      throw new Error(`PERF_EXTERNAL_REASONERS[${index}] must contain id and command.`);
    }
    const id = entry.id;
    const configuredCommand = entry.command;

    return {
      id,
      label: entry.label ?? id,
      kind: 'external',
      availability: () => ({ available: true }),
      run: (testCase, input, context) => {
        const inputPath = writeMergedInput(testCase, input, context.cacheDir);
        const outputPath = resolve(context.cacheDir, `${safeName(testCase.id)}-${safeName(id)}.out`);
        const command = configuredCommand
          .replaceAll('{input}', shellQuote(inputPath))
          .replaceAll('{rules}', shellQuote(resolve('rules/owl2rl-eyeling.n3')))
          .replaceAll('{output}', shellQuote(outputPath));
        const start = performance.now();
        const result = spawnSync(command, {
          encoding: 'utf8',
          shell: true,
          timeout: context.timeoutMs,
          maxBuffer: 128 * 1024 * 1024,
        });
        const totalMs = performance.now() - start;
        if (result.error) {
          throw result.error;
        }
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || `${id} exited with status ${result.status}`);
        }
        return {
          totalMs,
          inferMs: totalMs,
          outputQuads: countParsedQuads(result.stdout),
        };
      },
    };
  });
}

function fileCase(ontologyPath: string, dataPath: string): BenchmarkInput {
  const ontology = parseToQuads(readFileSync(ontologyPath, 'utf8'));
  const parsedData = parseRdfOrMessages(readFileSync(dataPath, 'utf8'));
  return { ontology, data: parsedData.quads };
}

function generatedSubclassChain(length: number): BenchmarkInput {
  const ontologyLines = [
    '@prefix : <https://example.org/perf/subclass#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  ];
  for (let index = 0; index < length; index += 1) {
    ontologyLines.push(`:C${index} rdfs:subClassOf :C${index + 1} .`);
  }

  const data = `
@prefix : <https://example.org/perf/subclass#> .
:x a :C0 .
`;
  return { ontology: parseToQuads(ontologyLines.join('\n')), data: parseToQuads(data) };
}

function generatedPropertyChains(count: number): BenchmarkInput {
  const ontology = `
@prefix : <https://example.org/perf/chain#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
:p owl:propertyChainAxiom (:p1 :p2 :p3) .
`;
  const dataLines = ['@prefix : <https://example.org/perf/chain#> .'];
  for (let index = 0; index < count; index += 1) {
    dataLines.push(`:s${index} :p1 :m1_${index} .`);
    dataLines.push(`:m1_${index} :p2 :m2_${index} .`);
    dataLines.push(`:m2_${index} :p3 :o${index} .`);
  }
  return { ontology: parseToQuads(ontology), data: parseToQuads(dataLines.join('\n')) };
}

function writeMergedInput(testCase: BenchmarkCase, input: BenchmarkInput, cacheDir: string): string {
  mkdirSync(cacheDir, { recursive: true });
  const path = resolve(cacheDir, `${safeName(testCase.id)}.n3`);
  writeFileSync(path, `${serializeQuadsAsN3([...input.ontology, ...input.data])}\n`, 'utf8');
  return path;
}

function parseExternalJson(result: ReturnType<typeof spawnSync>, label: string): SingleRunResult {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString().trim() || result.stdout?.toString().trim() || `${label} exited with status ${result.status}`);
  }
  const stdout = result.stdout?.toString().trim() ?? '';
  try {
    return JSON.parse(stdout) as SingleRunResult;
  } catch (error) {
    throw new Error(`Could not parse ${label} JSON output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`);
  }
}

function pythonAvailability(importSnippet: string): Availability {
  const executable = pythonExecutable();
  const result = spawnSync(executable, ['-c', importSnippet], { encoding: 'utf8', timeout: 10_000 });
  if (result.status === 0) {
    return { available: true };
  }
  const details = [result.stderr, result.stdout]
    .map((value) => value?.toString().trim())
    .filter(Boolean)
    .join(' ');
  return { available: false, reason: `${executable} cannot import required modules${details ? `: ${details}` : ''}` };
}

function pythonExecutable(): string {
  if (process.env.PERF_PYTHON) {
    return process.env.PERF_PYTHON;
  }

  const localVirtualEnvironment = resolve('.venv/bin/python');
  if (existsSync(localVirtualEnvironment)) {
    return localVirtualEnvironment;
  }

  return 'python3';
}

function countParsedQuads(source: string): number | undefined {
  if (!source.trim()) {
    return 0;
  }
  try {
    return parseToQuads(source).length;
  } catch {
    return undefined;
  }
}

function uniqueQuads(quads: Iterable<Quad>): Quad[] {
  const unique: Quad[] = [];
  const seen = new Set<string>();
  for (const quad of quads) {
    const key = [quad.subject, quad.predicate, quad.object, quad.graph]
      .map((term) => `${term.termType}:${term.value}`)
      .join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(quad);
    }
  }
  return unique;
}

function summarize(values: number[]): SampleSummary | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    list: false,
    json: false,
    csv: false,
  };

  for (const arg of args) {
    if (arg === '--list') {
      parsed.list = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--csv') {
      parsed.csv = true;
    } else if (arg.startsWith('--case=')) {
      parsed.cases = new Set(splitCsvArg(arg.slice('--case='.length)));
    } else if (arg.startsWith('--reasoner=')) {
      parsed.reasoners = new Set(splitCsvArg(arg.slice('--reasoner='.length)));
    } else if (arg.startsWith('--iterations=')) {
      parsed.iterations = positiveInteger(arg, '--iterations=');
    } else if (arg.startsWith('--warmup=')) {
      parsed.warmup = nonNegativeInteger(arg, '--warmup=');
    } else if (arg.startsWith('--timeout=')) {
      parsed.timeoutMs = positiveInteger(arg, '--timeout=');
    } else {
      throw new Error(`Unknown perf option: ${arg}`);
    }
  }

  if (parsed.iterations < 1) {
    throw new Error('--iterations must be at least 1.');
  }

  return parsed;
}

function splitCsvArg(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function positiveInteger(arg: string, prefix: string): number {
  const value = Number.parseInt(arg.slice(prefix.length), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix} expects a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(arg: string, prefix: string): number {
  const value = Number.parseInt(arg.slice(prefix.length), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${prefix} expects a non-negative integer.`);
  }
  return value;
}

function printInventory(cases: BenchmarkCase[], reasoners: Reasoner[]): void {
  console.log('Performance cases:');
  for (const testCase of cases) {
    console.log(`  ${testCase.id}\t${testCase.label}\t${testCase.description}`);
  }

  console.log('\nReasoners:');
  for (const reasoner of reasoners) {
    const availability = reasoner.availability();
    console.log(`  ${reasoner.id}\t${availability.available ? 'available' : `skipped: ${availability.reason}`}\t${reasoner.label}`);
  }
}

function printTable(results: BenchmarkResult[], args: ParsedArgs): void {
  console.log(`Performance benchmark results (${args.iterations} iteration(s), ${args.warmup} warmup run(s), timeout ${args.timeoutMs} ms)`);
  console.log('case\treasoner\tstatus\ttotal median ms\tload median ms\tinfer median ms\toutput quads\tclosure quads\truntime bytes');
  for (const result of results) {
    console.log([
      result.caseId,
      result.reasonerId,
      result.status === 'ok' ? 'ok' : `${result.status}: ${result.error ?? ''}`,
      formatNumber(result.totalMs?.median),
      formatNumber(result.loadMs?.median),
      formatNumber(result.inferMs?.median),
      result.outputQuads ?? '',
      result.closureQuads ?? '',
      result.runtimeBytes ?? '',
    ].join('\t'));
  }
}

function printCsv(results: BenchmarkResult[]): void {
  console.log('case,reasoner,status,totalMedianMs,loadMedianMs,inferMedianMs,outputQuads,closureQuads,runtimeBytes,error');
  for (const result of results) {
    console.log([
      result.caseId,
      result.reasonerId,
      result.status,
      formatNumber(result.totalMs?.median),
      formatNumber(result.loadMs?.median),
      formatNumber(result.inferMs?.median),
      result.outputQuads ?? '',
      result.closureQuads ?? '',
      result.runtimeBytes ?? '',
      result.error ?? '',
    ].map(csvCell).join(','));
  }
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '' : value.toFixed(1);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
