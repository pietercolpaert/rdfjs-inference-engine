import type { Quad, Term } from '@rdfjs/types';
import { isQudtProperty, planQudtConversion, type QudtConversionPlan } from './sparql-qudt';
import { compileShaclShapeGraph, type CompiledShaclPath, type ShapePlan } from './shacl-shape-planning';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const SH = 'http://www.w3.org/ns/shacl#';

type Step = { predicate: string; inverse: boolean };
export interface SparqlConstructInput {
  ontology: Iterable<Quad>;
  shaclIn: Iterable<Quad>;
  shaclOut: Iterable<Quad>;
}
export interface SparqlConstructDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  shape?: string;
  path?: string;
}
export interface SparqlConstructMapping {
  providerShape: string;
  consumerShape: string;
  sourcePaths: string[];
  targetPath: string;
  required: boolean;
  conversion?: { sourceUnits: string[]; targetUnit: string };
}
export interface SparqlConstructResult {
  /** Null when a required mapping or a supported output structure cannot be resolved. */
  query: string | null;
  mappings: SparqlConstructMapping[];
  diagnostics: SparqlConstructDiagnostic[];
}

/** Compile a per-message, default-graph mapping. Focus-node identities are preserved. Values are copied or converted using explicit QUDT metadata.
 * This is a mapping compiler, not a SHACL validator or a complete OWL reasoner.
 */
