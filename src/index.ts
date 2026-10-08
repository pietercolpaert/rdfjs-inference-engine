export { InferenceEngine, defaultRuntimeCompiler, loadDefaultRuleProfiles, serializeQuadsAsN3 } from './InferenceEngine';
export { compileShaclShapeGraph, createShapePlanning, deserializeShapePlanning, projectOutputWithShapePlanning, serializeShapePlanning, shapePlanningSummary } from './shacl-shape-planning';
export type {
  InferenceEngineOptions,
  InferenceOptions,
  InferenceStoreOptions,
  InferenceResult,
  InconsistencyReport,
  LoadedRuleProfile,
  LoadOptions,
  RuleProfile,
  RuntimeCompiler,
  RuntimeCompilerInput,
  SaveOptions,
  ShaclShapeInput,
  VocabularyDataset,
} from './InferenceEngine';
export type {
  CompiledShaclPath,
  CompactShapeRecord,
  IndexSpec,
  JoinOrderHint,
  PathMetadata,
  PropertyShapePlan,
  ShapeDirection,
  ShapeGraphPlan,
  ShapeInputOptimization,
  ShapePlan,
  ShapePlanning,
} from './shacl-shape-planning';

export { generateSparqlConstruct } from './sparql-construct';
export type { SparqlConstructInput, SparqlConstructResult, SparqlConstructMapping, SparqlConstructDiagnostic } from './sparql-construct';

export { translateN3RuntimeToSparql, executeSparqlRuntime, createRdfjsSparqlExecutor } from './n3-to-sparql';
export type { RdfjsSparqlEngine, N3SparqlDiagnostic, N3SparqlResult, N3SparqlOptions, SparqlRuntimeProgram, SparqlQueryExecutor, SparqlRuntimeExecutionOptions, SparqlRuntimeExecutionResult } from './n3-to-sparql';
