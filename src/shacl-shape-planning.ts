import type { Quad, Term } from '@rdfjs/types';

export const SHACL_SHAPE_PLANNING_VERSION = 2;

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';

const RDF_TYPE = RDF + 'type';
const RDF_FIRST = RDF + 'first';
const RDF_REST = RDF + 'rest';
const RDF_NIL = RDF + 'nil';
const SH_NODE_SHAPE = SH + 'NodeShape';
const SH_PROPERTY_SHAPE = SH + 'PropertyShape';

export type ShapeDirection = 'in' | 'out';

export type CompiledShaclPath =
  | { type: 'predicate'; predicate: string }
  | { type: 'inverse'; path: CompiledShaclPath }
  | { type: 'sequence'; items: CompiledShaclPath[] }
  | { type: 'alternative'; alternatives: CompiledShaclPath[] }
  | { type: 'zeroOrMore'; path: CompiledShaclPath }
  | { type: 'oneOrMore'; path: CompiledShaclPath }
  | { type: 'zeroOrOne'; path: CompiledShaclPath };

export interface PathMetadata {
  predicates: string[];
  mayBeEmpty: boolean;
  mayRepeat: boolean;
  hasInverse: boolean;
  hasAlternative: boolean;
}

export interface PropertyShapePlan {
  propertyShape: string;
  path: CompiledShaclPath;
  pathText: string;
  metadata: PathMetadata;
  minCount?: number;
  maxCount?: number;
  datatype?: string;
  class?: string;
  nodeKind?: string;
  hasValues: string[];
  inValues: string[];
  units: string[];
  scalar: boolean;
  required: boolean;
  indexSpecs: IndexSpec[];
  joinOrderHints: JoinOrderHint[];
}

export interface IndexSpec {
  kind: 'subject-predicate' | 'object-predicate' | 'predicate' | 'type';
  predicate?: string;
  path?: string;
  reason: string;
}

export interface JoinOrderHint {
  path: string;
  predicate: string;
  direction: 'forward' | 'inverse' | 'mixed';
  scalar: boolean;
  required: boolean;
  rank: number;
}

export interface ShapePlan {
  shape: string;
  targetClasses: string[];
  targetNodes: string[];
  targetSubjectsOf: string[];
  targetObjectsOf: string[];
  propertyPlans: PropertyShapePlan[];
  allowedPredicates: string[];
  ignoredPredicates: string[];
  requiredPaths: string[];
  optionalPaths: string[];
  scalarPaths: string[];
  repeatedPaths: string[];
  relevantPredicates: string[];
  relevantClasses: string[];
  recommendedMessageIndexes: IndexSpec[];
  recommendedJoinOrderHints: JoinOrderHint[];
  closed: boolean;
}

export interface ShapeGraphPlan {
  direction: ShapeDirection;
  shapes: ShapePlan[];
  relevantPredicates: string[];
  relevantClasses: string[];
  pathTexts: string[];
  scalarPaths: string[];
  repeatedPaths: string[];
  recommendedMessageIndexes: IndexSpec[];
  recommendedJoinOrderHints: JoinOrderHint[];
}

export interface ShapePlanning {
  version: number;
  input?: ShapeGraphPlan;
  output?: ShapeGraphPlan;
  relevantInputPredicates: string[];
  relevantOutputPredicates: string[];
  relevantPredicates: string[];
  relevantClasses: string[];
  recommendedMessageIndexes: IndexSpec[];
  recommendedJoinOrderHints: JoinOrderHint[];
}

export interface CompactShapeRecord {
  focusNode: string;
  shapes: string[];
  scalarValues: Record<string, string | undefined>;
  repeatedValues: Record<string, string[]>;
}

export interface ShapeInputOptimization {
  enabled: boolean;
  originalQuadCount: number;
  optimizedQuadCount: number;
  selectedShapes: string[];
  droppedQuadCount: number;
  retainedPredicates: string[];
  indexesBuilt: IndexSpec[];
  joinOrderHints: JoinOrderHint[];
  compactRecords: CompactShapeRecord[];
  quads: Quad[];
}

interface OutputProjectionPlan {
  allowedPredicates: Set<string>;
  unconstrainedPredicates: Set<string>;
  allowedObjectsByPredicate: Map<string, Set<string>>;
}

interface ShapeGraphIndex {
  bySubjectPredicate: Map<string, Term[]>;
}

interface RuntimeShapePlanning {
  v: number;
  i?: RuntimeShapeGraph;
  o?: RuntimeShapeGraph;
}

interface RuntimeShapeGraph {
  d: ShapeDirection;
  s: RuntimeShape[];
}

interface RuntimeShape {
  s: string;
  tc: string[];
  tn: string[];
  ts: string[];
  to: string[];
  p: RuntimePropertyShape[];
  ip: string[];
  c: boolean;
}

interface RuntimePropertyShape {
  s: string;
  p: CompiledShaclPath;
  min?: number;
  max?: number;
  dt?: string;
  cl?: string;
  nk?: string;
  h: string[];
  i: string[];
  u: string[];
}

export function compileShaclShapeGraph(quads: Iterable<Quad>, direction: ShapeDirection): ShapeGraphPlan {
  const graphQuads = Array.from(quads);
  const index = buildShapeGraphIndex(graphQuads);
  const shapeTerms = discoverNodeShapeTerms(graphQuads, index);
  const shapes = shapeTerms
    .map((shape) => compileShapePlan(shape, index))
    .filter((shape): shape is ShapePlan => shape !== undefined);

  return {
    direction,
    shapes,
    relevantPredicates: sortedUnion(shapes.flatMap((shape) => shape.relevantPredicates)),
    relevantClasses: sortedUnion(shapes.flatMap((shape) => shape.relevantClasses)),
    pathTexts: sortedUnion(shapes.flatMap((shape) => shape.propertyPlans.map((property) => property.pathText))),
    scalarPaths: sortedUnion(shapes.flatMap((shape) => shape.scalarPaths)),
    repeatedPaths: sortedUnion(shapes.flatMap((shape) => shape.repeatedPaths)),
    recommendedMessageIndexes: dedupeIndexSpecs(shapes.flatMap((shape) => shape.recommendedMessageIndexes)),
    recommendedJoinOrderHints: sortJoinOrderHints(shapes.flatMap((shape) => shape.recommendedJoinOrderHints)),
  };
}

