# SHACL in/out shape optimization

`rdfjs-inference-engine` can use optional SHACL input and output shapes as trusted optimization hints:

```ts
reasoner.load(background, {
  shaclIn: inputShapeQuads,
  shaclOut: outputShapeQuads,
});
```

The shapes are **not** validation inputs. They are contracts: if future `infer()` data conforms to the input shape and the application only needs the output described by the output shape, the engine can compile and run a smaller, more specialized runtime.

## What the two shapes mean

- `shaclIn` describes RDF that will be passed to `infer()` later. It tells the planner which data-side predicates, classes, paths, cardinalities, and closed-shape constraints are expected.
- `shaclOut` describes the inferred RDF that the application cares about retaining. It tells the runtime compiler which rule heads and intermediate derivations can contribute to desired output predicates/classes.

Both options are independent:

- only `shaclIn`: specialize input handling and keep rules reachable from that input shape;
- only `shaclOut`: keep rules that can produce the desired output shape;
- both together: use input reachability and output relevance.

## Supported shape features

The planner currently compiles SHACL node/property shape metadata relevant for optimization:

- `sh:NodeShape` and standalone `sh:PropertyShape` terms;
- `sh:targetClass`, `sh:targetNode`, `sh:targetSubjectsOf`, `sh:targetObjectsOf`;
- `sh:path`;
- `sh:minCount` and `sh:maxCount`;
- `sh:datatype`, `sh:class`, `sh:nodeKind`, `sh:hasValue`, `sh:in`;
- `sh:closed true` and `sh:ignoredProperties`.

The property path compiler supports:

- direct predicate paths;
- `sh:inversePath`;
- RDF-list sequence paths;
- `sh:alternativePath`;
- `sh:zeroOrMorePath`;
- `sh:oneOrMorePath`;
- `sh:zeroOrOnePath`;
- nested combinations of the above.

## Load-time optimization

At `load()` time, shape optimization happens in these steps.

### 1. Parse or collect the shape graphs

`shaclIn` and `shaclOut` may be passed as RDF-JS quads, an iterable dataset, a string containing RDF, or in Node.js as `{ path }`.

The Node entry point accepts:

```ts
reasoner.load(backgroundQuads, {
  shaclIn: { path: 'examples/shacl-shape-planning/shapes-in.n3' },
  shaclOut: { path: 'examples/shacl-shape-planning/shapes-out.n3' },
});
```

The browser entry point accepts strings or quads. The playground therefore passes the two text editors directly to `load()`.

### 2. Compile each SHACL graph into a shape plan

Each compiled shape plan contains:

- relevant predicates and classes;
- readable path text, for diagnostics and runtime comments;
- scalar paths, currently paths with `sh:maxCount 1`;
- repeated paths, currently paths with `*` or `+` path operators;
- required paths, currently paths with `sh:minCount > 0`;
- closed-shape allowed predicates;
- recommended temporary message indexes;
- recommended join-order hints.

For example, the input shape in [examples/shacl-shape-planning/shapes-in.n3](examples/shacl-shape-planning/shapes-in.n3) contains:

```n3
ex:ObservationInputShape
  a sh:NodeShape ;
  sh:closed true ;
  sh:targetClass sosa:ObservationMessage ;
  sh:property [
    sh:path ex:observedBy ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:nodeKind sh:IRI
  ] .
```

This tells the planner that `ex:observedBy` is a required scalar path and that unrelated message-local predicates may be dropped when the closed shape is trusted.

### 3. Build a combined `ShapePlanning` object

The input and output plans are merged into a single `ShapePlanning` object with:

- `relevantInputPredicates`;
- `relevantOutputPredicates`;
- combined relevant predicates/classes;
- combined recommended indexes;
- combined join-order hints.

This object is available after load:

```ts
const planning = reasoner.getShapePlanning();
```

### 4. Select and order runtime rules

The default runtime compiler first applies the normal load-time static selection based on the background ontology closure. Then, if shape planning exists, it applies shape-guided selection:

1. **Input reachability.** Starting from static ontology predicates/classes plus `shaclIn` predicates/classes, keep rules whose bodies can match known available data. When a kept rule produces a new head predicate/class, that term becomes available for later rules.
2. **Output relevance.** Starting from `shaclOut` predicates/classes, walk backwards through rule metadata and keep rules that can produce desired output or necessary intermediate predicates/classes.
3. **Join-order scheduling.** Rules with body predicates that match high-priority SHACL join hints are emitted earlier in the generated runtime.

