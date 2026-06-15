import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import type { DatasetCore, DataFactory, Quad, Term } from '@rdfjs/types';
import { rdfjs, reasonStream, runAsync, type EyelingTerm } from 'eyeling';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const LOG_SKOLEM = 'http://www.w3.org/2000/10/swap/log#skolem';
const SKOLEM_BASE_IRI = 'https://eyereasoner.github.io/.well-known/genid/';
const OWLRL = 'https://example.org/owlrl-n3#';
const OWLRL_INCONSISTENCY = OWLRL + 'Inconsistency';
const SHACL = 'http://www.w3.org/ns/shacl#';
const SHACL_VALIDATION_RESULT = SHACL + 'ValidationResult';
const SHACLN3 = 'https://example.org/shacl-n3#';
const INTERNAL_HELPER_PREDICATES = new Set([
  OWLRL + 'listRoot',
  OWLRL + 'intersectionListRoot',
  OWLRL + 'longIntersectionListRoot',
  OWLRL + 'keyListRoot',
  OWLRL + 'propertyChainRoot',
  OWLRL + 'listMember',
  OWLRL + 'listPair',
  OWLRL + 'left',
  OWLRL + 'right',
  OWLRL + 'allListClassTypes',
  OWLRL + 'sameValuesForProperties',
  OWLRL + 'propertyChainHolds',
  OWLRL + 'pathChain',
  OWLRL + 'pathSubject',
  OWLRL + 'pathObject',
  OWLRL + 'term',
  OWLRL + 'canonicalLiteral',
  OWLRL + 'rule',
  OWLRL + 'term1',
  OWLRL + 'term2',
  OWLRL + 'term3',
  OWLRL + 'term4',
  OWLRL + 'term5',
  SHACLN3 + 'active',
  SHACLN3 + 'focusFor',
  SHACLN3 + 'shape',
  SHACLN3 + 'focus',
  SHACLN3 + 'path',
  SHACLN3 + 'value',
]);

export type RuleProfile = string | { n3?: string; text?: string; label?: string; baseIri?: string };
export type VocabularyDataset = DatasetCore | Iterable<Quad>;

export interface LoadedRuleProfile {
  n3: string;
  label?: string;
  baseIri?: string;
}

export interface InferenceEngineOptions {
  runtime?: string;
  runtimePath?: string;
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
}

export class InferenceEngine {
  private runtime = '';
  private staticClosure: Quad[] = [];
  private readonly dataFactory: DataFactory;
  private readonly runtimeCompiler: RuntimeCompiler;
  private readonly outputMode: InferenceOutputMode;

  public constructor(options: InferenceEngineOptions = {}) {
    this.dataFactory = options.dataFactory ?? rdfjs;
    this.runtimeCompiler = options.runtimeCompiler ?? defaultRuntimeCompiler;
    this.outputMode = options.outputMode ?? 'application';

    if (options.runtimePath) {
      this.runtime = readFileSync(options.runtimePath, 'utf8');
    } else if (options.runtime) {
      this.runtime = options.runtime;
    }
  }

  public getRuntime(): string {
    return this.runtime;
  }

  public getStaticClosure(options: InferenceOptions = {}): Quad[] {
    const outputMode = options.outputMode ?? this.outputMode;
    return this.staticClosure.filter((quad) => shouldEmitQuad(quad, outputMode));
  }

  public getStaticInconsistencies(options: InferenceOptions = {}): InconsistencyReport[] {
    const outputMode = options.outputMode ?? this.outputMode;
    return collectInconsistencyReports(this.staticClosure, outputMode);
  }

  public load(vocabulary: VocabularyDataset, options?: LoadOptions): string;
  public load(profiles: RuleProfile | RuleProfile[], vocabulary: VocabularyDataset, options?: LoadOptions): string;
  public load(profilesOrVocabulary: RuleProfile | RuleProfile[] | VocabularyDataset, vocabularyOrOptions?: VocabularyDataset | LoadOptions, options: LoadOptions = {}): string {
    const { profiles, vocabulary, loadOptions } = normalizeLoadArguments(profilesOrVocabulary, vocabularyOrOptions, options);
    const normalizedProfiles = normalizeProfiles(profiles);
    const profileN3 = normalizedProfiles.map((profile) => profile.n3).join('\n\n');
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

    const runtimeCompiler = loadOptions.runtimeCompiler ?? this.runtimeCompiler;
    this.runtime = runtimeCompiler({
      profiles: normalizedProfiles,
      profileN3,
      vocabulary: vocabularyQuads,
      closure: this.staticClosure,
      dataFactory: this.dataFactory,
      options: loadOptions,
    });

    return this.runtime;
  }