export function createShapePlanning(input?: ShapeGraphPlan, output?: ShapeGraphPlan): ShapePlanning | undefined {
  if (!input && !output) {
    return undefined;
  }

  return {
    version: SHACL_SHAPE_PLANNING_VERSION,
    input,
    output,
    relevantInputPredicates: input?.relevantPredicates ?? [],
    relevantOutputPredicates: output?.relevantPredicates ?? [],
    relevantPredicates: sortedUnion([...(input?.relevantPredicates ?? []), ...(output?.relevantPredicates ?? [])]),
    relevantClasses: sortedUnion([...(input?.relevantClasses ?? []), ...(output?.relevantClasses ?? [])]),
    recommendedMessageIndexes: dedupeIndexSpecs([...(input?.recommendedMessageIndexes ?? []), ...(output?.recommendedMessageIndexes ?? [])]),
    recommendedJoinOrderHints: sortJoinOrderHints([...(input?.recommendedJoinOrderHints ?? []), ...(output?.recommendedJoinOrderHints ?? [])]),
  };
}

export function shapePlanningSummary(planning: ShapePlanning): string[] {
  const lines = [
    `# Shape-guided rule selection: version ${planning.version}`,
    `# rdfjs-inference-engine shapePlanning=${JSON.stringify(compactRuntimeShapePlanning(planning))}`,
  ];

  appendGraphPlanSummary(lines, 'Input SHACL shape plan', planning.input);
  appendGraphPlanSummary(lines, 'Output SHACL shape plan', planning.output);
  appendList(lines, 'Shape-guided input predicates', planning.relevantInputPredicates);
  appendList(lines, 'Shape-guided output predicates', planning.relevantOutputPredicates);
  appendList(lines, 'Shape-guided classes/values', planning.relevantClasses);
  appendList(lines, 'Shape-guided temporary indexes', planning.recommendedMessageIndexes.map(indexSpecToText));
  appendList(lines, 'Shape-guided join hints', planning.recommendedJoinOrderHints.map(joinOrderHintToText));
  return lines;
}

export function optimizeInputWithShapePlanning(quads: Iterable<Quad>, planning: ShapePlanning | undefined): ShapeInputOptimization {
  const inputQuads = Array.from(quads);
  if (!planning?.input) {
    return {
      enabled: false,
      originalQuadCount: inputQuads.length,
      optimizedQuadCount: inputQuads.length,
      selectedShapes: [],
      droppedQuadCount: 0,
      retainedPredicates: sortedUnion(inputQuads.map((quad) => quad.predicate.value)),
      indexesBuilt: [],
      joinOrderHints: [],
      compactRecords: [],
      quads: inputQuads,
    };
  }

  const inputPlan = planning.input;
  const indexes = buildTemporaryIndexes(inputQuads, inputPlan.recommendedMessageIndexes);
  const selectedShapes = selectInputShapes(inputPlan, indexes);
  const activeShapes = selectedShapes.length > 0 ? selectedShapes : inputPlan.shapes;
  const activeShapeIds = activeShapes.map((shape) => shape.shape);
  const closedPredicates = new Set(activeShapes.filter((shape) => shape.closed).flatMap((shape) => shape.allowedPredicates));
  const hasClosedShape = activeShapes.some((shape) => shape.closed);
  const retainedPredicateSet = new Set<string>(hasClosedShape
    ? closedPredicates
    : inputPlan.relevantPredicates);
  const retainedQuads = hasClosedShape
    ? inputQuads.filter((quad) => retainedPredicateSet.has(quad.predicate.value))
    : inputQuads.slice();
  const orderedQuads = orderQuadsForJoinHints(retainedQuads, inputPlan.recommendedJoinOrderHints);
  const compactRecords = compactRecordsForShapes(activeShapes, indexes);

  return {
    enabled: true,
    originalQuadCount: inputQuads.length,
    optimizedQuadCount: orderedQuads.length,
    selectedShapes: activeShapeIds,
    droppedQuadCount: inputQuads.length - orderedQuads.length,
    retainedPredicates: sortedUnion(orderedQuads.map((quad) => quad.predicate.value)),
    indexesBuilt: inputPlan.recommendedMessageIndexes,
    joinOrderHints: inputPlan.recommendedJoinOrderHints,
    compactRecords,
    quads: orderedQuads,
  };
}

export function projectOutputWithShapePlanning(quads: Iterable<Quad>, planning: ShapePlanning | undefined): Quad[] {
  const outputQuads = Array.from(quads);
  if (!planning?.output) {
    return outputQuads;
  }

  const projection = outputProjectionPlan(planning.output);
  if (projection.allowedPredicates.size === 0) {
    return outputQuads;
  }

  return outputQuads.filter((quad) => outputQuadMatchesProjection(quad, projection));
}