The generated runtime includes human-readable comments plus serialized shape-planning metadata. Saved runtimes restore the shape plan automatically:

```ts
const runtime = reasoner.load(backgroundQuads, { shaclIn, shaclOut });
const restored = new InferenceEngine({ runtime });
restored.getShapePlanning(); // restored from runtime comments
```

## Inference-time optimization

At `infer()` time, the engine uses the input shape plan unless disabled:

```ts
const inferred = Array.from(reasoner.infer(inputQuads));

const unoptimized = Array.from(reasoner.infer(inputQuads, {
  optimizeShapeInput: false,
}));
```

The inference-time optimizer:

1. builds only the temporary indexes requested by compiled paths;
2. selects matching input shapes from the message/batch;
3. for trusted closed shapes, drops unrelated message-local facts;
4. orders retained quads by SHACL-derived join hints;
5. stores compact diagnostic records, using scalar slots for `sh:maxCount 1` paths and arrays for repeated paths;
6. passes the optimized quad list to Eyeling.

The latest optimization summary is visible through:

```ts
const optimization = reasoner.getLastInputOptimization();
```

This is intentionally outside Eyeling's internal join engine. The current implementation specializes the generated runtime and the quads given to Eyeling; it does not replace Eyeling's internal indexes.

## Example setup

The repository contains a small command-line and browser-playground example in [examples/shacl-shape-planning](examples/shacl-shape-planning).

The background ontology in [examples/shacl-shape-planning/ontology.n3](examples/shacl-shape-planning/ontology.n3) says:

```n3
sosa:madeBySensor
  rdfs:domain sosa:Observation ;
  rdfs:range sosa:Sensor .

ex:observedBy
  rdfs:subPropertyOf sosa:madeBySensor .
```

The playground input data in [examples/shacl-shape-planning/input.messages.trig](examples/shacl-shape-planning/input.messages.trig) is a ten-message RDF Messages stream. Each message contains one useful observation triple plus one unrelated debug triple:

```n3
VERSION "1.2-messages"
PREFIX ex:   <https://example.org/shape-planning#>
PREFIX sosa: <http://www.w3.org/ns/sosa/>

ex:obs1 ex:observedBy ex:sensor1 .
ex:obs1 ex:debugOnly "drop me 1" .

MESSAGE
ex:obs2 ex:observedBy ex:sensor2 .
ex:obs2 ex:debugOnly "drop me 2" .

# ... eight more messages ...
```

The output shapes in [examples/shacl-shape-planning/shapes-out.n3](examples/shacl-shape-planning/shapes-out.n3) ask for the same inferred output with two validation-realistic node shapes:

- `ex:ObservationOutputShape` targets subjects of `sosa:madeBySensor` and asks for the sensor link plus inferred `rdf:type sosa:Observation`;
- `ex:SensorOutputShape` targets objects of `sosa:madeBySensor` and asks for inferred `rdf:type sosa:Sensor`.

That split is more realistic than one output shape that requires the same focus node to be both an observation and a sensor. The engine still uses the shapes as optimization contracts rather than validation inputs, but keeping them validation-plausible makes the example easier to reason about.

So the specialized runtime must retain enough OWL/RDFS rules to infer:

```n3
ex:obs1 ex:observedBy ex:sensor1 .
ex:observedBy rdfs:subPropertyOf sosa:madeBySensor .
# entails
ex:obs1 sosa:madeBySensor ex:sensor1 .
ex:obs1 rdf:type sosa:Observation .
ex:sensor1 rdf:type sosa:Sensor .
```

Run the example:

```bash
npm run example:shacl-shape-planning
```

Compare with shape planning disabled:

```bash
npm run build:node --silent
node dist/examples/shacl-shape-planning/run.js --no-shapes
```

## Benchmark setup

The benchmark below was run in this workspace on June 16, 2026 with Node.js `v25.9.0` after `npm run build:node --silent`.

It compared three generated runtime modes for the same background ontology:

1. **Full generic runtime:** `load(background, { selectRuntimeRules: false })`.
2. **Static selected runtime:** `load(background)`.
3. **SHACL in/out selected runtime:** `load(background, { shaclIn, shaclOut })`.

For reasoning time, the benchmark compared mode 2 and mode 3 on a synthetic input batch:

