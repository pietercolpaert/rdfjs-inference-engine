import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'rdf-parser-ts';
import { reasonStream, type RdfJsQuad } from 'eyeling';
import { parseRdfWithBase, readCachedUrl, termKey } from './utils';

const RAW_BASE = 'https://raw.githubusercontent.com/w3c/data-shapes/gh-pages/data-shapes-test-suite/tests/';
const CACHE_ROOT = resolve('.cache/shacl-test-suite');
const SHACL_RULES_PATH = resolve('rules/shacl-core-eyeling.n3');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const SH = 'http://www.w3.org/ns/shacl#';
const SHT = 'http://www.w3.org/ns/shacl-test#';
const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';

const MANIFESTS = [
  'core/targets/manifest.ttl',
  'core/node/manifest.ttl',
  'core/property/manifest.ttl',
  'core/path/manifest.ttl',
  'core/complex/manifest.ttl',
  'core/misc/manifest.ttl',
];

// Tests expected to be meaningful for the original curated N3 profile subset.
// The harness now runs every W3C SHACL Core test by default; pass --selected
// to run only this historical subset while debugging.
const SUPPORTED_TEST_FILE_NAMES = new Set([
  'targetNode-001.ttl',
  'targetClass-001.ttl',
  'targetClassImplicit-001.ttl',
  'targetSubjectsOf-001.ttl',
  'targetObjectsOf-001.ttl',
  'multipleTargets-001.ttl',
  'class-001.ttl',
  'class-003.ttl',
  'datatype-001.ttl',
  'datatype-002.ttl',
  'hasValue-001.ttl',
  'in-001.ttl',
  'maxExclusive-001.ttl',
  'maxInclusive-001.ttl',
  'maxLength-001.ttl',
  'minExclusive-001.ttl',
  'minExclusive-002.ttl',
  'minInclusive-001.ttl',
  'minInclusive-002.ttl',
  'minInclusive-003.ttl',
  'minLength-001.ttl',
  'pattern-001.ttl',
  'pattern-002.ttl',
  'minCount-001.ttl',
  'minCount-002.ttl',
  'maxCount-001.ttl',
  'maxCount-002.ttl',
]);

const KNOWN_LIMITATIONS = new Map<string, string>([
  ['core/complex/shacl-shacl.ttl', 'the partial sh:conforms check is true because the current profile emits no results, but complete SHACL-shapes validation needs recursive validation, closed shapes, boolean combinations, and full report comparison'],
  ['core/path/path-strange-001.ttl', 'the partial sh:conforms check currently matches, but complete SHACL property-path well-formedness validation is not implemented'],
  ['core/path/path-strange-002.ttl', 'the partial sh:conforms check currently matches, but complete SHACL property-path well-formedness validation is not implemented'],
  ['core/property/property-001.ttl', 'the partial sh:conforms check currently matches, but recursive sh:property validation through nested property shapes is not implemented'],
  ['core/property/uniqueLang-002.ttl', 'the expected sh:conforms value is true and the current profile emits no results, but sh:uniqueLang itself and boolean lexical handling for "1"^^xsd:boolean are not implemented'],
]);

interface CliOptions {
  all: boolean;
  manifests: string[];
  only: Set<string>;
  listKnownLimitations: boolean;
}

interface TestCase {
  id: string;
  filePath: string;
  fileUrl: string;
  entry: Term;
  quads: Quad[];
  dataRefs: Term[];
  shapesRefs: Term[];
  expectedConforms: boolean;
}

interface TestOutcome {
  test: TestCase;
  actualConforms: boolean;
  resultCount: number;
}