export function parseShapePlanningFromRuntime(runtime: string): ShapePlanning | undefined {
  const match = /^# rdfjs-inference-engine shapePlanning=(.+)$/m.exec(runtime);
  if (!match) {
    return undefined;
  }

  try {
    const source = match[1].startsWith('%') ? decodeURIComponent(match[1]) : match[1];
    const parsed = JSON.parse(source) as ShapePlanning | RuntimeShapePlanning;
    if ('v' in parsed) {
      return expandRuntimeShapePlanning(parsed);
    }
    return parsed && parsed.version === SHACL_SHAPE_PLANNING_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function compactRuntimeShapePlanning(planning: ShapePlanning): RuntimeShapePlanning {
  return {
    v: planning.version,
    i: planning.input ? compactRuntimeShapeGraph(planning.input) : undefined,
    o: planning.output ? compactRuntimeShapeGraph(planning.output) : undefined,
  };
}

function compactRuntimeShapeGraph(plan: ShapeGraphPlan): RuntimeShapeGraph {
  return {
    d: plan.direction,
    s: plan.shapes.map((shape) => ({
      s: shape.shape,
      tc: shape.targetClasses,
      tn: shape.targetNodes,
      ts: shape.targetSubjectsOf,
      to: shape.targetObjectsOf,
      p: shape.propertyPlans.map((property) => ({
        s: property.propertyShape,
        p: property.path,
        min: property.minCount,
        max: property.maxCount,
        dt: property.datatype,
        cl: property.class,
        nk: property.nodeKind,
        h: property.hasValues,
        i: property.inValues,
        u: property.units,
      })),
      ip: shape.ignoredPredicates,
      c: shape.closed,
    })),
  };
}

function expandRuntimeShapePlanning(compact: RuntimeShapePlanning): ShapePlanning | undefined {
  if (compact.v !== SHACL_SHAPE_PLANNING_VERSION) {
    return undefined;
  }
  return createShapePlanning(
    compact.i ? expandRuntimeShapeGraph(compact.i) : undefined,
    compact.o ? expandRuntimeShapeGraph(compact.o) : undefined,
  );
}

function expandRuntimeShapeGraph(compact: RuntimeShapeGraph): ShapeGraphPlan {
  const shapes = compact.s.map(expandRuntimeShape);
  return {
    direction: compact.d,
    shapes,
    relevantPredicates: sortedUnion(shapes.flatMap((shape) => shape.relevantPredicates)),
    relevantClasses: sortedUnion(shapes.flatMap((shape) => shape.relevantClasses)),
    pathTexts: sortedUnion(shapes.flatMap((shape) => shape.propertyPlans.map((property) => property.pathText))),
    scalarPaths: sortedUnion(shapes.flatMap((shape) => shape.scalarPaths)),
    repeatedPaths: sortedUnion(shapes.flatMap((shape) => shape.repeatedPaths)),
    recommendedMessageIndexes: dedupeIndexSpecs(shapes.flatMap((shape) => shape.recommendedMessageIndexes)),
    recommendedJoinOrderHints: sortJoinOrderHints(shapes.flatMap((shape) => shape.recommendedJoinOrderHints)),
  };
}

function expandRuntimeShape(compact: RuntimeShape): ShapePlan {
  const propertyPlans = compact.p.map((property): PropertyShapePlan => {
    const metadata = pathMetadata(property.p);
    const pathText = pathToText(property.p);
    return {
      propertyShape: property.s,
      path: property.p,
      pathText,
      metadata,
      minCount: property.min,
      maxCount: property.max,
      datatype: property.dt,
      class: property.cl,
      nodeKind: property.nk,
      hasValues: property.h,
      inValues: property.i,
      units: property.u,
      scalar: property.max === 1,
      required: property.min !== undefined && property.min > 0,
      indexSpecs: indexSpecsForPath(property.p, pathText, metadata),
      joinOrderHints: joinOrderHintsForPath(property.p, pathText, property.max === 1, property.min !== undefined && property.min > 0),
    };
  });
  const relevantPredicates = new Set<string>([...compact.ts, ...compact.to]);
  const relevantClasses = new Set<string>(compact.tc);
  if (compact.tc.length > 0) {
    relevantPredicates.add(RDF_TYPE);
  }
  for (const property of propertyPlans) {
    addValues(relevantPredicates, property.metadata.predicates);
    if (property.class) relevantClasses.add(property.class);
    if (property.datatype) relevantClasses.add(property.datatype);
    if (property.metadata.predicates.includes(RDF_TYPE)) {
      addValues(relevantClasses, [...property.hasValues, ...property.inValues]);
    }
  }
  const allowedPredicates = compact.c
    ? sortedUnion([...relevantPredicates, ...compact.ip])
    : sortedUnion(relevantPredicates);
  return {
    shape: compact.s,
    targetClasses: compact.tc,
    targetNodes: compact.tn,
    targetSubjectsOf: compact.ts,
    targetObjectsOf: compact.to,
    propertyPlans,
    allowedPredicates,
    ignoredPredicates: compact.ip,
    requiredPaths: sortedUnion(propertyPlans.filter((property) => property.required).map((property) => property.pathText)),
    optionalPaths: sortedUnion(propertyPlans.filter((property) => !property.required).map((property) => property.pathText)),
    scalarPaths: sortedUnion(propertyPlans.filter((property) => property.scalar).map((property) => property.pathText)),
    repeatedPaths: sortedUnion(propertyPlans.filter((property) => property.metadata.mayRepeat).map((property) => property.pathText)),
    relevantPredicates: sortedUnion(relevantPredicates),
    relevantClasses: sortedUnion(relevantClasses),
    recommendedMessageIndexes: dedupeIndexSpecs(propertyPlans.flatMap((property) => property.indexSpecs)),
    recommendedJoinOrderHints: sortJoinOrderHints(propertyPlans.flatMap((property) => property.joinOrderHints)),
    closed: compact.c,
  };
}

function addValues<T>(target: Set<T>, values: Iterable<T>): void {
  for (const value of values) {
    target.add(value);
  }
}

function outputProjectionPlan(plan: ShapeGraphPlan): OutputProjectionPlan {
  const allowedPredicates = new Set<string>();
  const unconstrainedPredicates = new Set<string>();
  const allowedObjectsByPredicate = new Map<string, Set<string>>();

  for (const shape of plan.shapes) {
    for (const property of shape.propertyPlans) {
      const objectConstraints = [...property.hasValues, ...property.inValues];
      for (const predicate of property.metadata.predicates) {
        allowedPredicates.add(predicate);
        if (property.path.type === 'predicate' && objectConstraints.length > 0) {
          const values = allowedObjectsByPredicate.get(predicate) ?? new Set<string>();
          for (const value of objectConstraints) {
            values.add(value);
          }
          allowedObjectsByPredicate.set(predicate, values);
        } else {
          unconstrainedPredicates.add(predicate);
        }
      }
    }
  }

  if (allowedPredicates.size === 0) {
    for (const predicate of plan.relevantPredicates) {
      allowedPredicates.add(predicate);
      unconstrainedPredicates.add(predicate);
    }
  }

  return { allowedPredicates, unconstrainedPredicates, allowedObjectsByPredicate };
}

function outputQuadMatchesProjection(quad: Quad, projection: OutputProjectionPlan): boolean {
  const predicate = quad.predicate.value;
  if (!projection.allowedPredicates.has(predicate)) {
    return false;
  }
  if (projection.unconstrainedPredicates.has(predicate)) {
    return true;
  }

  const allowedObjects = projection.allowedObjectsByPredicate.get(predicate);
  return !allowedObjects || allowedObjects.has(termId(quad.object as Term));
}

function appendGraphPlanSummary(lines: string[], label: string, plan: ShapeGraphPlan | undefined): void {
  if (!plan) {
    lines.push(`# ${label}: none`);
    return;
  }

  lines.push(`# ${label}: ${plan.shapes.length} shape(s)`);
  appendList(lines, `${label} paths`, plan.pathTexts);
  appendList(lines, `${label} units`, sortedUnion(plan.shapes.flatMap((shape) => shape.propertyPlans.flatMap((property) => property.units))));
  appendList(lines, `${label} scalar paths`, plan.scalarPaths);
  appendList(lines, `${label} repeated paths`, plan.repeatedPaths);
}

function appendList(lines: string[], label: string, values: string[]): void {
  lines.push(`# ${label}: ${values.length === 0 ? 'none' : values.join(', ')}`);
}

function compileShapePlan(shape: Term, index: ShapeGraphIndex): ShapePlan | undefined {
  const propertyPlans: PropertyShapePlan[] = [];
  const relevantPredicates = new Set<string>();
  const relevantClasses = new Set<string>();

  const targetClasses = namedNodeValues(objects(index, shape, SH + 'targetClass'));
  const targetNodes = termIds(objects(index, shape, SH + 'targetNode'));
  const targetSubjectsOf = namedNodeValues(objects(index, shape, SH + 'targetSubjectsOf'));
  const targetObjectsOf = namedNodeValues(objects(index, shape, SH + 'targetObjectsOf'));
  const ignoredPredicates = namedNodeValues(readListObjects(index, objects(index, shape, SH + 'ignoredProperties')));
  const closed = booleanObject(objects(index, shape, SH + 'closed'));

  for (const targetClass of targetClasses) {
    relevantPredicates.add(RDF_TYPE);
    relevantClasses.add(targetClass);
  }
  for (const predicate of [...targetSubjectsOf, ...targetObjectsOf]) {
    relevantPredicates.add(predicate);
  }

  const propertyShapeTerms = [...objects(index, shape, SH + 'property')];
  if (objects(index, shape, SH + 'path').length > 0) {
    propertyShapeTerms.push(shape);
  }

  for (const propertyShape of propertyShapeTerms) {
    const propertyPlan = compilePropertyShapePlan(propertyShape, index);
    if (!propertyPlan) {
      continue;
    }
    propertyPlans.push(propertyPlan);
    for (const predicate of propertyPlan.metadata.predicates) {
      relevantPredicates.add(predicate);
    }
    if (propertyPlan.class) {
      relevantClasses.add(propertyPlan.class);
    }
    if (propertyPlan.datatype) {
      relevantClasses.add(propertyPlan.datatype);
    }
    for (const value of [...propertyPlan.hasValues, ...propertyPlan.inValues]) {
      if (propertyPlan.metadata.predicates.includes(RDF_TYPE)) {
        relevantClasses.add(value);
      }
    }
  }

  if (propertyPlans.length === 0
    && targetClasses.length === 0
    && targetNodes.length === 0
    && targetSubjectsOf.length === 0
    && targetObjectsOf.length === 0) {
    return undefined;
  }

  const allowedPredicates = closed
    ? sortedUnion([...relevantPredicates, ...ignoredPredicates])
    : sortedUnion(relevantPredicates);

  return {
    shape: termId(shape),
    targetClasses,
    targetNodes,
    targetSubjectsOf,
    targetObjectsOf,
    propertyPlans,
    allowedPredicates,
    ignoredPredicates,
    requiredPaths: sortedUnion(propertyPlans.filter((property) => property.required).map((property) => property.pathText)),
    optionalPaths: sortedUnion(propertyPlans.filter((property) => !property.required).map((property) => property.pathText)),
    scalarPaths: sortedUnion(propertyPlans.filter((property) => property.scalar).map((property) => property.pathText)),
    repeatedPaths: sortedUnion(propertyPlans.filter((property) => property.metadata.mayRepeat).map((property) => property.pathText)),
    relevantPredicates: sortedUnion(relevantPredicates),
    relevantClasses: sortedUnion(relevantClasses),
    recommendedMessageIndexes: dedupeIndexSpecs(propertyPlans.flatMap((property) => property.indexSpecs)),
    recommendedJoinOrderHints: sortJoinOrderHints(propertyPlans.flatMap((property) => property.joinOrderHints)),
    closed,
  };
}

function compilePropertyShapePlan(propertyShape: Term, index: ShapeGraphIndex): PropertyShapePlan | undefined {
  const [pathTerm] = objects(index, propertyShape, SH + 'path');
  if (!pathTerm) {
    return undefined;
  }

  const path = compilePath(pathTerm, index);
  if (!path) {
    return undefined;
  }

  const metadata = pathMetadata(path);
  const minCount = integerObject(objects(index, propertyShape, SH + 'minCount'));
  const maxCount = integerObject(objects(index, propertyShape, SH + 'maxCount'));
  const datatype = namedNodeValue(objects(index, propertyShape, SH + 'datatype')[0]);
  const classValue = namedNodeValue(objects(index, propertyShape, SH + 'class')[0]);
  const nodeKind = namedNodeValue(objects(index, propertyShape, SH + 'nodeKind')[0]);
  const hasValues = termIds(objects(index, propertyShape, SH + 'hasValue'));
  const inValues = termIds(readListObjects(index, objects(index, propertyShape, SH + 'in')));
  const units = namedNodeValues(readValueOrListObjects(index, objects(index, propertyShape, SH + 'unit')));

  return {
    propertyShape: termId(propertyShape),
    path,
    pathText: pathToText(path),
    metadata,
    minCount,
    maxCount,
    datatype,
    class: classValue,
    nodeKind,
    hasValues,
    inValues,
    units,
    scalar: maxCount === 1,
    required: minCount !== undefined && minCount > 0,
    indexSpecs: indexSpecsForPath(path, pathToText(path), metadata),
    joinOrderHints: joinOrderHintsForPath(path, pathToText(path), maxCount === 1, minCount !== undefined && minCount > 0),
  };
}

function compilePath(term: Term, index: ShapeGraphIndex): CompiledShaclPath | undefined {
  if (term.termType === 'NamedNode') {
    if (term.value === RDF_NIL) {
      return undefined;
    }
    return { type: 'predicate', predicate: term.value };
  }

  const listItems = readList(index, term);
  if (listItems.length > 0) {
    const items = listItems
      .map((item) => compilePath(item, index))
      .filter((item): item is CompiledShaclPath => item !== undefined);
    return items.length > 0 ? { type: 'sequence', items } : undefined;
  }

  const inversePath = objects(index, term, SH + 'inversePath')[0];
  if (inversePath) {
    const path = compilePath(inversePath, index);
    return path ? { type: 'inverse', path } : undefined;
  }

  const alternativePath = objects(index, term, SH + 'alternativePath')[0];
  if (alternativePath) {
    const alternatives = readList(index, alternativePath)
      .map((item) => compilePath(item, index))
      .filter((item): item is CompiledShaclPath => item !== undefined);
    return alternatives.length > 0 ? { type: 'alternative', alternatives } : undefined;
  }

  const zeroOrMorePath = objects(index, term, SH + 'zeroOrMorePath')[0];
  if (zeroOrMorePath) {
    const path = compilePath(zeroOrMorePath, index);
    return path ? { type: 'zeroOrMore', path } : undefined;
  }

  const oneOrMorePath = objects(index, term, SH + 'oneOrMorePath')[0];
  if (oneOrMorePath) {
    const path = compilePath(oneOrMorePath, index);
    return path ? { type: 'oneOrMore', path } : undefined;
  }

  const zeroOrOnePath = objects(index, term, SH + 'zeroOrOnePath')[0];
  if (zeroOrOnePath) {
    const path = compilePath(zeroOrOnePath, index);
    return path ? { type: 'zeroOrOne', path } : undefined;
  }

  return undefined;
}

function pathMetadata(path: CompiledShaclPath): PathMetadata {
  switch (path.type) {
    case 'predicate':
      return {
        predicates: [path.predicate],
        mayBeEmpty: false,
        mayRepeat: false,
        hasInverse: false,
        hasAlternative: false,
      };
    case 'inverse': {
      const metadata = pathMetadata(path.path);
      return { ...metadata, hasInverse: true };
    }
    case 'sequence': {
      const childMetadata = path.items.map(pathMetadata);
      return combinePathMetadata(childMetadata, {
        mayBeEmpty: path.items.every((_item, index) => childMetadata[index].mayBeEmpty),
        mayRepeat: childMetadata.some((metadata) => metadata.mayRepeat),
        hasInverse: childMetadata.some((metadata) => metadata.hasInverse),
        hasAlternative: childMetadata.some((metadata) => metadata.hasAlternative),
      });
    }
    case 'alternative': {
      const childMetadata = path.alternatives.map(pathMetadata);
      return combinePathMetadata(childMetadata, {
        mayBeEmpty: childMetadata.some((metadata) => metadata.mayBeEmpty),
        mayRepeat: childMetadata.some((metadata) => metadata.mayRepeat),
        hasInverse: childMetadata.some((metadata) => metadata.hasInverse),
        hasAlternative: true,
      });
    }
    case 'zeroOrMore': {
      const metadata = pathMetadata(path.path);
      return { ...metadata, mayBeEmpty: true, mayRepeat: true };
    }
    case 'oneOrMore': {
      const metadata = pathMetadata(path.path);
      return { ...metadata, mayRepeat: true };
    }
    case 'zeroOrOne': {
      const metadata = pathMetadata(path.path);
      return { ...metadata, mayBeEmpty: true };
    }
  }
}

function combinePathMetadata(children: PathMetadata[], flags: Omit<PathMetadata, 'predicates'>): PathMetadata {
  return {
    predicates: sortedUnion(children.flatMap((metadata) => metadata.predicates)),
    ...flags,
  };
}

function pathToText(path: CompiledShaclPath): string {
  switch (path.type) {
    case 'predicate':
      return path.predicate;
    case 'inverse':
      return `^${wrapPathText(path.path)}`;
    case 'sequence':
      return path.items.map(wrapPathText).join(' / ');
    case 'alternative':
      return path.alternatives.map(wrapPathText).join(' | ');
    case 'zeroOrMore':
      return `${wrapPathText(path.path)}*`;
    case 'oneOrMore':
      return `${wrapPathText(path.path)}+`;
    case 'zeroOrOne':
      return `${wrapPathText(path.path)}?`;
  }
}

function wrapPathText(path: CompiledShaclPath): string {
  if (path.type === 'predicate') {
    return pathToText(path);
  }
  return `(${pathToText(path)})`;
}

interface TemporaryIndexes {
  allQuads: Quad[];
  byPredicate?: Map<string, Quad[]>;
  bySubjectPredicate?: Map<string, Quad[]>;
  byObjectPredicate?: Map<string, Quad[]>;
  focusNodes: Set<string>;
}

function indexSpecsForPath(path: CompiledShaclPath, pathText: string, metadata: PathMetadata): IndexSpec[] {
  const specs: IndexSpec[] = [];
  for (const predicate of metadata.predicates) {
    specs.push({ kind: 'predicate', predicate, path: pathText, reason: metadata.mayRepeat ? 'repeated path traversal' : 'path predicate filtering' });
    specs.push({ kind: 'subject-predicate', predicate, path: pathText, reason: 'forward path lookup' });
  }
  if (metadata.hasInverse || pathUsesInverse(path)) {
    for (const predicate of metadata.predicates) {
      specs.push({ kind: 'object-predicate', predicate, path: pathText, reason: 'inverse path lookup' });
    }
  }
  return dedupeIndexSpecs(specs);
}

function joinOrderHintsForPath(path: CompiledShaclPath, pathText: string, scalar: boolean, required: boolean): JoinOrderHint[] {
  const hints: JoinOrderHint[] = [];
  collectJoinOrderHints(path, pathText, scalar, required, 0, hints);
  return sortJoinOrderHints(hints);
}

function collectJoinOrderHints(path: CompiledShaclPath, pathText: string, scalar: boolean, required: boolean, depth: number, hints: JoinOrderHint[]): void {
  switch (path.type) {
    case 'predicate':
      hints.push({
        path: pathText,
        predicate: path.predicate,
        direction: 'forward',
        scalar,
        required,
        rank: joinRank({ scalar, required, depth, repeated: false, alternative: false, inverse: false }),
      });
      break;
    case 'inverse':
      for (const predicate of pathMetadata(path.path).predicates) {
        hints.push({
          path: pathText,
          predicate,
          direction: 'inverse',
          scalar,
          required,
          rank: joinRank({ scalar, required, depth, repeated: false, alternative: false, inverse: true }),
        });
      }
      collectJoinOrderHints(path.path, pathText, scalar, required, depth + 1, hints);
      break;
    case 'sequence':
      path.items.forEach((item, index) => collectJoinOrderHints(item, pathText, scalar && index === 0, required && index === 0, depth + index, hints));
      break;
    case 'alternative':
      path.alternatives.forEach((item) => {
        for (const predicate of pathMetadata(item).predicates) {
          hints.push({
            path: pathText,
            predicate,
            direction: pathUsesInverse(item) ? 'mixed' : 'forward',
            scalar,
            required,
            rank: joinRank({ scalar, required, depth, repeated: false, alternative: true, inverse: pathUsesInverse(item) }),
          });
        }
        collectJoinOrderHints(item, pathText, scalar, required, depth + 1, hints);
      });
      break;
    case 'zeroOrMore':
    case 'oneOrMore':
    case 'zeroOrOne': {
      const repeated = path.type !== 'zeroOrOne';
      for (const predicate of pathMetadata(path.path).predicates) {
        hints.push({
          path: pathText,
          predicate,
          direction: pathUsesInverse(path.path) ? 'mixed' : 'forward',
          scalar,
          required,
          rank: joinRank({ scalar, required, depth, repeated, alternative: false, inverse: pathUsesInverse(path.path) }),
        });
      }
      collectJoinOrderHints(path.path, pathText, scalar, required, depth + 1, hints);
      break;
    }
  }
}

function pathUsesInverse(path: CompiledShaclPath): boolean {
  switch (path.type) {
    case 'predicate':
      return false;
    case 'inverse':
      return true;
    case 'sequence':
      return path.items.some(pathUsesInverse);
    case 'alternative':
      return path.alternatives.some(pathUsesInverse);
    case 'zeroOrMore':
    case 'oneOrMore':
    case 'zeroOrOne':
      return pathUsesInverse(path.path);
  }
}

function joinRank(options: { scalar: boolean; required: boolean; depth: number; repeated: boolean; alternative: boolean; inverse: boolean }): number {
  let rank = options.depth * 10;
  if (!options.required) {
    rank += 50;
  }
  if (!options.scalar) {
    rank += 20;
  }
  if (options.alternative) {
    rank += 20;
  }
  if (options.inverse) {
    rank += 30;
  }
  if (options.repeated) {
    rank += 100;
  }
  return rank;
}

function buildTemporaryIndexes(quads: Quad[], specs: IndexSpec[]): TemporaryIndexes {
  const needsPredicate = specs.some((spec) => spec.kind === 'predicate' || spec.kind === 'type');
  const needsSubjectPredicate = specs.some((spec) => spec.kind === 'subject-predicate');
  const needsObjectPredicate = specs.some((spec) => spec.kind === 'object-predicate');
  const indexes: TemporaryIndexes = {
    allQuads: quads,
    byPredicate: needsPredicate ? new Map() : undefined,
    bySubjectPredicate: needsSubjectPredicate ? new Map() : undefined,
    byObjectPredicate: needsObjectPredicate ? new Map() : undefined,
    focusNodes: new Set(),
  };

  for (const quad of quads) {
    indexes.focusNodes.add(termId(quad.subject));
    indexes.focusNodes.add(termId(quad.object as Term));
    if (indexes.byPredicate) {
      pushMap(indexes.byPredicate, quad.predicate.value, quad);
    }
    if (indexes.bySubjectPredicate) {
      pushMap(indexes.bySubjectPredicate, subjectPredicateKey(quad.subject, quad.predicate.value), quad);
    }
    if (indexes.byObjectPredicate) {
      pushMap(indexes.byObjectPredicate, subjectPredicateKey(quad.object as Term, quad.predicate.value), quad);
    }
  }

  return indexes;
}

function selectInputShapes(plan: ShapeGraphPlan, indexes: TemporaryIndexes): ShapePlan[] {
  const selected: ShapePlan[] = [];
  for (const shape of plan.shapes) {
    if (shapeMatchesInput(shape, indexes)) {
      selected.push(shape);
    }
  }
  return selected;
}

function shapeMatchesInput(shape: ShapePlan, indexes: TemporaryIndexes): boolean {
  for (const targetNode of shape.targetNodes) {
    if (indexes.focusNodes.has(targetNode)) {
      return true;
    }
  }
  for (const targetClass of shape.targetClasses) {
    if (hasQuadWithPredicateObject(indexes, RDF_TYPE, targetClass)) {
      return true;
    }
  }
  for (const predicate of shape.targetSubjectsOf) {
    if (hasPredicate(indexes, predicate)) {
      return true;
    }
  }
  for (const predicate of shape.targetObjectsOf) {
    if (hasPredicate(indexes, predicate)) {
      return true;
    }
  }
  for (const predicate of shape.relevantPredicates) {
    if (predicate !== RDF_TYPE && hasPredicate(indexes, predicate)) {
      return true;
    }
  }
  return false;
}

function compactRecordsForShapes(shapes: ShapePlan[], indexes: TemporaryIndexes): CompactShapeRecord[] {
  const focusNodes = new Map<string, { term: Term; shapes: Set<string> }>();

  for (const shape of shapes) {
    for (const focus of focusTermsForShape(shape, indexes)) {
      const key = termId(focus);
      const entry = focusNodes.get(key) ?? { term: focus, shapes: new Set<string>() };
      entry.shapes.add(shape.shape);
      focusNodes.set(key, entry);
    }
  }

  return Array.from(focusNodes.values()).map(({ term, shapes: shapeIds }) => {
    const scalarValues: Record<string, string | undefined> = {};
    const repeatedValues: Record<string, string[]> = {};
    const relevantShapes = shapes.filter((shape) => shapeIds.has(shape.shape));
    for (const shape of relevantShapes) {
      for (const property of shape.propertyPlans) {
        const values = evaluatePath(property.path, term, indexes).map(termId);
        if (property.scalar) {
          scalarValues[property.pathText] = values[0];
        } else {
          repeatedValues[property.pathText] = values;
        }
      }
    }
    return {
      focusNode: termId(term),
      shapes: Array.from(shapeIds).sort(),
      scalarValues,
      repeatedValues,
    };
  });
}

function focusTermsForShape(shape: ShapePlan, indexes: TemporaryIndexes): Term[] {
  const terms: Term[] = [];
  const seen = new Set<string>();
  const add = (term: Term) => {
    const key = termId(term);
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  };

  for (const targetNode of shape.targetNodes) {
    const term = findTermById(indexes.allQuads, targetNode);
    if (term) {
      add(term);
    }
  }
  for (const targetClass of shape.targetClasses) {
    for (const quad of indexes.allQuads) {
      if (quad.predicate.value === RDF_TYPE && termId(quad.object as Term) === targetClass) {
        add(quad.subject);
      }
    }
  }
  for (const predicate of shape.targetSubjectsOf) {
    for (const quad of quadsByPredicate(indexes, predicate)) {
      add(quad.subject);
    }
  }
  for (const predicate of shape.targetObjectsOf) {
    for (const quad of quadsByPredicate(indexes, predicate)) {
      add(quad.object as Term);
    }
  }
  for (const property of shape.propertyPlans) {
    for (const predicate of property.metadata.predicates) {
      for (const quad of quadsByPredicate(indexes, predicate)) {
        add(quad.subject);
      }
    }
  }
  return terms;
}

function evaluatePath(path: CompiledShaclPath, focus: Term, indexes: TemporaryIndexes, seen = new Set<string>()): Term[] {
  switch (path.type) {
    case 'predicate':
      return quadsBySubjectPredicate(indexes, focus, path.predicate).map((quad) => quad.object as Term);
    case 'inverse':
      return evaluateInversePath(path.path, focus, indexes, seen);
    case 'sequence':
      return path.items.reduce((focuses, item) => focuses.flatMap((current) => evaluatePath(item, current, indexes, seen)), [focus]);
    case 'alternative':
      return uniqueTerms(path.alternatives.flatMap((item) => evaluatePath(item, focus, indexes, seen)));
    case 'zeroOrMore':
      return uniqueTerms([focus, ...evaluateRepeatedPath(path.path, focus, indexes, seen)]);
    case 'oneOrMore':
      return evaluateRepeatedPath(path.path, focus, indexes, seen);
    case 'zeroOrOne':
      return uniqueTerms([focus, ...evaluatePath(path.path, focus, indexes, seen)]);
  }
}

function evaluateInversePath(path: CompiledShaclPath, focus: Term, indexes: TemporaryIndexes, seen: Set<string>): Term[] {
  if (path.type === 'predicate') {
    return quadsByObjectPredicate(indexes, focus, path.predicate).map((quad) => quad.subject);
  }
  return indexes.allQuads
    .filter((quad) => evaluatePath(path, quad.subject, indexes, seen).some((term) => termsEqual(term, focus)))
    .map((quad) => quad.subject);
}

function evaluateRepeatedPath(path: CompiledShaclPath, focus: Term, indexes: TemporaryIndexes, seen: Set<string>): Term[] {
  const results: Term[] = [];
  const stack = evaluatePath(path, focus, indexes, seen);
  while (stack.length > 0) {
    const term = stack.pop() as Term;
    const key = termId(term);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(term);
    stack.push(...evaluatePath(path, term, indexes, seen));
  }
  return uniqueTerms(results);
}

function orderQuadsForJoinHints(quads: Quad[], hints: JoinOrderHint[]): Quad[] {
  if (hints.length === 0) {
    return quads;
  }
  const rankByPredicate = new Map<string, number>();
  for (const hint of hints) {
    const rank = rankByPredicate.get(hint.predicate);
    if (rank === undefined || hint.rank < rank) {
      rankByPredicate.set(hint.predicate, hint.rank);
    }
  }
  return quads.map((quad, index) => ({ quad, index }))
    .sort((left, right) => (rankByPredicate.get(left.quad.predicate.value) ?? 10_000) - (rankByPredicate.get(right.quad.predicate.value) ?? 10_000)
      || left.index - right.index)
    .map((entry) => entry.quad);
}

function hasPredicate(indexes: TemporaryIndexes, predicate: string): boolean {
  return quadsByPredicate(indexes, predicate).length > 0;
}

function hasQuadWithPredicateObject(indexes: TemporaryIndexes, predicate: string, objectId: string): boolean {
  return quadsByPredicate(indexes, predicate).some((quad) => termId(quad.object as Term) === objectId);
}

function quadsByPredicate(indexes: TemporaryIndexes, predicate: string): Quad[] {
  return indexes.byPredicate?.get(predicate) ?? indexes.allQuads.filter((quad) => quad.predicate.value === predicate);
}

function quadsBySubjectPredicate(indexes: TemporaryIndexes, subject: Term, predicate: string): Quad[] {
  return indexes.bySubjectPredicate?.get(subjectPredicateKey(subject, predicate))
    ?? indexes.allQuads.filter((quad) => termsEqual(quad.subject, subject) && quad.predicate.value === predicate);
}

function quadsByObjectPredicate(indexes: TemporaryIndexes, object: Term, predicate: string): Quad[] {
  return indexes.byObjectPredicate?.get(subjectPredicateKey(object, predicate))
    ?? indexes.allQuads.filter((quad) => termsEqual(quad.object as Term, object) && quad.predicate.value === predicate);
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function findTermById(quads: Quad[], id: string): Term | undefined {
  for (const quad of quads) {
    for (const term of [quad.subject, quad.predicate, quad.object as Term, quad.graph]) {
      if (termId(term as Term) === id) {
        return term as Term;
      }
    }
  }
  return undefined;
}

function uniqueTerms(terms: Term[]): Term[] {
  const seen = new Set<string>();
  const unique: Term[] = [];
  for (const term of terms) {
    const key = termId(term);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(term);
    }
  }
  return unique;
}

function termsEqual(left: Term, right: Term): boolean {
  if (left.termType !== right.termType || left.value !== right.value) {
    return false;
  }
  if (left.termType === 'Literal' && right.termType === 'Literal') {
    return left.language === right.language && left.datatype.value === right.datatype.value;
  }
  return true;
}

function dedupeIndexSpecs(specs: IndexSpec[]): IndexSpec[] {
  const byKey = new Map<string, IndexSpec>();
  for (const spec of specs) {
    const key = `${spec.kind}\t${spec.predicate ?? ''}\t${spec.path ?? ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, spec);
    }
  }
  return Array.from(byKey.values()).sort((left, right) => indexSpecToText(left).localeCompare(indexSpecToText(right)));
}

function sortJoinOrderHints(hints: JoinOrderHint[]): JoinOrderHint[] {
  const byKey = new Map<string, JoinOrderHint>();
  for (const hint of hints) {
    const key = `${hint.path}\t${hint.predicate}\t${hint.direction}`;
    const previous = byKey.get(key);
    if (!previous || hint.rank < previous.rank) {
      byKey.set(key, hint);
    }
  }
  return Array.from(byKey.values()).sort((left, right) => left.rank - right.rank || joinOrderHintToText(left).localeCompare(joinOrderHintToText(right)));
}

function indexSpecToText(spec: IndexSpec): string {
  return `${spec.kind}${spec.predicate ? `(${spec.predicate})` : ''}${spec.path ? ` for ${spec.path}` : ''}`;
}

function joinOrderHintToText(hint: JoinOrderHint): string {
  return `${hint.rank}:${hint.direction}:${hint.predicate} for ${hint.path}`;
}

function discoverNodeShapeTerms(quads: Quad[], index: ShapeGraphIndex): Term[] {
  const shapeKeys = new Set<string>();
  const shapes: Term[] = [];

  function addShape(term: Term): void {
    const key = termKey(term);
    if (!shapeKeys.has(key)) {
      shapeKeys.add(key);
      shapes.push(term);
    }
  }

  for (const quad of quads) {
    if (quad.predicate.value === RDF_TYPE
      && quad.object.termType === 'NamedNode'
      && quad.object.value === SH_NODE_SHAPE) {
      addShape(quad.subject);
    }
    if ([SH + 'targetClass', SH + 'targetNode', SH + 'targetSubjectsOf', SH + 'targetObjectsOf', SH + 'property'].includes(quad.predicate.value)) {
      addShape(quad.subject);
    }
  }

  for (const quad of quads) {
    if (quad.predicate.value === RDF_TYPE
      && quad.object.termType === 'NamedNode'
      && quad.object.value === SH_PROPERTY_SHAPE
      && objects(index, quad.subject, SH + 'path').length > 0) {
      addShape(quad.subject);
    }
  }

  return shapes;
}

function buildShapeGraphIndex(quads: Quad[]): ShapeGraphIndex {
  const bySubjectPredicate = new Map<string, Term[]>();
  for (const quad of quads) {
    if (quad.predicate.termType !== 'NamedNode') {
      continue;
    }
    const key = subjectPredicateKey(quad.subject, quad.predicate.value);
    const values = bySubjectPredicate.get(key) ?? [];
    values.push(quad.object);
    bySubjectPredicate.set(key, values);
  }
  return { bySubjectPredicate };
}

function objects(index: ShapeGraphIndex, subject: Term, predicate: string): Term[] {
  return index.bySubjectPredicate.get(subjectPredicateKey(subject, predicate)) ?? [];
}

function readListObjects(index: ShapeGraphIndex, heads: Term[]): Term[] {
  return heads.flatMap((head) => readList(index, head));
}

function readValueOrListObjects(index: ShapeGraphIndex, values: Term[]): Term[] {
  return values.flatMap((value) => {
    const items = readList(index, value);
    return items.length > 0 ? items : [value];
  });
}

function readList(index: ShapeGraphIndex, head: Term): Term[] {
  const items: Term[] = [];
  let current: Term | undefined = head;
  const seen = new Set<string>();

  while (current && !(current.termType === 'NamedNode' && current.value === RDF_NIL)) {
    const key = termKey(current);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);

    const first: Term | undefined = objects(index, current, RDF_FIRST)[0];
    const rest: Term | undefined = objects(index, current, RDF_REST)[0];
    if (!first || !rest) {
      return [];
    }

    items.push(first);
    current = rest;
  }

  return items;
}

function booleanObject(values: Term[]): boolean {
  return values.some((value) => value.termType === 'Literal' && value.value === 'true');
}

function integerObject(values: Term[]): number | undefined {
  for (const value of values) {
    if (value.termType !== 'Literal') {
      continue;
    }
    const parsed = Number.parseInt(value.value, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function namedNodeValues(values: Term[]): string[] {
  return sortedUnion(values.map(namedNodeValue).filter((value): value is string => value !== undefined));
}

function namedNodeValue(value: Term | undefined): string | undefined {
  return value?.termType === 'NamedNode' ? value.value : undefined;
}

function termIds(values: Term[]): string[] {
  return sortedUnion(values.map(termId));
}

function termId(term: Term): string {
  switch (term.termType) {
    case 'NamedNode':
      return term.value;
    case 'BlankNode':
      return `_:${term.value}`;
    case 'Literal':
      return term.language
        ? `"${term.value}"@${term.language}`
        : `"${term.value}"^^${term.datatype.value}`;
    case 'DefaultGraph':
      return 'default';
    default:
      return `${term.termType}:${term.value}`;
  }
}

function subjectPredicateKey(subject: Term, predicate: string): string {
  return `${termKey(subject)}\t${predicate}`;
}

function termKey(term: Term): string {
  return `${term.termType}\t${term.value}`;
}

function sortedUnion(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}