  public saveRuntime(pathOrOptions: string | SaveOptions): void {
    const path = typeof pathOrOptions === 'string' ? pathOrOptions : pathOrOptions.path;
    writeFileSync(path, this.runtime, 'utf8');
  }

  public *infer(data: Quad[], options: InferenceOptions = {}): Generator<Quad> {
    this.assertLoaded();
    const derived: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);

    try {
      reasonStream({ n3: this.runtime, quads: data }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    yield* derived;
  }

  public inferWithDiagnostics(data: Quad[], options: InferenceOptions = {}): InferenceResult {
    this.assertLoaded();
    const derived: Quad[] = [];
    const diagnostics: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);

    try {
      reasonStream({ n3: this.runtime, quads: data }, {
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

    return {
      quads: derived,
      inconsistencies: collectInconsistencyReports([...this.staticClosure, ...diagnostics], outputMode),
    };
  }

  public async inferAsync(data: Quad[], options: InferenceOptions = {}): Promise<Quad[]> {
    this.assertLoaded();
    if (!options.store && !options.storePath && !options.storeClear) {
      return Array.from(this.infer(data, options));
    }

    const derived: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);
    let result: Awaited<ReturnType<typeof runAsync>>;
    try {
      result = await runAsync({ n3: this.runtime, quads: data }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        store: options.store,
        storePath: options.storePath,
        storeClear: options.storeClear,
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
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

    return derived;
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
    let result: Awaited<ReturnType<typeof runAsync>>;
    try {
      result = await runAsync({ n3: this.runtime, quads: data }, {
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

    return {
      quads: derived,
      inconsistencies: collectInconsistencyReports([...this.staticClosure, ...diagnostics], outputMode),
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

    const files = readdirSync(candidate).filter((file) => file.endsWith('.n3')).sort();
    if (files.length === 0) {
      continue;
    }

    return files.map((file) => ({
      n3: readFileSync(join(candidate, file), 'utf8'),
      label: `rules/${file}`,
    }));
  }

  throw new Error('Could not find default rule profiles. Pass explicit rule profiles to load(...) or install the package with rules/*.n3.');
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
    && ('n3' in value || 'text' in value || 'label' in value || 'baseIri' in value)
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
      || 'deterministicSkolem' in value
      || 'skolemKey' in value
      || Object.keys(value).length === 0);
}

export function defaultRuntimeCompiler(input: RuntimeCompilerInput): string {
  const sections = ['# Generated inference runtime. Do not edit by hand.'];

  if (input.profileN3.trim()) {
    sections.push('', '# Rule profiles', input.profileN3.trimEnd());
  }

  if (input.options.includeStaticClosure !== false) {
    const backgroundClosure = uniqueQuads([...input.vocabulary, ...input.closure]);
    if (backgroundClosure.length > 0) {
      sections.push('', '# Precomputed background facts and closure', serializeQuadsAsN3(backgroundClosure).trimEnd());
    }
  }

  return `${sections.join('\n')}\n`;
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
    };
  });
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
  if (outputMode !== 'conformance' && hasGeneratedSkolemTerm(quad) && !isShaclValidationResultQuad(quad)) {
    return false;
  }
  if (outputMode !== 'conformance' && isAnonymousClassType(quad)) {
    return false;
  }

  return outputMode === 'conformance'
    || !hasLiteralSubject(quad);
}

function isReflexiveSameAs(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === OWL_SAME_AS
    && termEquals(quad.subject, quad.object);
}

function isInternalHelperQuad(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && INTERNAL_HELPER_PREDICATES.has(quad.predicate.value);
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

    if (quad.predicate.value === OWLRL + 'rule') {
      report.rule = quad.object.value;
    } else if (quad.predicate.value.startsWith(OWLRL + 'term')) {
      const index = Number.parseInt(quad.predicate.value.slice((OWLRL + 'term').length), 10);
      if (Number.isInteger(index)) {
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

function isInconsistencyDiagnosticQuad(quad: Quad): boolean {
  if (quad.predicate.termType !== 'NamedNode') {
    return false;
  }

  return (quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && quad.object.value === OWLRL_INCONSISTENCY)
    || quad.predicate.value === OWLRL + 'rule'
    || /^https:\/\/example\.org\/owlrl-n3#term[1-5]$/.test(quad.predicate.value);
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