async function main(): Promise<void> {
  assert.ok(existsSync(SHACL_RULES_PATH), 'Expected rules/shacl-core-eyeling.n3 to exist.');

  const options = parseCliOptions(process.argv.slice(2));
  if (options.listKnownLimitations) {
    printKnownLimitations();
  }

  const testCases = await loadTestCases(options.manifests, options);
  const selected = testCases.filter((test) => shouldRunTest(test, options));
  const skipped = testCases.length - selected.length;

  const rules = readFileSync(SHACL_RULES_PATH, 'utf8');
  const outcomes: TestOutcome[] = [];
  const failures: string[] = [];

  for (const test of selected) {
    const dataAndShapes = await loadDataAndShapes(test);
    const outcome = runValidation(rules, test, dataAndShapes);
    outcomes.push(outcome);

    if (outcome.actualConforms !== test.expectedConforms) {
      failures.push(`${test.filePath} expected sh:conforms ${test.expectedConforms} but got ${outcome.actualConforms} (${outcome.resultCount} result(s))`);
    }
  }

  for (const outcome of outcomes) {
    const status = outcome.actualConforms === outcome.test.expectedConforms ? 'PASS' : 'FAIL';
    console.log(`${status} ${outcome.test.filePath} (${outcome.resultCount} result(s))`);
  }

  if (skipped > 0 && !options.all) {
    console.log(`SKIP ${skipped} W3C SHACL Core test file(s) outside the selected N3 subset.`);
  }

  if (failures.length > 0) {
    console.error('\nSHACL Core failures:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  const scopeLabel = options.all ? 'W3C test file(s)' : 'selected W3C test file(s)';
  console.log(`SHACL Core ${options.all ? 'suite' : 'subset'}: ${outcomes.length}/${outcomes.length} ${scopeLabel} matched sh:conforms.`);
}

function parseCliOptions(args: string[]): CliOptions {
  const manifests: string[] = [];
  const only = new Set<string>();
  let all = true;
  let listKnownLimitations = false;

  for (const arg of args) {
    if (arg === '--all') {
      all = true;
    } else if (arg === '--selected') {
      all = false;
    } else if (arg === '--known-limitations') {
      listKnownLimitations = true;
    } else if (arg.startsWith('--manifest=')) {
      manifests.push(normalizeSuitePath(arg.slice('--manifest='.length)));
    } else if (arg.startsWith('--only=')) {
      for (const item of arg.slice('--only='.length).split(',')) {
        if (item.trim()) {
          only.add(normalizeSuitePath(item.trim()));
        }
      }
    } else {
      throw new Error(`Unknown SHACL test option: ${arg}`);
    }
  }

  return {
    all,
    manifests: manifests.length > 0 ? manifests : MANIFESTS,
    only,
    listKnownLimitations,
  };
}

async function loadTestCases(manifests: string[], options: CliOptions): Promise<TestCase[]> {
  const tests: TestCase[] = [];
  const seenFiles = new Set<string>();

  for (const manifestPath of manifests) {
    const manifest = await fetchSuiteFile(manifestPath);
    const manifestQuads = parseRdfWithBase(manifest.text, manifest.url);
    const includes = objects(manifestQuads, undefined, MF + 'include')
      .filter((term) => term.termType === 'NamedNode')
      .map((term) => suitePathFromUrl(term.value));

    for (const testFilePath of includes) {
      if (seenFiles.has(testFilePath)) {
        continue;
      }
      seenFiles.add(testFilePath);
      if (!shouldLoadTestFile(testFilePath, options)) {
        continue;
      }
      const testFile = await fetchSuiteFile(testFilePath);
      tests.push(...extractTestsFromFile(testFilePath, testFile.url, testFile.text));
    }
  }

  tests.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return tests;
}

function extractTestsFromFile(filePath: string, fileUrl: string, text: string): TestCase[] {
  const quads = parseRdfWithBase(text, fileUrl);
  const entries = subjects(quads, RDF_TYPE, SHT + 'Validate');
  const tests: TestCase[] = [];

  for (const entry of entries) {
    const action = object(quads, entry, MF + 'action');
    const result = object(quads, entry, MF + 'result');
    if (!action || !result) {
      continue;
    }

    const conforms = object(quads, result, SH + 'conforms');
    if (!conforms || conforms.termType !== 'Literal' || conforms.datatype.value !== XSD_BOOLEAN) {
      continue;
    }

    tests.push({
      id: termKey(entry),
      filePath,
      fileUrl,
      entry,
      quads,
      dataRefs: objects(quads, action, SHT + 'dataGraph'),
      shapesRefs: objects(quads, action, SHT + 'shapesGraph'),
      expectedConforms: conforms.value === 'true' || conforms.value === '1',
    });
  }

  return tests;
}

function shouldRunTest(test: TestCase, options: CliOptions): boolean {
  if (options.only.size > 0) {
    return options.only.has(test.filePath) || options.only.has(fileName(test.filePath));
  }
  if (options.all) {
    return true;
  }
  return SUPPORTED_TEST_FILE_NAMES.has(fileName(test.filePath))
    && !KNOWN_LIMITATIONS.has(test.filePath);
}

function shouldLoadTestFile(filePath: string, options: CliOptions): boolean {
  if (options.only.size > 0) {
    return options.only.has(filePath) || options.only.has(fileName(filePath));
  }
  return options.all
    || (SUPPORTED_TEST_FILE_NAMES.has(fileName(filePath)) && !KNOWN_LIMITATIONS.has(filePath));
}

async function loadDataAndShapes(test: TestCase): Promise<Quad[]> {
  const refs = uniqueTerms([...test.dataRefs, ...test.shapesRefs]);
  if (refs.length === 0 || refs.every((term) => term.termType === 'NamedNode' && term.value === test.fileUrl)) {
    return test.quads;
  }

  const quads: Quad[] = [];
  for (const ref of refs) {
    if (ref.termType !== 'NamedNode') {
      continue;
    }
    if (ref.value === test.fileUrl) {
      quads.push(...test.quads);
    } else {
      const file = await fetchAbsoluteSuiteUrl(ref.value);
      quads.push(...parseRdfWithBase(file.text, file.url));
    }
  }
  return uniqueQuads(quads);
}

function runValidation(rules: string, test: TestCase, dataAndShapes: Quad[]): TestOutcome {
  const closure = reasonStream({ n3: rules, quads: dataAndShapes as RdfJsQuad[] }, {
    rdfjs: true,
    dataFactory: DataFactory,
    skipUnsupportedRdfJs: true,
  } as any).closureQuads ?? [];

  const resultCount = closure.filter((quad) => quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && quad.object.value === SH + 'ValidationResult').length;

  return {
    test,
    actualConforms: resultCount === 0,
    resultCount,
  };
}

async function fetchSuiteFile(path: string): Promise<{ url: string; text: string }> {
  const suitePath = normalizeSuitePath(path);
  const url = RAW_BASE + suitePath;
  const cachePath = join(CACHE_ROOT, suitePath);
  return { url, text: await readCachedUrl(url, cachePath) };
}

async function fetchAbsoluteSuiteUrl(url: string): Promise<{ url: string; text: string }> {
  const path = suitePathFromUrl(url);
  const cachePath = join(CACHE_ROOT, path);
  return { url, text: await readCachedUrl(url, cachePath) };
}

function normalizeSuitePath(path: string): string {
  return path.replace(/^https:\/\/raw\.githubusercontent\.com\/w3c\/data-shapes\/gh-pages\/data-shapes-test-suite\/tests\//, '')
    .replace(/^data-shapes-test-suite\/tests\//, '')
    .replace(/^\/+/, '');
}

function suitePathFromUrl(url: string): string {
  const normalized = normalizeSuitePath(url);
  if (normalized !== url) {
    return normalized;
  }

  const parsed = new URL(url);
  const marker = '/data-shapes-test-suite/tests/';
  const index = parsed.pathname.indexOf(marker);
  if (index >= 0) {
    return parsed.pathname.slice(index + marker.length);
  }

  const rawMarker = '/w3c/data-shapes/gh-pages/data-shapes-test-suite/tests/';
  const rawIndex = parsed.pathname.indexOf(rawMarker);
  if (rawIndex >= 0) {
    return parsed.pathname.slice(rawIndex + rawMarker.length);
  }

  throw new Error(`Cannot map URL to SHACL test-suite path: ${url}`);
}

function subjects(quads: Quad[], predicate: string, objectValue: string): Term[] {
  return uniqueTerms(quads
    .filter((quad) => quad.predicate.termType === 'NamedNode'
      && quad.predicate.value === predicate
      && quad.object.termType === 'NamedNode'
      && quad.object.value === objectValue)
    .map((quad) => quad.subject as Term));
}

function object(quads: Quad[], subject: Term, predicate: string): Term | undefined {
  return objects(quads, subject, predicate)[0];
}

function objects(quads: Quad[], subject: Term | undefined, predicate: string): Term[] {
  const values: Term[] = [];
  for (const quad of quads) {
    if (quad.predicate.termType !== 'NamedNode' || quad.predicate.value !== predicate) {
      continue;
    }
    if (subject && termKey(quad.subject as Term) !== termKey(subject)) {
      continue;
    }
    values.push(quad.object as Term);
  }
  return values;
}

function uniqueTerms(terms: Term[]): Term[] {
  const byKey = new Map<string, Term>();
  for (const term of terms) {
    byKey.set(termKey(term), term);
  }
  return Array.from(byKey.values());
}

function uniqueQuads(quads: Quad[]): Quad[] {
  const byKey = new Map<string, Quad>();
  for (const quad of quads) {
    byKey.set([quad.subject, quad.predicate, quad.object, quad.graph].map((term) => termKey(term as Term)).join(' '), quad);
  }
  return Array.from(byKey.values());
}

function fileName(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1];
}

function printKnownLimitations(): void {
  console.log('Known SHACL Core limitations for rules/shacl-core-eyeling.n3:');
  for (const [test, reason] of KNOWN_LIMITATIONS) {
    console.log(`- ${test}: ${reason}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
