export { InferenceEngine, defaultRuntimeCompiler, loadDefaultRuleProfiles, serializeQuadsAsN3 } from './InferenceEngine';
export { compileShaclShapeGraph, createShapePlanning, parseShapePlanningFromRuntime, shapePlanningSummary } from './shacl-shape-planning';
export type {
  InferenceEngineOptions,
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
