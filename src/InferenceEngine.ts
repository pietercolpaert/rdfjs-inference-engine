import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import type { DatasetCore, DataFactory, Quad, Term } from '@rdfjs/types';
import { rdfjs, reasonStream, runAsync, type EyelingTerm } from 'eyeling';
import { Parser } from 'rdf-parser-ts';
import {
  compileShaclShapeGraph,
  createShapePlanning,
  deserializeShapePlanning,
  optimizeInputWithShapePlanning,
  projectOutputWithShapePlanning,
  serializeShapePlanning,
  shapePlanningSummary,
  type ShapeInputOptimization,
  type ShapePlanning,
} from './shacl-shape-planning';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range';
const RDFS_SUB_CLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUB_PROPERTY_OF = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const OWL_EQUIVALENT_CLASS = 'http://www.w3.org/2002/07/owl#equivalentClass';
const OWL_EQUIVALENT_PROPERTY = 'http://www.w3.org/2002/07/owl#equivalentProperty';
const OWL_INVERSE_OF = 'http://www.w3.org/2002/07/owl#inverseOf';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const LOG_SKOLEM = 'http://www.w3.org/2000/10/swap/log#skolem';
const SKOLEM_BASE_IRI = 'https://eyereasoner.github.io/.well-known/genid/';
const INCONSISTENCIES = 'https://www.pieter.pm/rdfjs-inference-engine/ns/inconsistencies#';
const INCONSISTENCY = INCONSISTENCIES + 'Inconsistency';
const SHACL = 'http://www.w3.org/ns/shacl#';
const SHACL_VALIDATION_RESULT = SHACL + 'ValidationResult';
const INTERNAL = 'https://www.pieter.pm/rdfjs-inference-engine/ns/internal#';
const QCR = 'https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#';
const QUDT = 'http://qudt.org/schema/qudt/';
const QUDT_UNIT = 'http://qudt.org/vocab/unit/';
const QUDT_DIMENSION = QUDT + 'hasDimensionVector';
const QUDT_LOGARITHMIC_UNIT = QUDT + 'LogarithmicUnit';
const QUDT_QUANTITY_VALUE = QUDT + 'QuantityValue';
const CDT = 'https://w3id.org/cdt/';
const LEGACY_CDT = 'http://w3id.org/lindt/custom_datatypes#';
const PRECOMPILED_BACKGROUND_MARKER = '# Precomputed background facts and closure';
const NON_DEFAULT_RULE_DIRS = new Set(['precompiled', 'shacl-experimental']);

export type RuleProfile = string | {
  n3?: string;
  text?: string;
  label?: string;
  baseIri?: string;
  precompiledRuntime?: string;
};
export type VocabularyDataset = DatasetCore | Iterable<Quad>;
export type ShaclShapeInput = VocabularyDataset | string | { quads: Iterable<Quad> } | { path: string };

export interface LoadedRuleProfile {
  n3: string;
  label?: string;
  baseIri?: string;
  precompiledRuntime?: string;
}

export interface InferenceEngineOptions {
  runtime?: string;
  runtimePath?: string;
  shapePlanning?: ShapePlanning;
  shapePlanningPath?: string;
  dataFactory?: DataFactory;
  runtimeCompiler?: RuntimeCompiler;
  outputMode?: InferenceOutputMode;
}

export type InferenceOutputMode = 'application' | 'conformance';

export interface InferenceOptions {
  outputMode?: InferenceOutputMode;
  store?: string | InferenceStoreOptions;
  storePath?: string;
  storeClear?: boolean;
  deterministicSkolem?: boolean;
  skolemKey?: string;
  optimizeShapeInput?: boolean;
  projectShapeOutput?: boolean;
}

export interface InferenceStoreOptions {
  name: string;
  clear?: boolean;
  path?: string;
  type?: 'memory' | 'persistent';
  backend?: 'memory' | 'level' | 'indexeddb';
}

export interface LoadOptions {
  runtimeCompiler?: RuntimeCompiler;
  includeStaticClosure?: boolean;
  selectRuntimeRules?: boolean;
  shaclIn?: ShaclShapeInput;
  shaclOut?: ShaclShapeInput;
  deterministicSkolem?: boolean;
  skolemKey?: string;
}

export interface RuntimeCompilerInput {
  profiles: LoadedRuleProfile[];
  profileN3: string;
  vocabulary: Quad[];
  closure: Quad[];
  dataFactory: DataFactory;
  options: LoadOptions;
  shapePlanning?: ShapePlanning;
}

export type RuntimeCompiler = (input: RuntimeCompilerInput) => string;

export interface InconsistencyReport {
  id: string;
  rule?: string;
  terms: Term[];
  quads: Quad[];
}

export interface InferenceResult {
  quads: Quad[];
  inconsistencies: InconsistencyReport[];
}

export interface SaveOptions {
  path: string;
  shapePlanningPath?: string;
}

export class InferenceEngine {
  private runtime = '';
  private staticClosure: Quad[] = [];
  private readonly dataFactory: DataFactory;
  private readonly runtimeCompiler: RuntimeCompiler;
  private readonly outputMode: InferenceOutputMode;
  private shapePlanning?: ShapePlanning;
  private lastInputOptimization?: ShapeInputOptimization;

  public constructor(options: InferenceEngineOptions = {}) {
    this.dataFactory = options.dataFactory ?? rdfjs;
    this.runtimeCompiler = options.runtimeCompiler ?? defaultRuntimeCompiler;
    this.outputMode = options.outputMode ?? 'application';

    if (options.runtimePath) {
      this.runtime = readFileSync(options.runtimePath, 'utf8');
    } else if (options.runtime) {
      this.runtime = options.runtime;
    }

    if (options.shapePlanning) {
      this.shapePlanning = options.shapePlanning;
    } else if (options.shapePlanningPath) {
      this.shapePlanning = deserializeShapePlanning(readFileSync(options.shapePlanningPath, 'utf8'));
    }
  }

  public getRuntime(): string {
    return this.runtime;
  }

  public getStaticClosure(options: InferenceOptions = {}): Quad[] {
    const outputMode = options.outputMode ?? this.outputMode;
    return withInconsistencyQuads(
      this.staticClosure.filter((quad) => shouldEmitQuad(quad, outputMode)),
      this.staticClosure,
      outputMode,
    );
  }

  public getStaticInconsistencies(options: InferenceOptions = {}): InconsistencyReport[] {
    const outputMode = options.outputMode ?? this.outputMode;
    return collectInconsistencyReports(this.staticClosure, outputMode);
  }

  public getShapePlanning(): ShapePlanning | undefined {
    return this.shapePlanning;
  }

  public getLastInputOptimization(): ShapeInputOptimization | undefined {
    return this.lastInputOptimization;
  }

