# RDF-JS inference engine

This repository contains a small TypeScript library for doing **generated-runtime materialization at ingest time** with [Eyeling](https://github.com/eyereasoner/eyeling), N3 rules, [rdf-parser-ts](https://www.npmjs.com/package/rdf-parser-ts), and RDF-JS quads.

The library core is intentionally agnostic about the ontology language or rule profile. The runnable example uses the bundled OWL 2 RL profile, which also contains the RDFS entailments needed by the small demo vocabulary.

The core idea is:

1. load one or more N3 rule profiles, such as the included OWL 2 RL profile;
2. load RDF-JS background vocabulary, ontology, taxonomy, or configuration quads;
3. precompute the static background closure once;
4. create a generated runtime N3 file with either the default generic compiler or a caller-provided compiler;
5. run ordinary RDF input through that generated runtime and emit only newly inferred quads.

This is useful when a service receives RDF, enriches it immediately, and stores or publishes materialized triples so downstream systems can query ordinary RDF without running the same inference step themselves.

## Requirements

Use the latest Eyeling version. The OWL 2 RL profile uses datatype builtins added after issue `eyereasoner/eyeling#18`.

The example can be run without installing Eyeling globally:

```bash
npx --yes eyeling --version
```

Eyeling requires Node.js. The upstream package currently documents Node.js `>=18`.

Install dependencies and build the library with:

```bash
npm install
npm run build
```

`npm run build` now builds both the Node package output and the committed browser bundles in `browser/`.

## How it works

### 1. N3 rules as profiles

The file:

```text
rules/owl2rl-eyeling.n3
```

contains an N3 implementation-oriented OWL 2 RL/RDF ruleset for Eyeling. The engine treats this as ordinary N3 text; it does not hard-code OWL or RDFS semantics.

The OWL 2 RL profile includes the RDFS entailments needed by the example, including rules for:

- `rdfs:subClassOf`
- `rdfs:subPropertyOf`
- `rdfs:domain`
- `rdfs:range`

It also includes broader OWL 2 RL consequences such as `owl:sameAs`, class expressions, property characteristics, datatype rules, and inconsistency diagnostics. The library filters reflexive `owl:sameAs` triples from emitted inference output because they are usually closure-maintenance tautologies rather than useful application data.

The ruleset is meant to be passed to the library as a rule profile. In normal projects, keep rule profiles vendored/versioned and pass your own background quads to `load()`.

### 2. Background knowledge

The example background vocabulary is:

```text
examples/transit-fleet/ontology.n3
```

It defines a tiny transit model:

```n3
:ElectricBus rdfs:subClassOf :Bus .
:Bus rdfs:subClassOf :Vehicle .
:operatedBy rdfs:domain :Vehicle ;
  rdfs:range :Operator .
```

The RDFS entailments come from `rules/owl2rl-eyeling.n3`; there is no TypeScript implementation of RDFS or OWL entailment. When the input says that `:bus-42 a :ElectricBus`, the generated runtime derives that `:bus-42 a :Bus` and `:bus-42 a :Vehicle`. When the input says that `:bus-42 :operatedBy :operator-7`, the generated runtime derives that `:operator-7 a :Operator`.

### 3. TypeScript API

The main class is `InferenceEngine`.

```ts
import { readFileSync } from 'node:fs';
import type { Quad } from '@rdfjs/types';
import { DataFactory, isMessageQuad, Parser } from 'rdf-parser-ts';
import { InferenceEngine } from 'rdfjs-inference-engine';

const profile = readFileSync('rules/owl2rl-eyeling.n3', 'utf8');
const ontology = parseToQuads(readFileSync('examples/transit-fleet/ontology.n3', 'utf8'));

const reasoner = new InferenceEngine();
reasoner.load(profile, ontology);
reasoner.saveRuntime('generated/transit-fleet-runtime.n3');

const data = parseToQuads(readFileSync('examples/transit-fleet/input.trig', 'utf8'));
const inferred = reasoner.infer(data);

function parseToQuads(source: string): Quad[] {
   const parser = new Parser({ factory: DataFactory });
   const parsed = parser.parse(source) ?? [];
   return Array.from(parsed as Iterable<unknown>, (item) => (isMessageQuad(item) ? item.quad : item) as Quad);
}
```

`InferenceEngine` uses the `rdf-parser-ts` data factory by default. You can still pass any RDF-JS-compatible `dataFactory` in the constructor.

`InferenceEngine` supports:

- `constructor({ runtime })` or `constructor({ runtimePath })` to load a previously generated runtime;
- `load(profileOrProfiles, vocabularyDataset)` to precompute the static background closure and load the generated runtime in memory;
- `load(profileOrProfiles, vocabularyDataset, { runtimeCompiler })` to provide custom compilation for a specific rule profile or ontology language;
- `saveRuntime(path)` to save that runtime as an N3 file;
- `infer(quads)` to infer over an array of RDF-JS quads and return a generator of inferred RDF-JS quads;
- `createInferenceStream()` / `stream()` to create an object-mode transform stream where each incoming iterable of quads produces one array of inferred quads.

### Browser bundle and playground

The browser build creates a minified global bundle:

```text
browser/rdfjs-inference-engine.min.js
```

Include it directly in a web page:

```html
<script src="browser/rdfjs-inference-engine.min.js"></script>
```

The bundle exposes `window.RdfjsInferenceEngine`, including `InferenceEngine`, `Parser`, `Writer`, `DataFactory`, `parseRdfOrMessages()`, `writeQuads()`, and `writeMessages()`.

The root `index.html` file is a browser playground. At browser-build time, it bundles every `.n3` file from the repository `rules/` folder as the default rule profile. The page provides syntax-highlighted RDF editors for:

- ontology/background RDF used to generate the runtime, selected as either a URL or text input;
- ordinary RDF input or an RDF Messages log, selected as either a URL or text input;
- inferred output triples.

It uses `rdf-parser-ts` message detection. Ordinary RDF input is passed to `infer()`. RDF Messages input is grouped by message and passed through the browser `stream()` object. In that case, the inferred output is serialized as RDF Messages too, starting with `VERSION "1.2-messages"` and delimiting inferred message chunks with `MESSAGE`. The playground stores editable state in the URL hash so examples can be shared as links.

Build only the browser artifacts with:

```bash
npm run build:browser
```

Git hooks are tracked in `.githooks/`. `npm install` or `npm run hooks:install` configures the repository to use them. The pre-commit hook regenerates and stages the browser bundles; the pre-push hook regenerates them again and blocks the push if the generated files differ from what is committed.

## Run the transit fleet example

From the repository root:

```bash
./scripts/run-example.sh
# or:
npm run example:transit-fleet
```

The transit fleet example is self-contained in `examples/transit-fleet/`:

- `ontology.n3`
- `input.trig`
- `expected-output.n3`

The script uses the TypeScript library and has two phases.

First, it materializes the ruleset plus background vocabulary without input data, then
uses the default compiler to create a generated runtime file:

```text
generated/transit-fleet-runtime.n3
```

That generated file contains the OWL 2 RL rule profile plus the precomputed background closure. Second, Eyeling processes ordinary RDF input using only this generated runtime file plus the input file. Because this second pass runs without `--stream-messages` and without `log:query`, the library returns only newly derived quads from Eyeling's `onDerived` callback.

Expected output:

```n3
@prefix : <https://example.org/transit#>.

:bus-42 a :Vehicle.
:operator-7 a :Operator.
:bus-42 a :Bus.
```

The input triples themselves are not returned; Eyeling emits the newly derived
triples from the generated runtime.

To check the example mechanically:

```bash
npm run example:transit-fleet --silent > /tmp/owl2rl-transit-fleet-output.n3
diff -u examples/transit-fleet/expected-output.n3 /tmp/owl2rl-transit-fleet-output.n3
```

## Run the shipment logistics OWL 2 RL example

The more elaborate example in `examples/shipment-logistics/` exercises OWL 2 RL features beyond subclass/domain/range reasoning:

- `ontology.n3`
- `input.trig`
- `expected-selected-output.n3`

- `owl:equivalentClass`
- `owl:equivalentProperty`
- `owl:inverseOf`
- `owl:SymmetricProperty`
- `owl:TransitiveProperty`
- `owl:FunctionalProperty`
- `owl:InverseFunctionalProperty`
- `owl:hasValue`
- `owl:someValuesFrom`
- `owl:allValuesFrom`

Run it with:

```bash
npm run example:shipment-logistics
```

The script asserts that all selected expected entailments are present in the closure, then prints only that selected subset so the fixture stays readable:

```bash
npm run test:shipment-logistics
```

The selected expected output is stored in `examples/shipment-logistics/expected-selected-output.n3`.

## MobiBench OWL 2 RL tests

The repository includes a MobiBench harness for the OWL 2 RL RDF-based test-suite archive:

```text
https://william-vw.github.io/mobibench/web/res/owl/conf/testsuite-owl2-rdfbased.zip
```

The harness downloads and caches the archive, reads the `owl2rl` subsuite, and evaluates focused Turtle test cases by kind:

- positive entailment: the conclusion graph must be contained in the materialized closure;
- inconsistency: the closure must contain an `owlrl:Inconsistency` diagnostic.

Run the default compatible MobiBench subset with:

```bash
npm run test:owl:mobibench
```

The default subset covers RDFS subclass/subproperty/domain/range behavior, equality substitution, equivalent classes/properties, functional/inverse-functional/symmetric/transitive properties, restrictions, datatype equality/validation/inconsistency cases, and inconsistency diagnostics. The harness can also list discovered MobiBench tests:

```bash
npm run build --silent && node dist/tests/run-mobibench-owl2rl.js --list
```

or run every discovered MobiBench OWL 2 RL test:

```bash
npm run build --silent && node dist/tests/run-mobibench-owl2rl.js --all
```

The `--all` mode is intentionally stricter and currently exposes unsupported areas such as list-heavy rules and some datatype edge cases.

## Official OWL 2 RL tests

The repository includes a harness for the W3C OWL 2 Test Case Repository. The harness downloads and caches these RDF/XML manifests:

- `https://www.w3.org/2009/11/owl-test/profile-RL.rdf`
- `https://www.w3.org/2009/11/owl-test/RL-RDF-rules-tests.rdf`
- `https://www.w3.org/2009/11/owl-test/type-positive-entailment.rdf`
- `https://www.w3.org/2009/11/owl-test/type-negative-entailment.rdf`
- `https://www.w3.org/2009/11/owl-test/type-consistency.rdf`
- `https://www.w3.org/2009/11/owl-test/type-inconsistency.rdf`
- `https://www.w3.org/2009/11/owl-test/proposed/profile-RL.rdf`
- `https://www.w3.org/2009/11/owl-test/proposed/RL-RDF-rules-tests.rdf`
- `https://www.w3.org/2009/11/owl-test/proposed/type-positive-entailment.rdf`
- `https://www.w3.org/2009/11/owl-test/proposed/type-negative-entailment.rdf`
- `https://www.w3.org/2009/11/owl-test/proposed/type-consistency.rdf`
- `https://www.w3.org/2009/11/owl-test/proposed/type-inconsistency.rdf`

It parses the RDF/XML manifests, selects approved or proposed RDF-Based OWL 2 RL tests with RDF/XML premise ontologies, runs them through `InferenceEngine`, and evaluates them by kind:

- positive entailment: the conclusion graph must be contained in the materialized closure;
- negative entailment: the non-conclusion graph must not be contained in the materialized closure;
- consistency: the closure must not contain an `owlrl:Inconsistency` diagnostic;
- inconsistency: the closure must contain an `owlrl:Inconsistency` diagnostic.

Blank nodes in expected graphs are matched by graph pattern, not by lexical blank-node label.

Run the default supported W3C subset with:

```bash
npm run test:owl:official
```

The default subset currently covers compatible positive, negative, consistency, and inconsistency cases from these manifests. The harness can also list discovered official tests:

```bash
npm run build --silent && node dist/tests/run-official-owl2rl.js --list
```

or run every discovered RDF-Based OWL 2 RL test from those manifests:

```bash
npm run build --silent && node dist/tests/run-official-owl2rl.js --all
```

You can restrict discovery or execution to particular kinds:

```bash
npm run build --silent && node dist/tests/run-official-owl2rl.js --list --kinds=positive,negative
```

You can also override the manifest list with comma-separated URLs or W3C archive paths:

```bash
npm run build --silent && node dist/tests/run-official-owl2rl.js --manifests=/2009/11/owl-test/profile-RL.rdf,/2009/11/owl-test/type-consistency.rdf
```

The `--all` mode is intentionally stricter and may expose unsupported or currently failing areas of the implementation.

The default test command runs both the compatible MobiBench subset and the compatible W3C subset:

```bash
npm test
```

The example output checks are kept separately:

```bash
npm run test:examples
```

## Preprocessing and generated runtimes

`load()` performs a generic preprocessing pass before input inference:

1. `scripts/run-example.sh` computes the complete static closure of the
   ruleset and background quads, including asserted background triples;
2. the default compiler creates a generic runtime from the profiles and static closure, or a caller-provided compiler can create optimized profile-specific runtime rules;
3. it stores the generated runtime in memory;
4. `saveRuntime()` can persist that runtime as a generated `.n3` file such as `generated/transit-fleet-runtime.n3`;
5. `infer()` uses only the generated runtime and the incoming RDF
   input, without message support and without `log:query`.

This preprocessing step is a good fit when the ruleset and ontology are stable:
you can regenerate the compiled runtime file whenever either changes, then reuse
it for many input runs. The library itself does not know about OWL, RDFS, SHACL,
SKOS, or any other ontology language. For RDFS in this repository, the entailment
regime is just another N3 rule file. If you want optimized profile-specific
runtime generation, pass a `runtimeCompiler` callback. In production, you still have three common
options:

1. emit all newly derived triples and filter downstream;
2. add project-specific filtering around the RDF-JS quads returned by `infer()`;
3. keep the full Eyeling closure if your application needs diagnostics or helper triples.

## Using this pattern in a project

A typical ingest-time architecture looks like this:

```text
RDF input
   -> Eyeling with generated/<example>-runtime.n3
  -> derived triples
  -> deduplication / validation / persistence
  -> SPARQL endpoint, event bus, cache, or materialized RDF store
```

Recommended project structure:

```text
rules/
   profile.n3                  # keep rule profiles vendored and versioned
background/
   domain.n3                   # your domain ontology or other stable quads
generated/
   runtime.n3                  # regenerated when rules or ontology change
examples/
   my-example/
      ontology.n3              # example-specific background quads
      input.trig               # example input data
      expected-output.n3       # regression-test fixture
```

For server use, keep rule profiles and background data stable, regenerate
the compiled runtime file when either changes, and run incoming RDF through the
compiled runtime rules. For high-throughput pipelines, deduplicate emitted triples
outside the reasoner before storing or republishing them.

## OWL 2 RL profile notes

The `rules/owl2rl-eyeling.n3` profile uses Eyeling's `dt:` builtins:

```n3
@prefix dt: <https://eyereasoner.github.io/eyeling/datatype#> .
```

These allow that profile to express OWL 2 RL datatype rules declaratively:

- `dt:datatype`
- `dt:lexicalForm`
- `dt:language`
- `dt:validForDatatype`
- `dt:invalidForDatatype`
- `dt:sameValueAs`
- `dt:differentValueFrom`
- `dt:canonicalLiteral`

That means cases such as these can now be handled by builtins rather than ad-hoc numeric-only rules:

```n3
"01"^^xsd:integer dt:sameValueAs "1.0"^^xsd:decimal .
"true"^^xsd:boolean dt:sameValueAs "1"^^xsd:boolean .
"2026-06-10T12:00:00Z"^^xsd:dateTime dt:sameValueAs "2026-06-10T14:00:00+02:00"^^xsd:dateTime .
```

The OWL 2 RL profile also emits optional `owlrl:canonicalLiteral` helper triples. These are not OWL 2 RL entailments; they are useful for diagnostics and can be ignored or removed if unwanted.

## Inconsistency handling

The OWL 2 RL profile does not derive bare `false` for every OWL 2 RL inconsistency. Instead, it emits explicit diagnostic resources:

```n3
?err a owlrl:Inconsistency .
```

This is intentional for ingest systems. A single bad input graph can be logged,
quarantined, or routed to a validation queue without stopping the entire
processor.

If you want fail-fast behavior, add a project rule such as:

```n3
@prefix owlrl: <https://w3id.org/owlrl-n3#> .

{ ?err a owlrl:Inconsistency . } => { false } .
```

Eyeling exits with a non-zero inference-fuse code when `false` is derived.

## Remaining limitations

There are still practical and semantic boundaries:

1. **OWL 2 RL, not OWL 2 DL**  
   This is a rule-materialization approach for the OWL 2 RL profile. It does not implement OWL 2 DL tableau reasoning, arbitrary class satisfiability checking, or full non-Horn disjunctive search.

2. **Materialization can grow quickly**  
   `owl:sameAs`, transitive properties, subclass closure, and property chains can produce many triples. Use output filters and external deduplication in production.

3. **Input state is an application policy**  
   This example processes the input as one ordinary RDF graph. If later inputs
   should build on earlier facts, maintain an external state graph and feed that
   state back into Eyeling.

4. **Literal subjects may appear in datatype meta-triples**  
   OWL 2 RL datatype rules can produce generalized triples such as a literal having `rdf:type xsd:integer`. Eyeling can print them, but some RDF 1.1 stores may reject literal subjects. Use `log:query` filters if your sink requires ordinary RDF 1.1 triples only.

5. **Rule profiles should still be tested against your data**  
   The file is implementation-oriented and should be treated as a vendored ruleset with regression tests. Do not assume that every edge case of every OWL 2 RL rule has been certified for your production data shape.

## References

- Eyeling repository: https://github.com/eyereasoner/eyeling
- Eyeling builtins catalog: https://github.com/eyereasoner/eyeling/blob/main/eyeling-builtins.ttl
- Eyeling issue for datatype builtins: https://github.com/eyereasoner/eyeling/issues/18
- OWL 2 RL profile: https://www.w3.org/TR/owl2-profiles/
- OWL 2 RL/RIF rules: https://www.w3.org/TR/rif-owl-rl/
- Notation3 Community Group specification: https://w3c-cg.github.io/N3/spec/