export function generateSparqlConstruct(input: SparqlConstructInput): SparqlConstructResult {
  const ontology = Array.from(input.ontology);
  const providerQuads = Array.from(input.shaclIn);
  const consumerQuads = Array.from(input.shaclOut);
  const providers = rootShapes(compileShaclShapeGraph(providerQuads, 'in').shapes, providerQuads).flatMap(shape =>
    shape.targetClasses.length > 1 ? shape.targetClasses.map(target => ({ ...shape, targetClasses: [target] })) : [shape]);
  const consumers = rootShapes(compileShaclShapeGraph(consumerQuads, 'out').shapes, consumerQuads);
  const diagnostics: SparqlConstructDiagnostic[] = [];
  const mappings: SparqlConstructMapping[] = [];
  const templates: string[] = [];
  const branches: string[] = [];
  const properties = relationGraph(ontology, RDFS + 'subPropertyOf', OWL + 'equivalentProperty', true);
  const classes = relationGraph(ontology, RDFS + 'subClassOf', OWL + 'equivalentClass', false);
  const report = (severity: 'error' | 'warning', message: string, shape?: string, path?: string) => {
    diagnostics.push({ severity, message, shape, path });
  };
  if (!providers.length || !consumers.length) {
    report('error', 'Both provider and consumer inputs must contain a usable SHACL shape.');
  }
  // The shared SHACL planner intentionally skips malformed paths; a query compiler must report them.
  for (const [quads, shapes] of [[providerQuads, providers], [consumerQuads, consumers]] as const) {
    const compiled = new Set(shapes.flatMap(shape => shape.propertyPlans.map(property => property.propertyShape)));
    for (const quad of quads) {
      if (quad.predicate.value === SH + 'path' && !compiled.has(id(quad.subject))) {
        report('error', 'A SHACL path could not be compiled, or its property shape is unattached.', id(quad.subject));
      }
    }
  }
  const supported = new Set(['NodeShape', 'PropertyShape', 'targetClass', 'targetNode',
    'property', 'path', 'inversePath', 'alternativePath', 'zeroOrMorePath',
    'oneOrMorePath', 'zeroOrOnePath', 'minCount', 'maxCount', 'datatype', 'class', 'nodeKind',
    'hasValue', 'in', 'unit', 'closed', 'ignoredProperties', 'name', 'description', 'order', 'message', 'severity']);
  for (const quad of consumerQuads) {
    if (quad.predicate.value === SH + 'unit' && quad.object.termType !== 'NamedNode') {
      report('error', 'sh:unit must specify one unit IRI, not an RDF list or literal.', id(quad.subject));
    }
    if (quad.predicate.value.startsWith('https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#')) {
      report('error', 'CDT unit encodings and custom QUDT extensions are not supported by the SPARQL mapping compiler.', id(quad.subject));
    }
    if (quad.predicate.value.startsWith(SH) && !supported.has(quad.predicate.value.slice(SH.length))) {
      report('error', `Unsupported consumer constraint: ${quad.predicate.value}.`, id(quad.subject));
    }
  }
  let branchIndex = 0;
  for (const consumer of consumers) {
    // Multiple target classes select a union of focus nodes, while sh:class constraints all apply.
    const compatible = providers.filter(provider => {
      const known = [...provider.targetClasses, ...provider.classes];
      return (!consumer.targetClasses.length || consumer.targetClasses.some(target => known.some(source => reachable(classes, source, target))))
        && consumer.classes.every(target => known.some(source => reachable(classes, source, target)));
    });
    if (!compatible.length) {
      report('error', 'No provider shape entails the consumer focus-node classes.', consumer.shape);
      continue;
    }
    for (const provider of compatible) {
      const known = [...provider.targetClasses, ...provider.classes];
      const wantedClasses = [...new Set([...consumer.classes, ...consumer.targetClasses.filter(target => known.some(source => reachable(classes, source, target)))])];
      const root = `?focus${branchIndex++}`;
      const where: string[] = [];
      const selectors: string[] = [];
      for (const value of provider.targetClasses) {
        const sourceClasses = [...new Set([value, ...ontology.filter(q => q.subject.termType === 'NamedNode')
          .map(q => q.subject.value).filter(source => reachable(classes, source, value))])];
        selectors.push(`{ ${root} ${iri(RDF + 'type')} ?type${branchIndex} . VALUES ?type${branchIndex} { ${sourceClasses.map(iri).join(' ')} } }`);
      }
      for (const value of provider.targetNodes) selectors.push(`{ VALUES ${root} { ${termById(providerQuads, value)} } }`);
      for (const value of provider.targetSubjectsOf) selectors.push(`{ ${root} ${iri(value)} ?anchor${branchIndex} . }`);
      for (const value of provider.targetObjectsOf) selectors.push(`{ ?anchor${branchIndex} ${iri(value)} ${root} . }`);
      if (!selectors.length) {
        const paths = provider.propertyPlans.map(p => `${root} ${pathText(p.path)} ?anchor${branchIndex} .`);
        if (paths.length) selectors.push(...paths.map(path => `{ ${path} }`));
        else report('error', 'Provider shape needs a target or a property path to select focus nodes.', provider.shape);
      }
      where.push(selectors.length === 1 ? selectors[0] : `{ ${selectors.join(' UNION ')} }`);
      for (const [index, targetClass] of wantedClasses.entries()) {
        if (provider.classes.some(source => reachable(classes, source, targetClass))) continue;
        const sourceClasses = [...new Set([targetClass, ...ontology.filter(q => q.subject.termType === 'NamedNode')
          .map(q => q.subject.value).filter(source => reachable(classes, source, targetClass))])];
        where.push(`FILTER EXISTS { ${root} ${iri(RDF + 'type')} ?focusType${branchIndex}_${index} . VALUES ?focusType${branchIndex}_${index} { ${sourceClasses.map(iri).join(' ')} } }`);
      }
      if (consumer.targetNodes.length) where.push(`VALUES ${root} { ${consumer.targetNodes.map(value => termById(consumerQuads, value)).join(' ')} }`);
      for (const value of wantedClasses) templates.push(`${root} ${iri(RDF + 'type')} ${iri(value)} .`);
      let qudt: QudtConversionPlan | undefined;
      try { qudt = planQudtConversion(ontology, provider, consumer, root, branchIndex, iri); }
      catch (error) { report('error', error instanceof Error ? error.message : String(error), consumer.shape); continue; }
      if (qudt) where.push(qudt.pattern);
      for (const [propertyIndex, target] of consumer.propertyPlans.entries()) {
        if (target.maxCount === 0) continue;
        if (target.units.length && (!qudt || !isQudtProperty(target, 'numericValue'))) {
          report('error', 'sh:unit conversion is supported on direct qudt:numericValue paths with a required output qudt:unit.', consumer.shape, target.pathText);
          continue;
        }
        const converted = qudt && (isQudtProperty(target, 'numericValue') || isQudtProperty(target, 'unit'));
        const outputSteps = linearPath(target.path);
        if (!outputSteps) {
          report('error', 'Consumer paths must be predicates, inverse paths, or sequences; alternative and repeated output paths are ambiguous to construct.', consumer.shape, target.pathText);
          continue;
        }
        const candidates = provider.propertyPlans.flatMap(source => pathAlternatives(source.path)
          .filter(steps => steps.length === outputSteps.length && steps.every((step, index) =>
            reachable(properties, stepKey(step), stepKey(outputSteps[index]))))
          .map(steps => ({ source, steps })));
        if (!candidates.length) {
          report(target.required || target.hasValues.length ? 'error' : 'warning',
            'No documented provider path maps to this consumer path.', consumer.shape, target.pathText);
          continue;
        }
        const value = converted ? (isQudtProperty(target, 'numericValue') ? qudt!.numericVariable : qudt!.unitVariable) : `?value${branchIndex}_${propertyIndex}`;
        const nodes = [root, ...outputSteps.slice(1).map((_, index) => `?node${branchIndex}_${propertyIndex}_${index}`), value];
        const patterns = candidates.map(candidate => `{ ${candidate.steps.map((step, index) => triple(nodes[index], step, nodes[index + 1])).join(' ')} }`);
        let pattern = converted ? '' : patterns.length === 1 ? patterns[0] : `{ ${patterns.join(' UNION ')} }`;
        const filters: string[] = [];
        if (target.datatype) filters.push(`isLiteral(${value}) && DATATYPE(${value}) = ${iri(target.datatype)}`);
        if (target.inValues.length) filters.push(`${value} IN (${target.inValues.map(v => termById(consumerQuads, v)).join(', ')})`);
        if (target.nodeKind) {
          const kinds: Record<string, string> = { IRI: `isIRI(${value})`, BlankNode: `isBlank(${value})`, Literal: `isLiteral(${value})`,
            BlankNodeOrIRI: `!isLiteral(${value})`, BlankNodeOrLiteral: `!isIRI(${value})`, IRIOrLiteral: `!isBlank(${value})` };
          const filter = kinds[target.nodeKind.slice(SH.length)];
          if (filter) filters.push(filter);
          else report('error', 'Unknown sh:nodeKind.', consumer.shape, target.pathText);
        }
        if (target.class) {
          // Assert the output class only for values whose input type entails that class.
          const types = [...new Set([target.class, ...ontology.filter(q => q.subject.termType === 'NamedNode')
            .map(q => q.subject.value).filter(source => reachable(classes, source, target.class!))])];
          pattern += ` ${value} ${iri(RDF + 'type')} ?valueType${branchIndex}_${propertyIndex} . VALUES ?valueType${branchIndex}_${propertyIndex} { ${types.map(iri).join(' ')} }`;
          templates.push(`${value} ${iri(RDF + 'type')} ${iri(target.class)} .`);
        }
        if (filters.length) pattern += ` FILTER (${filters.map(f => `(${f})`).join(' && ')})`;
        const required = target.required || target.hasValues.length > 0;
        where.push(required ? pattern : `OPTIONAL { ${pattern} }`);
        // sh:hasValue requires the value to already exist; never fabricate a missing value.
        for (const constant of target.hasValues) {
          if (converted) {
            where.push(`FILTER (sameTerm(${value}, ${termById(consumerQuads, constant)}))`);
            continue;
          }
          const constantPatterns = candidates.map(candidate => `{ ${root} ${candidate.steps.map(step => step.inverse ? `^${iri(step.predicate)}` : iri(step.predicate)).join('/')} ${termById(consumerQuads, constant)} . }`);
          where.push(`FILTER EXISTS { ${constantPatterns.join(' UNION ')} }`);
        }
        templates.push(...outputSteps.map((step, index) => triple(nodes[index], step, nodes[index + 1])));
        mappings.push({ providerShape: provider.shape, consumerShape: consumer.shape,
          sourcePaths: [...new Set(candidates.map(c => c.source.pathText))], targetPath: target.pathText, required,
          ...(converted && isQudtProperty(target, 'numericValue') ? { conversion: { sourceUnits: qudt!.sourceUnits, targetUnit: qudt!.targetUnit } } : {}) });
        if ((target.minCount ?? 0) > 1 || target.maxCount !== undefined) {
          report('warning', 'Cardinality is not repaired or validated; validate the constructed message against the consumer shape.', consumer.shape, target.pathText);
        }
      }
      branches.push(`{\n${where.map(line => `    ${line}`).join('\n')}\n  }`);
    }
  }
  return {
    query: diagnostics.some(d => d.severity === 'error') ? null :
      `CONSTRUCT {\n${[...new Set(templates)].map(line => `  ${line}`).join('\n')}\n}\nWHERE {\n  ${branches.join('\n  UNION\n  ')}\n}\n`,
    mappings, diagnostics,
  };
}

