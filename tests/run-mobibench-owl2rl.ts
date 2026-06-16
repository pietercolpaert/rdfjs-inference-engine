import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import type { Quad } from '@rdfjs/types';
import { InferenceEngine } from '../src';
import { addReflexiveSameAsClosure, graphContainsAll, parseRdf, readCachedBinaryUrl } from './utils';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const OWLRL = 'https://example.org/owlrl-n3#';
const DEFAULT_ARCHIVE_URL = 'https://william-vw.github.io/mobibench/web/res/owl/conf/testsuite-owl2-rdfbased.zip';
const DEFAULT_CACHE_PATH = '.cache/mobibench/testsuite-owl2-rdfbased.zip';
const OWL2RL_SUBSUITE_PREFIX = 'testsuite-owl2-rdfbased/subsuites/owl2rl/';

type TestKind = 'positive' | 'inconsistency';

interface MobiBenchCase {
  id: string;
  kind: TestKind;
  description: string;
  premise?: string;
  conclusion?: string;
  graph?: string;
}

interface TestResult {
  id: string;
  kind: TestKind;
  ok: boolean;
  error?: string;
}

interface ParsedArgs {
  list: boolean;
  archiveUrl: string;
  cachePath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const archive = new AdmZip(await readCachedBinaryUrl(args.archiveUrl, args.cachePath));
  const tests = extractRunnableCases(archive);

  if (args.list) {
    for (const test of tests) {
      console.log(`${test.kind}\t${test.id}\t${oneLine(test.description)}`);
    }
    return;
  }

  if (tests.length === 0) {
    throw new Error('No runnable MobiBench OWL2 RL tests discovered. Use --list to inspect the archive.');
  }

  const profile = readFileSync('rules/owl2rl-eyeling.n3', 'utf8');
  const outputMode = 'conformance';
  const prepared = new InferenceEngine({ outputMode });
  prepared.load(profile, [], { selectRuntimeRules: false });
  const runtime = prepared.getRuntime();
  const staticClosure = prepared.getStaticClosure({ outputMode });

  const results: TestResult[] = [];
  for (const test of tests) {
    try {
      const premise = parseRdf(test.premise ?? test.graph ?? '');
      const reasoner = new InferenceEngine({ runtime, outputMode });
      const inference = reasoner.inferWithDiagnostics(premise, { outputMode });
      const diagnosticQuads = inference.inconsistencies.flatMap((report) => report.quads);
      const rawClosure = [...staticClosure, ...premise, ...inference.quads, ...diagnosticQuads];
      const closure = outputMode === 'conformance' ? addReflexiveSameAsClosure(rawClosure) : rawClosure;
      const ok = evaluateTest(test, closure);

      results.push({ id: test.id, kind: test.kind, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${test.kind} ${test.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: test.id, kind: test.kind, ok: false, error: message });
      console.log(`ERROR ${test.kind} ${test.id}: ${message}`);
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`MobiBench OWL2 RL tests: ${passed}/${results.length} passed.`);

  if (failed > 0) {
    throw new Error(`${failed} MobiBench OWL2 RL test(s) failed.`);
  }
}

function evaluateTest(test: MobiBenchCase, closure: Quad[]): boolean {
  if (test.kind === 'positive') {
    return graphContainsAll(closure, parseRdf(test.conclusion ?? ''));
  }

  return hasInconsistencyDiagnostic(closure);
}

function extractRunnableCases(archive: AdmZip): MobiBenchCase[] {
  const entries = new Map(archive.getEntries().map((entry) => [entry.entryName, entry]));
  const cases: MobiBenchCase[] = [];

  for (const entry of archive.getEntries()) {
    if (!entry.entryName.startsWith(OWL2RL_SUBSUITE_PREFIX) || !entry.entryName.endsWith('.metadata.properties')) {
      continue;
    }

    const directory = entry.entryName.slice(0, entry.entryName.lastIndexOf('/'));
    const id = directory.slice(directory.lastIndexOf('/') + 1);
    const metadata = parseMetadata(entry.getData().toString('utf8'));
    const kind = testKind(metadata['testcase.type']);

    if (!kind) {
      continue;
    }

    const premise = readZipText(entries, `${directory}/${id}.premisegraph.ttl`);
    const conclusion = readZipText(entries, `${directory}/${id}.conclusiongraph.ttl`);
    const graph = readZipText(entries, `${directory}/${id}.graph.ttl`);

    if (kind === 'positive' && premise && conclusion) {
      cases.push({ id, kind, description: metadata['testcase.description'] ?? '', premise, conclusion });
    } else if (kind === 'inconsistency' && graph) {
      cases.push({ id, kind, description: metadata['testcase.description'] ?? '', graph });
    }
  }

  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

function hasInconsistencyDiagnostic(quads: Quad[]): boolean {
  return quads.some((quad) => (
    quad.predicate.value === RDF + 'type'
    && quad.object.termType === 'NamedNode'
    && quad.object.value === OWLRL + 'Inconsistency'
  ));
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    list: false,
    archiveUrl: process.env.MOBIBENCH_OWL2RL_ARCHIVE_URL ?? DEFAULT_ARCHIVE_URL,
    cachePath: process.env.MOBIBENCH_OWL2RL_CACHE ?? DEFAULT_CACHE_PATH,
  };

  for (const arg of args) {
    if (arg === '--all') {
      continue;
    } else if (arg === '--list') {
      parsed.list = true;
    } else if (arg.startsWith('--archive=')) {
      parsed.archiveUrl = arg.slice('--archive='.length);
    } else if (arg.startsWith('--cache=')) {
      parsed.cachePath = arg.slice('--cache='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function testKind(value: string | undefined): TestKind | undefined {
  if (value === 'POSITIVE_ENTAILMENT') {
    return 'positive';
  }
  if (value === 'INCONSISTENCY') {
    return 'inconsistency';
  }
  return undefined;
}

function parseMetadata(source: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const match of source.matchAll(/<entry key="([^"]+)">([\s\S]*?)<\/entry>/g)) {
    metadata[match[1]] = decodeXml(match[2]);
  }
  return metadata;
}

function readZipText(entries: Map<string, AdmZip.IZipEntry>, path: string): string | undefined {
  return entries.get(path)?.getData().toString('utf8');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});