  public load(vocabulary: VocabularyDataset, options?: LoadOptions): string;
  public load(profiles: RuleProfile | RuleProfile[], vocabulary: VocabularyDataset, options?: LoadOptions): string;
  public load(profilesOrVocabulary: RuleProfile | RuleProfile[] | VocabularyDataset, vocabularyOrOptions?: VocabularyDataset | LoadOptions, options: LoadOptions = {}): string {
    const { profiles, vocabulary, loadOptions } = normalizeLoadArguments(profilesOrVocabulary, vocabularyOrOptions, options);
    const normalizedProfiles = normalizeProfiles(profiles);
    const profileN3 = normalizedProfiles
      .filter((profile) => !profile.precompiledRuntime)
      .map((profile) => profile.n3)
      .join('\n\n');
    const vocabularyQuads = quadsFromVocabulary(vocabulary);
    const deterministicSkolem = createDeterministicSkolemBuiltin(loadOptions);
    let closure: ReturnType<typeof reasonStream>;
    try {
      closure = reasonStream({ n3: profileN3, quads: vocabularyQuads }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    this.staticClosure = closure.closureQuads ?? [];
    this.shapePlanning = compileLoadShapePlanning(loadOptions);

    const runtimeCompiler = loadOptions.runtimeCompiler ?? this.runtimeCompiler;
    const compiledRuntime = runtimeCompiler({
      profiles: normalizedProfiles,
      profileN3,
      vocabulary: vocabularyQuads,
      closure: this.staticClosure,
      dataFactory: this.dataFactory,
      options: loadOptions,
      shapePlanning: this.shapePlanning,
    });
    this.runtime = appendPrecompiledProfileRuntimes(
      compiledRuntime,
      normalizedProfiles,
      vocabularyQuads,
      this.staticClosure,
      this.shapePlanning,
    );

    return this.runtime;
  }

  public saveRuntime(pathOrOptions: string | SaveOptions): void {
    const path = typeof pathOrOptions === 'string' ? pathOrOptions : pathOrOptions.path;
    writeFileSync(path, this.runtime, 'utf8');

    const shapePlanningPath = typeof pathOrOptions === 'string' ? undefined : pathOrOptions.shapePlanningPath;
    if (shapePlanningPath && this.shapePlanning) {
      writeFileSync(shapePlanningPath, serializeShapePlanning(this.shapePlanning), 'utf8');
    }
  }

  public *infer(data: Quad[], options: InferenceOptions = {}): Generator<Quad> {
    this.assertLoaded();
    const inferenceData = this.optimizeInferenceInput(data, options);
    const derived: Quad[] = [];
    const diagnostics: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);

    try {
      reasonStream({ n3: this.runtime, quads: inferenceData }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            diagnostics.push(item.quad);
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              diagnostics.push(quad);
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    yield* withInconsistencyQuads(
      this.projectInferenceOutput(derived, options),
      [...this.staticClosure, ...diagnostics],
      outputMode,
    );
  }

  public inferWithDiagnostics(data: Quad[], options: InferenceOptions = {}): InferenceResult {
    this.assertLoaded();
    const inferenceData = this.optimizeInferenceInput(data, options);
    const derived: Quad[] = [];
    const diagnostics: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);

    try {
      reasonStream({ n3: this.runtime, quads: inferenceData }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            const quad = item.quad;
            diagnostics.push(quad);
            addDerived(derived, seen, quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              diagnostics.push(quad);
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    const diagnosticSource = [...this.staticClosure, ...diagnostics];
    return {
      quads: withInconsistencyQuads(this.projectInferenceOutput(derived, options), diagnosticSource, outputMode),
      inconsistencies: collectInconsistencyReports(diagnosticSource, outputMode),
    };
  }

  public async inferAsync(data: Quad[], options: InferenceOptions = {}): Promise<Quad[]> {
    this.assertLoaded();
    if (!options.store && !options.storePath && !options.storeClear) {
      return Array.from(this.infer(data, options));
    }

    const derived: Quad[] = [];
    const diagnostics: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);
    const inferenceData = this.optimizeInferenceInput(data, options);
    let result: Awaited<ReturnType<typeof runAsync>>;
    try {
      result = await runAsync({ n3: this.runtime, quads: inferenceData }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        store: options.store,
        storePath: options.storePath,
        storeClear: options.storeClear,
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            diagnostics.push(item.quad);
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              diagnostics.push(quad);
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }
    if (result.store && typeof result.store.close === 'function') {
      await result.store.close();
    }

    return withInconsistencyQuads(
      this.projectInferenceOutput(derived, options),
      [...this.staticClosure, ...diagnostics],
      outputMode,
    );
  }

  public async inferAsyncWithDiagnostics(data: Quad[], options: InferenceOptions = {}): Promise<InferenceResult> {
    this.assertLoaded();
    if (!options.store && !options.storePath && !options.storeClear) {
      return this.inferWithDiagnostics(data, options);
    }

    const derived: Quad[] = [];
    const diagnostics: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);
    const inferenceData = this.optimizeInferenceInput(data, options);
    let result: Awaited<ReturnType<typeof runAsync>>;
    try {
      result = await runAsync({ n3: this.runtime, quads: inferenceData }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        store: options.store,
        storePath: options.storePath,
        storeClear: options.storeClear,
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            const quad = item.quad;
            diagnostics.push(quad);
            addDerived(derived, seen, quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              diagnostics.push(quad);
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    if (result.store && typeof result.store.close === 'function') {
      await result.store.close();
    }

    const diagnosticSource = [...this.staticClosure, ...diagnostics];
    return {
      quads: withInconsistencyQuads(this.projectInferenceOutput(derived, options), diagnosticSource, outputMode),
      inconsistencies: collectInconsistencyReports(diagnosticSource, outputMode),
    };
  }

  public createInferenceStream(): Transform {
    return new Transform({
      objectMode: true,
      transform: (chunk: Iterable<Quad>, _encoding: BufferEncoding, callback: TransformCallback) => {
        try {
          const inferred = Array.from(this.infer(Array.from(chunk)));
          callback(null, inferred);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
  }

  public stream(): Transform {
    return this.createInferenceStream();
  }

  private assertLoaded(): void {
    if (!this.runtime.trim()) {
      throw new Error('No inference runtime is loaded. Call load(...) or pass runtime/runtimePath to the constructor first.');
    }
  }

  private optimizeInferenceInput(data: Quad[], options: InferenceOptions): Quad[] {
    if (options.optimizeShapeInput === false || !this.shapePlanning?.input) {
      this.lastInputOptimization = undefined;
      return data;
    }

    const optimization = optimizeInputWithShapePlanning(data, this.shapePlanning);
    this.lastInputOptimization = optimization;
    return optimization.quads;
  }

  private projectInferenceOutput(data: Quad[], options: InferenceOptions): Quad[] {
    if (options.projectShapeOutput === false || !this.shapePlanning?.output) {
      return data;
    }

    return projectOutputWithShapePlanning(data, this.shapePlanning);
  }
}

export function loadDefaultRuleProfiles(rulesDir?: string): LoadedRuleProfile[] {
  const candidateDirs = [
    rulesDir,
    resolve(__dirname, '../../rules'),
    resolve(__dirname, '../rules'),
    resolve(process.cwd(), 'rules'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const uniqueCandidateDirs = Array.from(new Set(candidateDirs));
  for (const candidate of uniqueCandidateDirs) {
    if (!existsSync(candidate)) {
      continue;
    }

    const files = discoverDefaultRuleProfileFiles(candidate);
    if (files.length === 0) {
      continue;
    }

    return files.map(({ path, label }) => {
      const precompiledPath = path.replace(/\.n3$/, '.runtime.n3');
      return {
        n3: readFileSync(path, 'utf8'),
        label,
        precompiledRuntime: existsSync(precompiledPath) ? readFileSync(precompiledPath, 'utf8') : undefined,
      };
    });
  }

  throw new Error('Could not find default rule profiles. Pass explicit rule profiles to load(...) or install the package with rules/*/*.n3.');
}

function discoverDefaultRuleProfileFiles(rulesDir: string): Array<{ path: string; label: string }> {
  const files: Array<{ path: string; label: string }> = [];
  for (const entry of readdirSync(rulesDir).sort()) {
    const entryPath = join(rulesDir, entry);
    if (isRuleProfileFile(entry) && statSync(entryPath).isFile()) {
      files.push({ path: entryPath, label: `rules/${entry}` });
      continue;
    }

    if (!statSync(entryPath).isDirectory() || NON_DEFAULT_RULE_DIRS.has(entry)) {
      continue;
    }

    for (const file of readdirSync(entryPath).filter(isRuleProfileFile).sort()) {
      const path = join(entryPath, file);
      const normalizedRelativePath = relative(rulesDir, path).split(sep).join('/');
      files.push({ path, label: `rules/${normalizedRelativePath}` });
    }
  }

  return files.sort((left, right) => left.label.localeCompare(right.label));
}

function isRuleProfileFile(file: string): boolean {
  return file.endsWith('.n3') && !file.endsWith('.runtime.n3');
}

function normalizeLoadArguments(
  profilesOrVocabulary: RuleProfile | RuleProfile[] | VocabularyDataset,
  vocabularyOrOptions?: VocabularyDataset | LoadOptions,
  options: LoadOptions = {},
): { profiles: RuleProfile | RuleProfile[]; vocabulary: VocabularyDataset; loadOptions: LoadOptions } {
  if (vocabularyOrOptions !== undefined && !isLoadOptions(vocabularyOrOptions)) {
    if (!isRuleProfileInput(profilesOrVocabulary, { allowEmptyArray: true })) {
      throw new TypeError('Expected explicit rule profiles before the vocabulary dataset.');
    }
    return {
      profiles: profilesOrVocabulary,
      vocabulary: vocabularyOrOptions,
      loadOptions: options,
    };
  }

  if (isRuleProfileInput(profilesOrVocabulary, { allowEmptyArray: false })) {
    throw new TypeError('Expected a vocabulary dataset when explicit rule profiles are provided.');
  }

  return {
    profiles: loadDefaultRuleProfiles(),
    vocabulary: profilesOrVocabulary,
    loadOptions: isLoadOptions(vocabularyOrOptions) ? vocabularyOrOptions : options,
  };
}

function isRuleProfileInput(value: RuleProfile | RuleProfile[] | VocabularyDataset, options: { allowEmptyArray: boolean }): value is RuleProfile | RuleProfile[] {
  if (typeof value === 'string') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0
      ? options.allowEmptyArray
      : value.some((item) => typeof item === 'string' || isRuleProfileObject(item));
  }

  return isRuleProfileObject(value);
}

function isRuleProfileObject(value: unknown): value is Exclude<RuleProfile, string> {
  return typeof value === 'object'
    && value !== null
    && ('n3' in value || 'text' in value || 'label' in value || 'baseIri' in value || 'precompiledRuntime' in value)
    && !('subject' in value && 'predicate' in value && 'object' in value);
}

function isLoadOptions(value: unknown): value is LoadOptions {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  if (Symbol.iterator in Object(value)
    || typeof (value as { forEach?: unknown }).forEach === 'function'
    || ('subject' in value && 'predicate' in value && 'object' in value)) {
    return false;
  }

  return typeof value === 'object'
    && value !== null
    && ('runtimeCompiler' in value
      || 'includeStaticClosure' in value
      || 'selectRuntimeRules' in value
      || 'shaclIn' in value
      || 'shaclOut' in value
      || 'deterministicSkolem' in value
      || 'skolemKey' in value
      || Object.keys(value).length === 0);
}

export function defaultRuntimeCompiler(input: RuntimeCompilerInput): string {
  const sections = ['# Generated inference runtime. Do not edit by hand.'];
  const runtimeProfileN3 = input.options.selectRuntimeRules === false
    ? input.profileN3.trimEnd()
    : compileSelectedRuntimeProfiles(input).trimEnd();
  const includeStaticClosure = shouldIncludeStaticClosure(input, runtimeProfileN3);

  if (input.shapePlanning) {
    sections.push('', ...shapePlanningSummary(input.shapePlanning));
  }

  if (runtimeProfileN3.trim()) {
    sections.push('', '# Runtime rule profile', runtimeProfileN3);
  }

  if (includeStaticClosure) {
    const backgroundClosure = runtimeBackgroundClosure(input);
    if (backgroundClosure.length > 0) {
      sections.push('', '# Precomputed background facts and closure', serializeQuadsAsN3(backgroundClosure).trimEnd());
    }
  }

  return `${sections.join('\n')}\n`;
}

function runtimeBackgroundClosure(input: RuntimeCompilerInput): Quad[] {
  if (!activatesPreparedProfile(input) || !input.shapePlanning?.input || !input.shapePlanning.output) {
    return uniqueQuads([...input.vocabulary, ...input.closure]);
  }

  const vocabularyTerms = new Set<string>();
  for (const quad of input.vocabulary) {
    vocabularyTerms.add(termKey(quad.subject));
    vocabularyTerms.add(termKey(quad.object));
  }
  return uniqueQuads([
    ...input.vocabulary,
    ...input.closure.filter((quad) => vocabularyTerms.has(termKey(quad.subject))
      || vocabularyTerms.has(termKey(quad.object))),
  ]);
}

function shouldIncludeStaticClosure(input: RuntimeCompilerInput, runtimeProfileN3: string): boolean {
  if (input.options.includeStaticClosure !== undefined) {
    return input.options.includeStaticClosure;
  }

  // Prepared profiles are appended after runtime compilation. Keep the
  // load-time closure so those rules can consume OWL/SKOS consequences even
  // when SHACL planning selected only a partial dynamic rule projection.
  if (activatesPreparedProfile(input)) {
    return true;
  }

  if (!input.shapePlanning?.input || !input.shapePlanning.output) {
    return true;
  }

  return hasNonPartialRuntimeRuleSource(runtimeProfileN3);
}

function activatesPreparedProfile(input: RuntimeCompilerInput): boolean {
  return input.profiles.some((profile) => profile.precompiledRuntime?.trim())
    && (input.profiles.length === 1 || input.vocabulary.some((quad) => [quad.subject, quad.predicate, quad.object]
      .some(isQudtCdtTerm)));
}

function hasNonPartialRuntimeRuleSource(runtimeProfileN3: string): boolean {
  const sourceMatches = [...runtimeProfileN3.matchAll(/^# Source: (.+)$/gm)].map((match) => match[1]);
  if (sourceMatches.length === 0) {
    return runtimeProfileN3.includes('=>') || runtimeProfileN3.includes('<=');
  }

  return sourceMatches.some((source) => source !== PARTIAL_EVALUATED_OWL2RL_PROFILE.label);
}

interface RuntimeRuleSelectionContext {
  staticQuads: Quad[];
  staticPredicates: Set<string>;
  staticPredicateObjects: Set<string>;
  staticClasses: Set<string>;
  staticTerms: Set<string>;
  inputTerms: Set<string>;
  shapePlanning?: ShapePlanning;
}

interface RuntimeRuleEntry {
  profile: LoadedRuleProfile;
  prefixes: string[];
  rule: string;
  metadata: RuntimeRuleMetadata;
  partialEvaluation?: boolean;
}

interface RuntimeRuleMetadata {
  bodyPredicates: Set<string>;
  headPredicates: Set<string>;
  bodyClasses: Set<string>;
  headClasses: Set<string>;
  hasVariableHeadPredicate: boolean;
}

type Owl2RlPartialRuleKind =
  | 'domain'
  | 'range'
  | 'subProperty'
  | 'equivalentPropertyForward'
  | 'equivalentPropertyBackward'
  | 'inverseForward'
  | 'inverseBackward'
  | 'subClass'
  | 'equivalentClassForward'
  | 'equivalentClassBackward';

type StaticOwl2RlFactKind = 'domain' | 'range' | 'subProperty' | 'equivalentProperty' | 'inverse' | 'subClass' | 'equivalentClass';

interface StaticOwl2RlFacts {
  facts: Record<StaticOwl2RlFactKind, Array<[string, string]>>;
  hasNonSpecializableFacts: Set<StaticOwl2RlFactKind>;
}

interface Owl2RlPartialEvaluationResult {
  entries: RuntimeRuleEntry[];
  generatedRuleCount: number;
  replacedRuleCount: number;
}

const KNOWN_PREFIXES: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  sh: 'http://www.w3.org/ns/shacl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  shn: INTERNAL,
  internal: INTERNAL,
  owlrl: INCONSISTENCIES,
  inconsistencies: INCONSISTENCIES,
  qcr: QCR,
};

const STATIC_SCHEMA_PREDICATES = [
  'rdfs:domain',
  'rdfs:range',
  'rdfs:subClassOf',
  'rdfs:subPropertyOf',
  'owl:equivalentClass',
  'owl:equivalentProperty',
  'owl:inverseOf',
  'owl:propertyChainAxiom',
  'owl:intersectionOf',
  'owl:unionOf',
  'owl:oneOf',
  'owl:members',
  'owl:distinctMembers',
  'owl:hasKey',
  'owl:onProperty',
  'owl:onClass',
  'owl:onDataRange',
  'owl:someValuesFrom',
  'owl:allValuesFrom',
  'owl:hasValue',
  'owl:maxCardinality',
  'owl:maxQualifiedCardinality',
  'owl:complementOf',
  'owl:disjointWith',
  'owl:disjointUnionOf',
  'owl:datatypeComplementOf',
  'sh:path',
  'sh:property',
  'sh:targetNode',
  'sh:targetClass',
  'sh:targetSubjectsOf',
  'sh:targetObjectsOf',
  'sh:class',
  'sh:datatype',
  'sh:minCount',
  'sh:maxCount',
  'sh:hasValue',
  'sh:in',
  'sh:minInclusive',
  'sh:minExclusive',
  'sh:maxInclusive',
  'sh:maxExclusive',
  'sh:minLength',
  'sh:maxLength',
  'sh:pattern',
  'sh:node',
  'sh:and',
  'sh:or',
  'sh:not',
  'sh:xone',
  'sh:qualifiedValueShape',
  'sh:qualifiedMinCount',
  'sh:qualifiedMaxCount',
];

const STATIC_TYPE_GUARDS = [
  'owl:FunctionalProperty',
  'owl:InverseFunctionalProperty',
  'owl:TransitiveProperty',
  'owl:SymmetricProperty',
  'owl:AsymmetricProperty',
  'owl:IrreflexiveProperty',
  'owl:AnnotationProperty',
  'owl:AllDifferent',
  'owl:AllDisjointClasses',
  'owl:AllDisjointProperties',
  'owl:Class',
  'rdfs:Class',
  'rdfs:Datatype',
  'sh:NodeShape',
  'sh:PropertyShape',
];

const PARTIAL_EVALUATED_OWL2RL_PROFILE: LoadedRuleProfile = {
  n3: '',
  label: 'Partial-evaluated OWL 2 RL rules from static ontology',
};

const OWL2RL_PARTIAL_RULE_SIGNATURES: Record<Owl2RlPartialRuleKind, string> = {
  domain: '{?prdfs:domain?c.?x?p?y.}=>{?xrdf:type?c.}.',
  range: '{?prdfs:range?c.?x?p?y.}=>{?yrdf:type?c.}.',
  subProperty: '{?p1rdfs:subPropertyOf?p2.?x?p1?y.}=>{?x?p2?y.}.',
  equivalentPropertyForward: '{?p1owl:equivalentProperty?p2.?x?p1?y.}=>{?x?p2?y.}.',
  equivalentPropertyBackward: '{?p1owl:equivalentProperty?p2.?x?p2?y.}=>{?x?p1?y.}.',
  inverseForward: '{?p1owl:inverseOf?p2.?x?p1?y.}=>{?y?p2?x.}.',
  inverseBackward: '{?p1owl:inverseOf?p2.?x?p2?y.}=>{?y?p1?x.}.',
  subClass: '{?c1rdfs:subClassOf?c2.?xrdf:type?c1.}=>{?xrdf:type?c2.}.',
  equivalentClassForward: '{?c1owl:equivalentClass?c2.?xrdf:type?c1.}=>{?xrdf:type?c2.}.',
  equivalentClassBackward: '{?c1owl:equivalentClass?c2.?xrdf:type?c2.}=>{?xrdf:type?c1.}.',
};

function compileSelectedRuntimeProfiles(input: RuntimeCompilerInput): string {
  const context = runtimeRuleSelectionContext(input.vocabulary, [...input.vocabulary, ...input.closure], input.shapePlanning);
  const entries: RuntimeRuleEntry[] = [];
  let totalRules = 0;

  for (const profile of input.profiles) {
    if (profile.precompiledRuntime) {
      continue;
    }
    const source = profile.n3.trimEnd();
    if (!source) {
      continue;
    }

    if (!isRuntimeProfileRelevant(profile, context)) {
      continue;
    }

    const prefixes = extractPrefixDeclarations(source);
    const prefixMap = extractPrefixMap(prefixes);
    const rules = extractTopLevelRuleStatements(source);
    totalRules += rules.length;
    for (const rule of rules) {
      const metadata = extractRuntimeRuleMetadata(rule, prefixMap);
      if (isRuntimeRuleStaticallyRelevant(rule, context)) {
        entries.push({ profile, prefixes, rule, metadata });
      }
    }
  }

  const partialEvaluation = partialEvaluateOwl2RlRuntimeRules(entries, context);
  const selectedEntries = selectShapeGuidedRuntimeRules(partialEvaluation.entries, context);
  const sections = formatRuntimeRuleEntries(selectedEntries);

  if (sections.length === 0) {
    return '';
  }

  return [
    `# Selected ${selectedEntries.length}/${totalRules} top-level runtime rules for the load-time vocabulary${input.shapePlanning ? ' and SHACL shape hints' : ''}${partialEvaluation.generatedRuleCount > 0 ? `; partial-evaluated ${partialEvaluation.replacedRuleCount} OWL 2 RL schema rules into ${partialEvaluation.generatedRuleCount} direct data rules` : ''}.`,
    ...sections,
  ].join('\n');
}

function runtimeRuleSelectionContext(inputQuads: Iterable<Quad>, staticQuads: Iterable<Quad>, shapePlanning?: ShapePlanning): RuntimeRuleSelectionContext {
  const staticQuadList = Array.from(staticQuads);
  const staticPredicates = new Set<string>();
  const staticPredicateObjects = new Set<string>();
  const staticClasses = new Set<string>();
  const staticTerms = new Set<string>();
  const inputTerms = new Set<string>();

  for (const quad of inputQuads) {
    addTermValue(inputTerms, quad.subject);
    addTermValue(inputTerms, quad.predicate);
    addTermValue(inputTerms, quad.object);
  }

  for (const quad of staticQuadList) {
    addTermValue(staticTerms, quad.subject);
    addTermValue(staticTerms, quad.predicate);
    addTermValue(staticTerms, quad.object);
    if (quad.predicate.termType === 'NamedNode') {
      staticPredicates.add(quad.predicate.value);
      if (quad.object.termType === 'NamedNode') {
        staticPredicateObjects.add(`${quad.predicate.value}\t${quad.object.value}`);
        if (quad.predicate.value === RDF_TYPE) {
          staticClasses.add(quad.object.value);
        }
      }
    }
  }

  return { staticQuads: staticQuadList, staticPredicates, staticPredicateObjects, staticClasses, staticTerms, inputTerms, shapePlanning };
}

function partialEvaluateOwl2RlRuntimeRules(entries: RuntimeRuleEntry[], context: RuntimeRuleSelectionContext): Owl2RlPartialEvaluationResult {
  const staticFacts = collectStaticOwl2RlFacts(context.staticQuads, context.inputTerms);
  const specializedEntries: RuntimeRuleEntry[] = [];
  let generatedRuleCount = 0;
  let replacedRuleCount = 0;

  for (const entry of entries) {
    const kind = partialOwl2RlRuleKind(entry.rule);
    if (!kind) {
      specializedEntries.push(entry);
      continue;
    }

    const replacements = specializedOwl2RlEntries(kind, staticFacts);
    if (replacements.length === 0) {
      specializedEntries.push(entry);
      continue;
    }

    specializedEntries.push(...replacements);
    generatedRuleCount += replacements.length;
    replacedRuleCount += 1;
  }

  return { entries: specializedEntries, generatedRuleCount, replacedRuleCount };
}

function collectStaticOwl2RlFacts(staticQuads: Quad[], loadTimeTerms: Set<string>): StaticOwl2RlFacts {
  const facts: StaticOwl2RlFacts['facts'] = {
    domain: [],
    range: [],
    subProperty: [],
    equivalentProperty: [],
    inverse: [],
    subClass: [],
    equivalentClass: [],
  };
  const seen = new Set<string>();
  const hasNonSpecializableFacts = new Set<StaticOwl2RlFactKind>();

  for (const quad of staticQuads) {
    if (quad.graph.termType !== 'DefaultGraph' || quad.predicate.termType !== 'NamedNode') {
      continue;
    }

    const kind = staticOwl2RlFactKind(quad.predicate.value);
    if (!kind) {
      continue;
    }

    if (quad.subject.termType !== 'NamedNode' || quad.object.termType !== 'NamedNode') {
      hasNonSpecializableFacts.add(kind);
      continue;
    }

    if (!loadTimeTerms.has(quad.subject.value) || !loadTimeTerms.has(quad.object.value)) {
      continue;
    }

    if (quad.subject.value === quad.object.value && kind !== 'domain' && kind !== 'range') {
      continue;
    }

    const key = `${kind}\t${quad.subject.value}\t${quad.object.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      facts[kind].push([quad.subject.value, quad.object.value]);
    }
  }

  for (const values of Object.values(facts)) {
    values.sort(([leftSubject, leftObject], [rightSubject, rightObject]) => leftSubject.localeCompare(rightSubject) || leftObject.localeCompare(rightObject));
  }

  return { facts, hasNonSpecializableFacts };
}

function staticOwl2RlFactKind(predicate: string): StaticOwl2RlFactKind | undefined {
  switch (predicate) {
    case RDFS_DOMAIN:
      return 'domain';
    case RDFS_RANGE:
      return 'range';
    case RDFS_SUB_PROPERTY_OF:
      return 'subProperty';
    case OWL_EQUIVALENT_PROPERTY:
      return 'equivalentProperty';
    case OWL_INVERSE_OF:
      return 'inverse';
    case RDFS_SUB_CLASS_OF:
      return 'subClass';
    case OWL_EQUIVALENT_CLASS:
      return 'equivalentClass';
    default:
      return undefined;
  }
}

function partialOwl2RlRuleKind(rule: string): Owl2RlPartialRuleKind | undefined {
  const normalized = normalizeRuntimeRule(rule);
  for (const [kind, signature] of Object.entries(OWL2RL_PARTIAL_RULE_SIGNATURES) as Array<[Owl2RlPartialRuleKind, string]>) {
    if (normalized === signature) {
      return kind;
    }
  }
  return undefined;
}

function specializedOwl2RlEntries(kind: Owl2RlPartialRuleKind, staticFacts: StaticOwl2RlFacts): RuntimeRuleEntry[] {
  const factKind = partialRuleFactKind(kind);
  if (staticFacts.hasNonSpecializableFacts.has(factKind)) {
    return [];
  }

  return staticFacts.facts[factKind].map((fact) => partialEvaluatedRuleEntry(specializedOwl2RlRule(kind, fact)));
}

function partialRuleFactKind(kind: Owl2RlPartialRuleKind): StaticOwl2RlFactKind {
  switch (kind) {
    case 'equivalentPropertyForward':
    case 'equivalentPropertyBackward':
      return 'equivalentProperty';
    case 'inverseForward':
    case 'inverseBackward':
      return 'inverse';
    case 'equivalentClassForward':
    case 'equivalentClassBackward':
      return 'equivalentClass';
    default:
      return kind;
  }
}

function specializedOwl2RlRule(kind: Owl2RlPartialRuleKind, [left, right]: [string, string]): string {
  switch (kind) {
    case 'domain':
      return `{ ?x ${iri(left)} ?y . }\n=> { ?x ${iri(RDF_TYPE)} ${iri(right)} . } .`;
    case 'range':
      return `{ ?x ${iri(left)} ?y . }\n=> { ?y ${iri(RDF_TYPE)} ${iri(right)} . } .`;
    case 'subProperty':
    case 'equivalentPropertyForward':
      return `{ ?x ${iri(left)} ?y . }\n=> { ?x ${iri(right)} ?y . } .`;
    case 'equivalentPropertyBackward':
      return `{ ?x ${iri(right)} ?y . }\n=> { ?x ${iri(left)} ?y . } .`;
    case 'inverseForward':
      return `{ ?x ${iri(left)} ?y . }\n=> { ?y ${iri(right)} ?x . } .`;
    case 'inverseBackward':
      return `{ ?x ${iri(right)} ?y . }\n=> { ?y ${iri(left)} ?x . } .`;
    case 'subClass':
    case 'equivalentClassForward':
      return `{ ?x ${iri(RDF_TYPE)} ${iri(left)} . }\n=> { ?x ${iri(RDF_TYPE)} ${iri(right)} . } .`;
    case 'equivalentClassBackward':
      return `{ ?x ${iri(RDF_TYPE)} ${iri(right)} . }\n=> { ?x ${iri(RDF_TYPE)} ${iri(left)} . } .`;
  }
}

function partialEvaluatedRuleEntry(rule: string): RuntimeRuleEntry {
  return {
    profile: PARTIAL_EVALUATED_OWL2RL_PROFILE,
    prefixes: [],
    rule,
    metadata: extractRuntimeRuleMetadata(rule, KNOWN_PREFIXES),
    partialEvaluation: true,
  };
}

function normalizeRuntimeRule(rule: string): string {
  return rule.replace(/\s+/g, '');
}

function addTermValue(values: Set<string>, term: Term): void {
  if (term.termType === 'NamedNode') {
    values.add(term.value);
  }
}

function isRuntimeProfileRelevant(profile: LoadedRuleProfile, context: RuntimeRuleSelectionContext): boolean {
  const label = (profile.label ?? '').toLowerCase();
  const source = profile.n3;
  const hasShaclProfile = label.includes('shacl') || source.includes('@prefix sh:');
  const hasSkosProfile = label.includes('skos') || source.includes('@prefix skos:');
  const hasOwlProfile = label.includes('owl') || source.includes('@prefix owlrl:');

  if (hasShaclProfile && !hasSkosProfile && !hasOwlProfile) {
    return hasNamespaceTerm(context, 'http://www.w3.org/ns/shacl#');
  }
  if (hasSkosProfile && !hasShaclProfile && !hasOwlProfile) {
    return hasNamespaceTerm(context, 'http://www.w3.org/2004/02/skos/core#');
  }
  return true;
}

function hasNamespaceTerm(context: RuntimeRuleSelectionContext, namespace: string): boolean {
  for (const term of context.inputTerms) {
    if (term.startsWith(namespace)) {
      return true;
    }
  }
  return false;
}

function isRuntimeRuleStaticallyRelevant(rule: string, context: RuntimeRuleSelectionContext): boolean {
  const body = runtimeRuleBody(rule);

  for (const qname of STATIC_SCHEMA_PREDICATES) {
    if (!qnameAppearsAsPredicate(body, qname)) {
      continue;
    }
    const iriValue = qnameToIri(qname);
    if (iriValue && !context.staticPredicates.has(iriValue)) {
      return false;
    }
  }

  for (const qname of STATIC_TYPE_GUARDS) {
    if (!qnameAppearsAsTypeObject(body, qname)) {
      continue;
    }
    const iriValue = qnameToIri(qname);
    if (iriValue && !context.staticPredicateObjects.has(`${RDF_TYPE}\t${iriValue}`)) {
      return false;
    }
  }

  return true;
}

function selectShapeGuidedRuntimeRules(entries: RuntimeRuleEntry[], context: RuntimeRuleSelectionContext): RuntimeRuleEntry[] {
  const planning = context.shapePlanning;
  if (!planning) {
    return entries;
  }

  const reachable = reachableRuleEntries(entries, context, planning);
  if (!planning.output) {
    return orderRuntimeRulesForShapeHints(entries.filter((_entry, index) => reachable.has(index)), planning);
  }

  const needed = outputRelevantRuleEntries(entries, planning);
  return orderRuntimeRulesForShapeHints(entries.filter((_entry, index) => reachable.has(index) && needed.has(index)), planning);
}

function orderRuntimeRulesForShapeHints(entries: RuntimeRuleEntry[], planning: ShapePlanning): RuntimeRuleEntry[] {
  if (planning.recommendedJoinOrderHints.length === 0) {
    return entries;
  }

  const rankByPredicate = new Map<string, number>();
  for (const hint of planning.recommendedJoinOrderHints) {
    const previous = rankByPredicate.get(hint.predicate);
    if (previous === undefined || hint.rank < previous) {
      rankByPredicate.set(hint.predicate, hint.rank);
    }
  }

  return entries.map((entry, index) => ({ entry, index, rank: runtimeRuleJoinRank(entry, rankByPredicate) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.entry);
}

function runtimeRuleJoinRank(entry: RuntimeRuleEntry, rankByPredicate: Map<string, number>): number {
  let rank = 10_000;
  for (const predicate of entry.metadata.bodyPredicates) {
    rank = Math.min(rank, rankByPredicate.get(predicate) ?? 10_000);
  }
  return rank;
}

function reachableRuleEntries(entries: RuntimeRuleEntry[], context: RuntimeRuleSelectionContext, planning: ShapePlanning): Set<number> {
  const reachable = new Set<number>();
  const availablePredicates = new Set<string>([
    ...context.staticPredicates,
    ...planning.relevantInputPredicates,
  ]);
  const availableClasses = new Set<string>([
    ...context.staticClasses,
    ...(planning.input?.relevantClasses ?? []),
  ]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const [index, entry] of entries.entries()) {
      if (reachable.has(index) || !ruleCanMatchKnownInput(entry.metadata, availablePredicates, availableClasses)) {
        continue;
      }
      reachable.add(index);
      addAll(availablePredicates, entry.metadata.headPredicates);
      addAll(availableClasses, entry.metadata.headClasses);
      changed = true;
    }
  }

  return reachable;
}

function outputRelevantRuleEntries(entries: RuntimeRuleEntry[], planning: ShapePlanning): Set<number> {
  const needed = new Set<number>();
  const desiredPredicates = new Set<string>(planning.relevantOutputPredicates);
  const desiredClasses = new Set<string>(planning.output?.relevantClasses ?? []);
  let changed = true;

  while (changed) {
    changed = false;
    for (const [index, entry] of entries.entries()) {
      if (needed.has(index)) {
        continue;
      }
      if (!entry.partialEvaluation && !ruleProducesDesiredOutput(entry.metadata, desiredPredicates, desiredClasses)) {
        continue;
      }
      needed.add(index);
      addAll(desiredPredicates, entry.metadata.bodyPredicates);
      addAll(desiredClasses, entry.metadata.bodyClasses);
      changed = true;
    }
  }

  return needed;
}

function ruleCanMatchKnownInput(metadata: RuntimeRuleMetadata, availablePredicates: Set<string>, availableClasses: Set<string>): boolean {
  if (metadata.bodyPredicates.size === 0 && metadata.bodyClasses.size === 0) {
    return true;
  }

  for (const predicate of metadata.bodyPredicates) {
    if (availablePredicates.has(predicate)
      || predicate.startsWith(INCONSISTENCIES)
      || predicate.startsWith(INTERNAL)) {
      return true;
    }
  }
  for (const classValue of metadata.bodyClasses) {
    if (availableClasses.has(classValue)) {
      return true;
    }
  }

  return false;
}

function ruleProducesDesiredOutput(metadata: RuntimeRuleMetadata, desiredPredicates: Set<string>, desiredClasses: Set<string>): boolean {
  if (metadata.hasVariableHeadPredicate && desiredPredicates.size > 0 && desiredClasses.size === 0) {
    return true;
  }

  if (metadata.headPredicates.size === 0 && metadata.headClasses.size === 0) {
    return false;
  }

  for (const predicate of metadata.headPredicates) {
    if (predicate === RDF_TYPE && desiredClasses.size > 0) {
      continue;
    }
    if (desiredPredicates.has(predicate)) {
      return true;
    }
  }
  for (const classValue of metadata.headClasses) {
    if (desiredClasses.has(classValue)) {
      return true;
    }
  }

  return false;
}

function formatRuntimeRuleEntries(entries: RuntimeRuleEntry[]): string[] {
  const sections: string[] = [];
  let currentProfile: LoadedRuleProfile | undefined;
  for (const entry of entries) {
    if (entry.profile !== currentProfile) {
      currentProfile = entry.profile;
      if (sections.length > 0) {
        sections.push('');
      }
      if (entry.profile.label) {
        sections.push(`# Source: ${entry.profile.label}`);
      }
      sections.push(...entry.prefixes, '');
    }
    sections.push(entry.rule);
  }
  return sections;
}

function extractRuntimeRuleMetadata(rule: string, prefixes: Record<string, string>): RuntimeRuleMetadata {
  const body = runtimeRuleBody(rule);
  const head = runtimeRuleHead(rule);
  return {
    bodyPredicates: extractPredicateIris(body, prefixes),
    headPredicates: extractPredicateIris(head, prefixes),
    bodyClasses: extractTypeObjectIris(body, prefixes),
    headClasses: extractTypeObjectIris(head, prefixes),
    hasVariableHeadPredicate: hasVariablePredicate(head),
  };
}

function addAll<T>(target: Set<T>, values: Iterable<T>): void {
  for (const value of values) {
    target.add(value);
  }
}

function runtimeRuleBody(rule: string): string {
  const forwardIndex = rule.indexOf('=>');
  const backwardIndex = rule.indexOf('<=');
  if (forwardIndex >= 0 && (backwardIndex < 0 || forwardIndex < backwardIndex)) {
    return rule.slice(0, forwardIndex);
  }
  if (backwardIndex >= 0) {
    return rule.slice(backwardIndex + 2);
  }
  return rule;
}

function runtimeRuleHead(rule: string): string {
  const forwardIndex = rule.indexOf('=>');
  const backwardIndex = rule.indexOf('<=');
  if (forwardIndex >= 0 && (backwardIndex < 0 || forwardIndex < backwardIndex)) {
    return rule.slice(forwardIndex + 2);
  }
  if (backwardIndex >= 0) {
    return rule.slice(0, backwardIndex);
  }
  return '';
}

function extractPredicateIris(source: string, prefixes: Record<string, string>): Set<string> {
  const predicates = new Set<string>();
  const predicatePattern = /(^|[\s;])((?:[A-Za-z][\w-]*:[^\s;,.()[\]{}]+)|<[^>]+>|a)(?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = predicatePattern.exec(source)) !== null) {
    const iriValue = tokenToIri(match[2], prefixes);
    if (iriValue) {
      predicates.add(iriValue);
    }
  }
  return predicates;
}

function extractTypeObjectIris(source: string, prefixes: Record<string, string>): Set<string> {
  const classes = new Set<string>();
  const typePattern = /(^|[\s;])(?:rdf:type|a|<http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type>)\s+((?:[A-Za-z][\w-]*:[^\s;,.()[\]{}]+)|<[^>]+>)/g;
  let match: RegExpExecArray | null;
  while ((match = typePattern.exec(source)) !== null) {
    const iriValue = tokenToIri(match[2], prefixes);
    if (iriValue) {
      classes.add(iriValue);
    }
  }
  return classes;
}

function hasVariablePredicate(source: string): boolean {
  return /(^|[\s;])\?[A-Za-z_][\w-]*(?=\s)/.test(source);
}

function tokenToIri(token: string, prefixes: Record<string, string>): string | undefined {
  if (token === 'a') {
    return RDF_TYPE;
  }
  if (token.startsWith('<') && token.endsWith('>')) {
    return token.slice(1, -1);
  }

  const [prefix, local] = token.split(':', 2);
  const namespace = prefixes[prefix] ?? KNOWN_PREFIXES[prefix];
  return namespace && local ? namespace + local : undefined;
}

function qnameAppearsAsPredicate(source: string, qname: string): boolean {
  return new RegExp(`(^|[\\s;])${escapeRegExp(qname)}(?=\\s)`).test(source);
}

function qnameAppearsAsTypeObject(source: string, qname: string): boolean {
  return new RegExp(`(^|[\\s;])(?:rdf:type|a)\\s+${escapeRegExp(qname)}(?=[\\s.;])`).test(source);
}

function qnameToIri(qname: string): string | undefined {
  const [prefix, local] = qname.split(':', 2);
  const namespace = KNOWN_PREFIXES[prefix];
  return namespace ? namespace + local : undefined;
}

function extractPrefixDeclarations(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^@(prefix|base)\b/i.test(line));
}

function extractPrefixMap(prefixDeclarations: string[]): Record<string, string> {
  const prefixes: Record<string, string> = { ...KNOWN_PREFIXES };
  for (const declaration of prefixDeclarations) {
    const match = /^@prefix\s+([A-Za-z][\w-]*):\s*<([^>]+)>\s*\.?$/i.exec(declaration.trim());
    if (match) {
      prefixes[match[1]] = match[2];
    }
  }
  return prefixes;
}

function compileLoadShapePlanning(options: LoadOptions): ShapePlanning | undefined {
  const inputPlan = options.shaclIn
    ? compileShaclShapeGraph(quadsFromShapeInput(options.shaclIn), 'in')
    : undefined;
  const outputPlan = options.shaclOut
    ? compileShaclShapeGraph(quadsFromShapeInput(options.shaclOut), 'out')
    : undefined;

  return createShapePlanning(inputPlan, outputPlan);
}

function quadsFromShapeInput(input: ShaclShapeInput): Quad[] {
  if (typeof input === 'string') {
    return parseShapeQuads(input);
  }

  if ('path' in Object(input) && typeof (input as { path?: unknown }).path === 'string') {
    return parseShapeQuads(readFileSync((input as { path: string }).path, 'utf8'));
  }

  if ('quads' in Object(input) && Symbol.iterator in Object((input as { quads?: unknown }).quads)) {
    return Array.from((input as { quads: Iterable<Quad> }).quads);
  }

  return quadsFromVocabulary(input as VocabularyDataset);
}

function parseShapeQuads(source: string): Quad[] {
  const parsed = new Parser().parse(source) ?? [];
  return Array.from(parsed as Iterable<unknown>) as Quad[];
}

function extractTopLevelRuleStatements(source: string): string[] {
  const rules: string[] = [];
  let ruleStart = -1;
  let braceDepth = 0;
  let stringQuote = '';
  let tripleQuoted = false;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inComment) {
      if (char === '\n' || char === '\r') {
        inComment = false;
      }
      continue;
    }

    if (stringQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (tripleQuoted && source.startsWith(stringQuote.repeat(3), index)) {
        index += 2;
        stringQuote = '';
        tripleQuoted = false;
      } else if (!tripleQuoted && char === stringQuote) {
        stringQuote = '';
      }
      continue;
    }

    if (char === '#') {
      inComment = true;
      continue;
    }

    if (char === '"' || char === "'") {
      stringQuote = char;
      tripleQuoted = source.startsWith(char.repeat(3), index);
      if (tripleQuoted) {
        index += 2;
      }
      continue;
    }

    if (char === '{') {
      if (braceDepth === 0 && ruleStart < 0) {
        ruleStart = index;
      }
      braceDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === '.' && braceDepth === 0 && ruleStart >= 0) {
      const statement = source.slice(ruleStart, index + 1).trim();
      if (statement.includes('=>') || statement.includes('<=')) {
        rules.push(statement);
      }
      ruleStart = -1;
    }
  }

  return rules;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueQuads(quads: Iterable<Quad>): Quad[] {
  const unique: Quad[] = [];
  const seen = new Set<string>();

  for (const quad of quads) {
    const key = quadKey(quad);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(quad);
    }
  }

  return unique;
}

export function serializeQuadsAsN3(quads: Iterable<Quad>): string {
  return Array.from(quads, quadToN3).join('\n');
}

function normalizeProfiles(profiles: RuleProfile | RuleProfile[]): LoadedRuleProfile[] {
  return (Array.isArray(profiles) ? profiles : [profiles]).map((profile) => {
    if (typeof profile === 'string') {
      return { n3: profile };
    }

    return {
      n3: profile.n3 ?? profile.text ?? '',
      label: profile.label,
      baseIri: profile.baseIri,
      precompiledRuntime: profile.precompiledRuntime,
    };
  });
}

function appendPrecompiledProfileRuntimes(
  runtime: string,
  profiles: LoadedRuleProfile[],
  vocabulary: Quad[],
  closure: Quad[],
  shapePlanning?: ShapePlanning,
): string {
  const activatePreparedProfiles = profiles.length === 1 || vocabulary.some((quad) => [quad.subject, quad.predicate, quad.object]
    .some(isQudtCdtTerm));
  if (!activatePreparedProfiles) {
    return runtime;
  }

  const prepared = profiles
    .filter((profile) => profile.precompiledRuntime?.trim())
    .map((profile) => [
      `# Precompiled runtime profile${profile.label ? `: ${profile.label}` : ''}`,
      specializeQudtPreparedRuntime(profile.precompiledRuntime!, shapePlanning, [...vocabulary, ...closure]).trim(),
    ].join('\n'));

  return prepared.length === 0
    ? runtime
    : `${[runtime.trimEnd(), ...prepared].filter(Boolean).join('\n\n')}\n`;
}

function specializeQudtPreparedRuntime(runtime: string, planning: ShapePlanning | undefined, staticQuads: Quad[]): string {
  if (!planning) {
    return runtime;
  }
  const targetUnits = qudtUnitsFromShapePlan(planning.output);
  if (targetUnits.length === 0) {
    return runtime;
  }

  const markerIndex = runtime.indexOf(PRECOMPILED_BACKGROUND_MARKER);
  if (markerIndex < 0) {
    return runtime;
  }

  const factsStart = runtime.indexOf('\n', markerIndex);
  if (factsStart < 0) {
    return runtime;
  }

  let facts: Quad[];
  try {
    facts = parseShapeQuads(runtime.slice(factsStart + 1));
  } catch {
    return runtime;
  }

  const inputUnitHints = qudtUnitsFromShapePlan(planning.input);
  const mappings = collectQudtUnitMappings(staticQuads);
  const resolvedTargets = resolveQudtUnits(targetUnits, mappings);
  const resolvedInputs = resolveQudtUnits(inputUnitHints, mappings);
  if (resolvedTargets.size === 0) {
    return runtime;
  }

  const selectedUnits = new Set<string>([...resolvedTargets, ...resolvedInputs]);
  const hasUnresolvedInputUnit = inputUnitHints.some((unit) => !unit.startsWith(QUDT_UNIT) && !mappings.has(unit));
  // An open source contract needs every source unit that can reach the target
  // dimension; exact SHACL IN constraints can use the much smaller explicit set.
  if (inputUnitHints.length === 0 || hasUnresolvedInputUnit) {
    const targetDimensions = new Set(facts
      .filter((quad) => quad.predicate.value === QUDT_DIMENSION && resolvedTargets.has(quad.subject.value))
      .map((quad) => quad.object.value));
    for (const quad of facts) {
      if (quad.predicate.value === QUDT_DIMENSION && targetDimensions.has(quad.object.value)) {
        selectedUnits.add(quad.subject.value);
      }
    }
  }

  const selectedFacts = facts.filter((quad) => selectedUnits.has(quad.subject.value));
  if (selectedFacts.length === 0 || selectedFacts.length === facts.length) {
    return runtime;
  }

  const profileAndRules = specializeQudtPreparedKernel(
    runtime.slice(0, markerIndex).trimEnd(),
    planning,
    selectedUnits,
    resolvedInputs,
    resolvedTargets,
    facts,
  );
  return [
    profileAndRules,
    '',
    PRECOMPILED_BACKGROUND_MARKER,
    `# Shape-specialized QUDT projection: ${selectedUnits.size} unit(s), ${selectedFacts.length}/${facts.length} facts.`,
    serializeQuadsAsN3(selectedFacts),
    '',
  ].join('\n');
}

function specializeQudtPreparedKernel(
  kernel: string,
  planning: ShapePlanning,
  selectedUnits: Set<string>,
  inputUnits: Set<string>,
  targetUnits: Set<string>,
  qudtFacts: Quad[],
): string {
  const inputDatatypes = shapePlanDatatypes(planning.input);
  const hasQuantityObjectInput = planning.input?.relevantClasses.includes(QUDT_QUANTITY_VALUE) ?? false;
  if (inputDatatypes.size === 0 && !hasQuantityObjectInput) {
    return kernel;
  }

  const logarithmicUnits = new Set(qudtFacts
    .filter((quad) => quad.predicate.value === RDF_TYPE && quad.object.value === QUDT_LOGARITHMIC_UNIT)
    .map((quad) => quad.subject.value));
  const memoizedMarker = kernel.indexOf('# Memoized backward helper predicates');
  if (memoizedMarker >= 0) {
    try {
      for (const quad of parseShapeQuads(kernel.slice(0, memoizedMarker))) {
        if (quad.predicate.value === QCR + 'logBase') {
          logarithmicUnits.add(quad.subject.value);
        }
      }
    } catch {
      // Keep the conservative QUDT rdf:type classification when configuration parsing fails.
    }
  }
  const sourceKinds = unitKinds(inputUnits, logarithmicUnits);
  const targetKinds = unitKinds(targetUnits, logarithmicUnits);
  const retainedRules = new Set<number>();

  if (inputDatatypes.size > 0) {
    const hasCurrentUcum = inputDatatypes.has(CDT + 'ucum');
    const hasLegacyUcum = inputDatatypes.has(LEGACY_CDT + 'ucum');
    const hasSpecificDatatype = Array.from(inputDatatypes)
      .some((datatype) => datatype !== CDT + 'ucum' && datatype !== LEGACY_CDT + 'ucum');

    if (sourceKinds.linear && targetKinds.linear) {
      if (hasSpecificDatatype) retainedRules.add(1);
      if (hasCurrentUcum) retainedRules.add(2);
      if (hasLegacyUcum) retainedRules.add(3);
    }
    if (sourceKinds.logarithmic && targetKinds.linear) retainedRules.add(5);
    if (targetKinds.logarithmic) retainedRules.add(8);
  }

  if (hasQuantityObjectInput) {
    if (sourceKinds.linear && targetKinds.linear) retainedRules.add(4);
    if (sourceKinds.logarithmic && targetKinds.linear) retainedRules.add(6);
    if (targetKinds.logarithmic) retainedRules.add(7);
  }

  if (retainedRules.size === 0) {
    return kernel;
  }

  const configuredKernel = specializeQudtPreparedConfiguration(kernel, planning, selectedUnits, targetUnits);
  const ruleSection = /\n#{20,}\n# Forward normalization rule (\d+):[\s\S]*?(?=\n#{20,}\n# )/g;
  const selectedKernel = configuredKernel.replace(ruleSection, (section, ruleNumber: string) => (
    retainedRules.has(Number(ruleNumber)) ? section : ''
  ));
  return `${selectedKernel.trimEnd()}\n\n# Shape-specialized QUDT kernel: forward rule(s) ${Array.from(retainedRules).sort((a, b) => a - b).join(', ')}.`;
}

function specializeQudtPreparedConfiguration(
  kernel: string,
  planning: ShapePlanning,
  selectedUnits: Set<string>,
  targetUnits: Set<string>,
): string {
  const memoizedMarker = '# Memoized backward helper predicates';
  const markerIndex = kernel.indexOf(memoizedMarker);
  if (markerIndex < 0) {
    return kernel;
  }
  const suffixStart = kernel.lastIndexOf('#################################################################', markerIndex);
  if (suffixStart < 0) {
    return kernel;
  }

  let configuration: Quad[];
  try {
    configuration = parseShapeQuads(kernel.slice(0, suffixStart));
  } catch {
    return kernel;
  }

  const inputDatatypes = shapePlanDatatypes(planning.input);
  const selectedProfiles = new Set(configuration
    .filter((quad) => (quad.predicate.value === QCR + 'datatype' || quad.predicate.value === QCR + 'legacyDatatype')
      && inputDatatypes.has(quad.object.value))
    .map((quad) => quad.subject.value));
  for (const quad of configuration) {
    if (quad.predicate.value === QCR + 'targetUnit' && targetUnits.has(quad.object.value)) {
      selectedProfiles.add(quad.subject.value);
    }
  }

  const selectedConfiguration = configuration.filter((quad) => selectedProfiles.has(quad.subject.value)
    || selectedUnits.has(quad.subject.value));
  if (selectedConfiguration.length === 0) {
    return kernel;
  }

  const prefixes = extractPrefixDeclarations(kernel);
  return [
    '# Shape-specialized QUDT normalization configuration.',
    ...prefixes,
    '',
    serializeQuadsAsN3(selectedConfiguration),
    '',
    kernel.slice(suffixStart).trimStart(),
  ].join('\n');
}

function shapePlanDatatypes(plan: ShapePlanning['input'] | ShapePlanning['output']): Set<string> {
  const datatypes = new Set<string>();
  for (const shape of plan?.shapes ?? []) {
    for (const property of shape.propertyPlans) {
      if (property.datatype) {
        datatypes.add(property.datatype);
      }
    }
  }
  return datatypes;
}

function unitKinds(units: Set<string>, logarithmicUnits: Set<string>): { linear: boolean; logarithmic: boolean } {
  if (units.size === 0) {
    return { linear: true, logarithmic: true };
  }
  const logarithmic = Array.from(units).some((unit) => logarithmicUnits.has(unit));
  const linear = Array.from(units).some((unit) => !logarithmicUnits.has(unit));
  return { linear, logarithmic };
}

function qudtUnitsFromShapePlan(plan: ShapePlanning['input'] | ShapePlanning['output']): string[] {
  if (!plan) {
    return [];
  }

  const units = new Set<string>();
  for (const shape of plan.shapes) {
    for (const property of shape.propertyPlans) {
      for (const unit of property.units ?? []) {
        units.add(unit);
      }
      for (const unit of property.ucumUnitIn ?? []) {
        units.add(unit);
      }
      if (property.path.type === 'predicate' && property.path.predicate === QUDT + 'unit') {
        for (const unit of [...property.hasValues, ...property.inValues]) {
          units.add(unit);
        }
      }
    }
  }
  return Array.from(units).sort();
}

function collectQudtUnitMappings(quads: Iterable<Quad>): Map<string, Set<string>> {
  const mappingPredicates = new Set([
    OWL_SAME_AS,
    'http://www.w3.org/2004/02/skos/core#exactMatch',
    QCR + 'alignedQudtUnit',
    INTERNAL + 'normalizationUnit',
  ]);
  const mappings = new Map<string, Set<string>>();

  for (const quad of quads) {
    if (!mappingPredicates.has(quad.predicate.value)
      || quad.subject.termType !== 'NamedNode'
      || quad.object.termType !== 'NamedNode') {
      continue;
    }
    const pair = [quad.subject.value, quad.object.value];
    const qudtUnit = pair.find((value) => value.startsWith(QUDT_UNIT));
    const localUnit = pair.find((value) => value !== qudtUnit);
    if (!qudtUnit || !localUnit) {
      continue;
    }
    const values = mappings.get(localUnit) ?? new Set<string>();
    values.add(qudtUnit);
    mappings.set(localUnit, values);
  }
  return mappings;
}

function resolveQudtUnits(units: Iterable<string>, mappings: Map<string, Set<string>>): Set<string> {
  const resolved = new Set<string>();
  for (const unit of units) {
    if (unit.startsWith(QUDT_UNIT)) {
      resolved.add(unit);
    }
    for (const mapped of mappings.get(unit) ?? []) {
      resolved.add(mapped);
    }
  }
  return resolved;
}

function isQudtCdtTerm(term: Term): boolean {
  const iri = term.termType === 'Literal' ? term.datatype.value : term.value;
  return (term.termType === 'NamedNode' || term.termType === 'Literal')
    && (iri.startsWith('http://qudt.org/')
      || iri.startsWith('https://qudt.org/')
      || iri.startsWith('https://w3id.org/cdt/')
      || iri.startsWith('http://w3id.org/lindt/custom_datatypes#'));
}

function quadsFromVocabulary(vocabulary: VocabularyDataset): Quad[] {
  if (Symbol.iterator in Object(vocabulary)) {
    return Array.from(vocabulary as Iterable<Quad>);
  }

  const quads: Quad[] = [];
  const dataset = vocabulary as DatasetCore & { forEach?: (callback: (quad: Quad) => void) => void };
  if (typeof dataset.forEach === 'function') {
    dataset.forEach((quad) => quads.push(quad));
    return quads;
  }

  throw new TypeError('The vocabulary dataset must be iterable or implement DatasetCore.forEach.');
}

function quadToN3(quad: Quad): string {
  const statement = `${termToN3(quad.subject)} ${termToN3(quad.predicate)} ${termToN3(quad.object)} .`;
  if (quad.graph.termType === 'DefaultGraph') {
    return statement;
  }

  return `${termToN3(quad.graph)} { ${statement} }`;
}

function termToN3(term: Term): string {
  switch (term.termType) {
    case 'NamedNode':
      return iri(term.value);
    case 'BlankNode':
      return `_:${blankNodeLabel(term.value)}`;
    case 'Literal':
      return literalToN3(term);
    case 'DefaultGraph':
      return '';
    default:
      throw new TypeError(`Unsupported RDF-JS term type in runtime serialization: ${term.termType}`);
  }
}

function literalToN3(term: Extract<Term, { termType: 'Literal' }>): string {
  const value = JSON.stringify(term.value);
  if (term.language) {
    return `${value}@${term.language}`;
  }
  if (term.datatype.value !== XSD_STRING) {
    return `${value}^^${iri(term.datatype.value)}`;
  }
  return value;
}

function iri(value: string): string {
  return `<${value.replace(/>/g, '%3E')}>`;
}

function blankNodeLabel(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
    ? value
    : `b${Buffer.from(value).toString('hex')}`;
}

function addDerived(output: Quad[], seen: Set<string>, quad: Quad, outputMode: InferenceOutputMode): void {
  if (!shouldEmitQuad(quad, outputMode)) {
    return;
  }

  const key = quadKey(quad);
  if (!seen.has(key)) {
    seen.add(key);
    output.push(quad);
  }
}

function shouldEmitQuad(quad: Quad, outputMode: InferenceOutputMode): boolean {
  if (isInternalHelperQuad(quad)) {
    return false;
  }
  if (isReflexiveSameAs(quad)) {
    return false;
  }
  if (outputMode !== 'conformance'
    && hasGeneratedSkolemTerm(quad)
    && !isShaclValidationResultQuad(quad)
    && !isPublicQudtNormalizationQuad(quad)) {
    return false;
  }
  if (outputMode !== 'conformance' && isAnonymousClassType(quad)) {
    return false;
  }

  return outputMode === 'conformance'
    || !hasLiteralSubject(quad);
}

function isPublicQudtNormalizationQuad(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && (quad.predicate.value.startsWith(QCR)
      || quad.predicate.value.startsWith(QUDT)
      || (quad.predicate.value === RDF_TYPE
        && quad.object.termType === 'NamedNode'
        && quad.object.value === QUDT + 'QuantityValue'));
}

function isReflexiveSameAs(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === OWL_SAME_AS
    && termEquals(quad.subject, quad.object);
}

function isInternalHelperQuad(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && quad.predicate.value.startsWith(INTERNAL);
}

function isShaclValidationResultQuad(quad: Quad): boolean {
  if (quad.predicate.termType !== 'NamedNode') {
    return false;
  }

  return (quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && quad.object.value === SHACL_VALIDATION_RESULT)
    || quad.predicate.value.startsWith(SHACL);
}

function hasGeneratedSkolemTerm(quad: Quad): boolean {
  return [quad.subject, quad.predicate, quad.object, quad.graph].some(isGeneratedSkolemTerm);
}

function isGeneratedSkolemTerm(term: Term): boolean {
  return term.termType === 'NamedNode'
    && term.value.startsWith(SKOLEM_BASE_IRI);
}

function isAnonymousClassType(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'BlankNode';
}

function collectInconsistencyReports(quads: Iterable<Quad>, outputMode: InferenceOutputMode): InconsistencyReport[] {
  const byId = new Map<string, { quads: Quad[]; rule?: string; terms: Map<number, Term> }>();

  for (const quad of quads) {
    if (!isInconsistencyDiagnosticQuad(quad)) {
      continue;
    }

    const id = termKey(quad.subject as Term);
    const report = byId.get(id) ?? { quads: [], terms: new Map<number, Term>() };
    report.quads.push(quad);

    if (quad.predicate.value === INCONSISTENCIES + 'rule') {
      report.rule = quad.object.value;
    } else {
      const index = inconsistencyTermIndex(quad.predicate.value);
      if (index !== undefined) {
        report.terms.set(index, quad.object as Term);
      }
    }

    byId.set(id, report);
  }

  return Array.from(byId.entries())
    .map(([id, report]) => ({
      id,
      rule: report.rule,
      terms: Array.from(report.terms.entries())
        .sort(([left], [right]) => left - right)
        .map(([, term]) => term),
      quads: report.quads,
    }))
    .filter((report) => outputMode === 'conformance'
      || !report.terms.some(isGeneratedSkolemTerm));
}

function withInconsistencyQuads(output: Quad[], source: Iterable<Quad>, outputMode: InferenceOutputMode): Quad[] {
  const result = [...output];
  const seen = new Set(result.map(quadKey));
  for (const report of collectInconsistencyReports(source, outputMode)) {
    for (const quad of report.quads) {
      const key = quadKey(quad);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(quad);
      }
    }
  }
  return result;
}

function isInconsistencyDiagnosticQuad(quad: Quad): boolean {
  if (quad.predicate.termType !== 'NamedNode') {
    return false;
  }

  return (quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && quad.object.value === INCONSISTENCY)
    || quad.predicate.value === INCONSISTENCIES + 'rule'
    || inconsistencyTermIndex(quad.predicate.value) !== undefined;
}

function inconsistencyTermIndex(predicate: string): number | undefined {
  const localName = predicate.slice(INCONSISTENCIES.length);
  return /^term[1-5]$/.test(localName) ? Number(localName.slice(4)) : undefined;
}

function hasLiteralSubject(quad: Quad): boolean {
  return (quad.subject as unknown as Term).termType === 'Literal';
}

function termEquals(left: Term, right: Term): boolean {
  if (left.termType !== right.termType || left.value !== right.value) {
    return false;
  }
  if (left.termType === 'Literal' && right.termType === 'Literal') {
    return left.language === right.language && left.datatype.value === right.datatype.value;
  }
  return true;
}

function quadKey(quad: Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph].map(termKey).join(' ');
}

function termKey(term: Term): string {
  if (term.termType === 'Literal') {
    return `"${term.value}"@${term.language}^^${term.datatype.value}`;
  }
  return `${term.termType}:${term.value}`;
}

type DeterministicSkolemOptions = Pick<InferenceOptions, 'deterministicSkolem' | 'skolemKey' | 'store' | 'storePath' | 'storeClear'>;
type BuiltinHandler = (context: { goal: { s: unknown; o: unknown }; subst: Record<string, EyelingTerm> }) => Array<Record<string, EyelingTerm>>;
type BuiltinModule = (api: DeterministicSkolemApi) => void;
type BuiltinModuleOption = string[];
interface DeterministicSkolemBuiltin {
  module: BuiltinModule;
  unregister?: (iri: string) => boolean;
}

interface DeterministicSkolemApi {
  registerBuiltin(iri: string, handler: BuiltinHandler): BuiltinHandler;
  unregisterBuiltin(iri: string): boolean;
  internIri(value: string): EyelingTerm;
  unifyTerm(left: unknown, right: unknown, subst: Record<string, EyelingTerm>): Record<string, EyelingTerm> | null;
  isGroundTerm(term: unknown): boolean;
  termToN3(term: unknown): string;
  terms?: {
    Var?: new (...args: never[]) => { name: string };
  };
}

function createDeterministicSkolemBuiltin(options: DeterministicSkolemOptions): DeterministicSkolemBuiltin | undefined {
  if (!shouldUseDeterministicSkolem(options)) {
    return undefined;
  }

  const scopeKey = deterministicSkolemScopeKey(options);
  const deterministicSkolem: DeterministicSkolemBuiltin = {
    module: (api) => {
      const { registerBuiltin, unregisterBuiltin, internIri, unifyTerm, isGroundTerm, termToN3, terms } = api;
      const Var = terms?.Var;
      deterministicSkolem.unregister = unregisterBuiltin;
      registerBuiltin(LOG_SKOLEM, ({ goal, subst }) => {
        if (!isGroundTerm(goal.s)) {
          return [];
        }

        const tupleKey = `${scopeKey}\0${termToN3(goal.s)}`;
        const node = internIri(SKOLEM_BASE_IRI + deterministicSkolemIdFromKey(tupleKey));
        if (Var && goal.o instanceof Var) {
          return [{ ...subst, [goal.o.name]: node }];
        }

        const next = unifyTerm(goal.o, node, subst);
        return next !== null ? [next] : [];
      });
    },
  };
  return deterministicSkolem;
}

function unregisterDeterministicSkolemBuiltin(deterministicSkolem: DeterministicSkolemBuiltin | undefined): void {
  deterministicSkolem?.unregister?.(LOG_SKOLEM);
}

function deterministicSkolemBuiltinModules(deterministicSkolem: DeterministicSkolemBuiltin | undefined): BuiltinModuleOption | undefined {
  return deterministicSkolem
    ? [deterministicSkolem.module] as unknown as BuiltinModuleOption
    : undefined;
}

function shouldUseDeterministicSkolem(options: DeterministicSkolemOptions): boolean {
  return options.deterministicSkolem
    ?? Boolean(options.skolemKey || options.store || options.storePath || options.storeClear);
}

function deterministicSkolemScopeKey(options: DeterministicSkolemOptions): string {
  if (options.skolemKey) {
    return `key:${options.skolemKey}`;
  }

  const store = options.store;
  if (typeof store === 'string') {
    return `store:${store}\0path:${options.storePath ?? ''}`;
  }
  if (store && typeof store === 'object') {
    return [
      'store',
      store.name,
      store.path ?? options.storePath ?? '',
      store.type ?? '',
      store.backend ?? '',
    ].join('\0');
  }

  return `storePath:${options.storePath ?? ''}`;
}

function deterministicSkolemIdFromKey(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  let h3 = 0x811c9dc5;
  let h4 = 0x811c9dc5;

  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + 1;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    h3 ^= code + 2;
    h3 = Math.imul(h3, 0x01000193) >>> 0;
    h4 ^= code + 3;
    h4 = Math.imul(h4, 0x01000193) >>> 0;
  }

  const hex = [h1, h2, h3, h4]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