function rootShapes(shapes: ShapePlan[], quads: Quad[]): ShapePlan[] {
  const attached = new Set(quads.filter(q => q.predicate.value === SH + 'property').map(q => id(q.object)));
  return shapes.filter(shape => !attached.has(shape.shape));
}

function iri(value: string): string {
  if (/[<>"{}|^`\\\u0000-\u0020]/u.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error(`Invalid absolute IRI: ${value}`);
  return `<${value}>`;
}
function id(term: Term): string {
  if (term.termType === 'NamedNode') return term.value;
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  if (term.termType === 'Literal') return term.language ? `"${term.value}"@${term.language}` : `"${term.value}"^^${term.datatype.value}`;
  return term.value;
}
function termById(quads: Quad[], value: string): string {
  const term = quads.flatMap(q => [q.subject, q.object]).find(term => id(term) === value);
  if (!term) throw new Error(`Cannot find RDF term: ${value}`);
  if (term.termType === 'NamedNode') return iri(term.value);
  if (term.termType === 'Literal') return JSON.stringify(term.value) + (term.language ? `@${term.language}` : `^^${iri(term.datatype.value)}`);
  throw new Error('Blank nodes cannot be used as fixed query values. Use an IRI or literal.');
}
function triple(subject: string, step: Step, object: string): string {
  return step.inverse ? `${object} ${iri(step.predicate)} ${subject} .` : `${subject} ${iri(step.predicate)} ${object} .`;
}
function stepKey(step: Step): string { return `${step.inverse ? '^' : ''}${step.predicate}`; }
function linearPath(path: CompiledShaclPath): Step[] | undefined {
  if (path.type === 'predicate') return [{ predicate: path.predicate, inverse: false }];
  if (path.type === 'inverse') return linearPath(path.path)?.reverse().map(step => ({ ...step, inverse: !step.inverse }));
  if (path.type === 'sequence') {
    const items = path.items.map(linearPath);
    return items.every(item => item !== undefined) ? items.flat() as Step[] : undefined;
  }
  return undefined;
}
function pathAlternatives(path: CompiledShaclPath): Step[][] {
  if (path.type === 'alternative') return path.alternatives.flatMap(pathAlternatives);
  if (path.type === 'inverse') return pathAlternatives(path.path).map(steps => steps.reverse().map(step => ({ ...step, inverse: !step.inverse })));
  if (path.type === 'sequence') return path.items.reduce<Step[][]>((paths, item) => paths.flatMap(prefix => pathAlternatives(item).map(suffix => [...prefix, ...suffix])), [[]]);
  const steps = linearPath(path);
  return steps ? [steps] : [];
}
function pathText(path: CompiledShaclPath): string {
  switch (path.type) {
    case 'predicate': return iri(path.predicate);
    case 'inverse': return `^(${pathText(path.path)})`;
    case 'sequence': return `(${path.items.map(pathText).join('/')})`;
    case 'alternative': return `(${path.alternatives.map(pathText).join('|')})`;
    case 'zeroOrMore': return `(${pathText(path.path)})*`;
    case 'oneOrMore': return `(${pathText(path.path)})+`;
    case 'zeroOrOne': return `(${pathText(path.path)})?`;
  }
}
function relationGraph(quads: Quad[], sub: string, equivalent: string, inverses: boolean): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { const edges = graph.get(a) ?? new Set<string>(); edges.add(b); graph.set(a, edges); };
  const edge = (a: string, b: string) => { add(a, b); if (inverses) add(`^${a}`, `^${b}`); };
  for (const quad of quads) {
    if (quad.subject.termType !== 'NamedNode' || quad.object.termType !== 'NamedNode') continue;
    const a = quad.subject.value, b = quad.object.value;
    if (quad.predicate.value === sub) edge(a, b);
    if (quad.predicate.value === equivalent) { edge(a, b); edge(b, a); }
    if (inverses && quad.predicate.value === OWL + 'inverseOf') {
      add(a, `^${b}`); add(`^${b}`, a); add(b, `^${a}`); add(`^${a}`, b);
    }
  }
  return graph;
}
function reachable(graph: Map<string, Set<string>>, from: string, to: string): boolean {
  const pending = [from], seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...graph.get(current) ?? []);
  }
  return false;
}
