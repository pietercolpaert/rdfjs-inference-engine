import { InferenceEngine, loadDefaultRuleProfiles, defaultRuntimeCompiler } from './InferenceEngine';
import { createSparqlConstructGenerator, withRdfBackground, type SparqlConstructDiagnostic } from './sparql-construct-core';
export type { SparqlConstructInput, SparqlConstructResult, SparqlConstructMapping, SparqlConstructDiagnostic } from './sparql-construct-core';
/** Compile the same shape-specialized runtime used by the inference engine. */
export const generateSparqlConstruct = createSparqlConstructGenerator((profiles, ontology, shaclIn, shaclOut) => {
  const engine = new InferenceEngine();
  let excluded = 0;
  const runtime = engine.load(profiles, ontology, { shaclIn, shaclOut,
    runtimeCompiler: withRdfBackground(defaultRuntimeCompiler, count => { excluded = count; }) });
  const diagnostics: SparqlConstructDiagnostic[] = excluded ? [{ severity: 'warning',
    message: `Excluded ${excluded} generalized RDF background facts with literal subjects; SPARQL uses the RDF/JS-compatible closure. Generalized datatype entailment is unavailable.` }] : [];
  return { runtime, diagnostics };
}, loadDefaultRuleProfiles);