- 1,000 observations;
- 1 useful triple per observation: `ex:obsN ex:observedBy ex:sensorM`;
- 5 unrelated debug triples per observation;
- 6,000 total input quads;
- 7 measured `infer()` iterations after one warm-up iteration;
- reported time is median wall-clock time for `Array.from(reasoner.infer(inputQuads))`.

The SHACL input shape is closed and only allows `ex:observedBy`, so the shape-aware inference run may drop the 5,000 unrelated debug quads before Eyeling receives the input.

## Benchmark results

### Generated rule profile size

| Mode | Compiler-selected top-level rules | Rule-section bytes | Full runtime bytes | Notes |
| --- | ---: | ---: | ---: | --- |
| Full generic runtime | all bundled rules | 139,241 | 139,295 | `selectRuntimeRules: false` |
| Static selected runtime | 72 / 133 | 78,054 | 78,108 | Default load-time vocabulary selection |
| SHACL in/out selected runtime | 62 / 133 | 76,192 | 95,546 | Shape-guided selection plus embedded shape metadata |

Compared with the static selected runtime, the SHACL in/out hints removed 10 of 72 selected top-level rules, a **13.9% rule-count reduction**. The N3 rule-section text became **2.4% smaller**.

Compared with the full generic runtime, the SHACL-guided rule section was **45.3% smaller by bytes**.

The full runtime file for the SHACL-guided case is larger than the static selected runtime because it embeds URL-encoded shape-planning JSON metadata so saved runtimes can restore `getShapePlanning()` without reparsing the original shapes. If comparing executable rules only, use the rule-section bytes rather than full runtime bytes.

### Reasoning throughput

| Mode | Input quads passed by caller | Quads passed to Eyeling | Dropped quads | Median infer time | Output quads | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Static selected runtime | 6,000 | 6,000 | 0 | 9,615.1 ms | 2,050 | 1.0× |
| SHACL in/out selected runtime | 6,000 | 1,000 | 5,000 | 494.1 ms | 2,050 | 19.5× |

The shape-aware run produced the same number of inferred quads for the desired output, while reducing median inference time by **94.9%** in this test.

The last shape-aware run reported:

- `originalQuadCount`: 6,000;
- `optimizedQuadCount`: 1,000;
- `droppedQuadCount`: 5,000;
- compact records: 1,000;
- temporary indexes:
  - `predicate(https://example.org/shape-planning#observedBy)`;
  - `subject-predicate(https://example.org/shape-planning#observedBy)`.

### Load-time measurements

The same benchmark measured load/compile time as:

| Mode | Load time |
| --- | ---: |
| Static selected runtime | 487.2 ms |
| SHACL in/out selected runtime | 299.4 ms |

These load-time numbers are more sensitive to noise than the rule-size metrics. Treat them as a local observation, not a guarantee.

## Interpreting the results

The biggest reasoning speedup in the benchmark comes from `shaclIn` plus `sh:closed true`: the optimizer can drop unrelated message-local facts before invoking Eyeling. Rule pruning helps too, but the rule-section reduction in this tiny ontology is modest because the static background ontology already activates a small RDFS/OWL subset.

For larger ontologies and rule profiles, `shaclOut` can remove more rules when the desired output shape is narrow. For noisy RDF Messages or event batches, `shaclIn` can be more important because it controls how much input data reaches the reasoner.

## Safety and correctness constraints

Shape hints are safe only when treated as trusted contracts:

- The engine does not validate `infer()` input against `shaclIn`.
- If the input does not conform, closed-shape pruning may drop facts that would have mattered.
- If the application needs output outside `shaclOut`, the shape-guided runtime may not derive it.
- Use upstream SHACL validation when conformance is not guaranteed.
- Pass `{ selectRuntimeRules: false }` to `load()` when later `infer()` calls may contain new ontology/schema/shape axioms that were not known at load time.
- Pass `{ optimizeShapeInput: false }` to `infer()` when you want the shape-guided runtime but do not want per-input pruning/ordering for a particular batch.

## When to use this feature

Use SHACL in/out optimization when:

- your RDF Messages or input batches have stable documented shapes;
- the application only needs a known output projection;
- inputs may contain noise or transport/debug facts unrelated to reasoning;
- you can validate upstream or otherwise trust input conformance;
- you want saved runtimes that preserve optimization metadata.

Avoid it when:

- input shape is not stable;
- input may contain new schema/ontology facts;
- the application expects arbitrary profile output;
- closed-shape pruning would be unsafe.
