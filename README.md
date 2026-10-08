# RDF-JS inference engine

Small TypeScript library for doing generated-runtime materialization at ingest time with [Eyeling](https://github.com/eyereasoner/eyeling), N3 rules, [rdf-parser-ts](https://www.npmjs.com/package/rdf-parser-ts), and RDF-JS quads.

The engine is intentionally rule-profile agnostic. The bundled profiles live under `rules/`, and each rule-set folder documents what it does, what it does not do, and how it is tested.

## Install

```bash
npm install rdfjs-inference-engine
```

```ts
import { InferenceEngine } from 'rdfjs-inference-engine';
```

For local development:

```bash
npm install
npm run build
```

`npm run build` builds the Node output in `dist/` and the committed browser bundles in `browser/`.

## Basic Use

```ts
import { readFileSync } from 'node:fs';
import type { Quad } from '@rdfjs/types';
import { DataFactory, isMessageQuad, Parser } from 'rdf-parser-ts';
import { InferenceEngine } from 'rdfjs-inference-engine';

const ontology = parseToQuads(readFileSync('examples/transit-fleet/ontology.n3', 'utf8'));
const data = parseToQuads(readFileSync('examples/transit-fleet/input.messages.trig', 'utf8'));

const reasoner = new InferenceEngine();
reasoner.load(ontology);

const inferred = Array.from(reasoner.infer(data));

function parseToQuads(source: string): Quad[] {
  const parser = new Parser({ factory: DataFactory });
  const parsed = parser.parse(source) ?? [];
  return Array.from(parsed as Iterable<unknown>, (item) => (isMessageQuad(item) ? item.quad : item) as Quad);
}
```

Calling `load(background)` loads all default bundled rule profiles, computes the static background closure, and compiles a generated runtime. Pass one profile or an array of profiles explicitly when you want a smaller or custom ruleset.

## API

The main class is `InferenceEngine`.

- `constructor({ runtime })` or `constructor({ runtimePath })` loads a previously generated runtime.
- `load(vocabularyDataset)` loads all default bundled rule profiles.
- `load(profileOrProfiles, vocabularyDataset)` loads explicit N3 profile text or profile objects.
- `load(..., { runtimeCompiler })` provides a custom compiler.
- `load(..., { selectRuntimeRules: false })` keeps the full generic profile when later `infer()` calls may contain schema or shape triples.
- `load(..., { shaclIn, shaclOut })` uses trusted SHACL input/output shapes as optimization and projection hints. These hints are contracts, not validation.
- `load(..., { skolemKey })` makes static closure `log:skolem` IRIs deterministic for a project/store key.
- `saveRuntime(path)` writes the generated runtime.
- `infer(quads)` returns newly inferred RDF-JS quads, including structured OWL inconsistency reports.
- `inferAsync(quads, { store })` runs with Eyeling's async runner and optional named persistent fact store.
- `createInferenceStream()` / `stream()` creates an object-mode transform stream.

## N3 runtime to SPARQL CONSTRUCT

The [SPARQL CONSTRUCT playground](sparql-construct.html), linked from the main playground, accepts a provider ontology, provider SHACL, and consumer SHACL. Each RDF input has an editable CodeMirror field and a URL **Load** button. The examples include NDE-inspired Amsterdam photographs, QUDT museum object heights, and sensor readings.

The **N3 mapping rules** editor is the source of the inference behavior. `generateSparqlConstruct` assembles these rules with ontology and consumer-shape facts, translates the N3 runtime, and generates a separate consumer output projection. Ontology entailment and QUDT arithmetic are defined in the editable [N3 profile](src/sparql-rule-profile.ts); the translator has no hardcoded unit conversion or property mapping. Changing a supported rule changes its emitted SPARQL and executed result. Provider SHACL documents the input contract; it does not invent inference rules or validate messages.

A general recursive N3 runtime cannot be represented by one finite SPARQL CONSTRUCT query. The generated program loads static facts once, executes its rule queries in source order until no new facts appear, then executes the displayed output query on rule-head facts. The expandable runtime panel shows the complete N3 source and every translated query. **Download runtime .json** exports the program and output query together; copying the output query alone does not export the inference stage.

The bundled Comunica worker runs this same program without Eyeling or background fetches. Messages are isolated default graphs; ordinary RDF forms one message. Input data supports URL loading, progress, **Stop**, output and expected-output editors. Editing rules or mapping inputs invalidates the program. Editing data clears results while preserving the program.

Node.js and the browser export the same compiler and executor:

```ts
import { readFileSync } from 'node:fs';
import { Parser } from 'rdf-parser-ts';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import {
  generateSparqlConstruct, executeSparqlRuntime, createRdfjsSparqlExecutor,
} from 'rdfjs-inference-engine';

const readRdf = (path: string) => new Parser().parse(readFileSync(path, 'utf8'));
const result = generateSparqlConstruct({
  ontology: readRdf('provider-ontology.ttl'),
  shaclIn: readRdf('provider-shape.ttl'),
  shaclOut: readRdf('consumer-shape.ttl'),
  // rules: readFileSync('mapping.n3', 'utf8'), // optional editable/custom runtime
});
if (!result.program || !result.query) {
  throw new Error(result.diagnostics.map(d => d.message).join('\n'));
}
const execution = await executeSparqlRuntime(
  result.program, readRdf('message.ttl'),
  createRdfjsSparqlExecutor(new QueryEngine()),
  { outputQuery: result.query },
);
console.log(execution.output); // RDF-JS quads
```

Install Comunica separately when using that adapter; the library does not require it. Any SPARQL executor can be supplied as `(query, dataset) => Promise<Iterable<Quad>>`, provided it preserves RDF term identities. The Comunica adapter restores source-scoped blank-node identities before reinserting results. Call the executor separately for each message; flatten any named graphs to that message's default graph first.

To translate an existing generated runtime directly, use `translateN3RuntimeToSparql(engine.getRuntime())` or `engine.getSparqlRuntime()`. Translation returns `{ program, diagnostics }`; any unsupported construct makes `program` null. `generateSparqlConstruct` additionally returns the exact `runtime`, an output `query`, projection `mappings`, and diagnostics. Its projection mappings describe already inferred consumer paths, not an inventory of ontology mappings. Missing data or metadata normally causes rules not to fire rather than a compile-time error.

Supported N3 features are forward implications with conjunctive graph patterns, variable predicates, safe multi-triple heads, body blank nodes, static RDF facts/lists, and nonrecursive backward helpers (including list arguments and multiple clauses compiled to UNION). The emitted SPARQL uses these built-ins:

| N3 built-ins | SPARQL |
| --- | --- |
| `math:sum`, `product`, `difference`, `quotient`, `negation` | arithmetic `BIND` / comparisons for already bound results |
| `math:absoluteValue`, `rounded`, `floor`, `ceiling` | `ABS`, `ROUND`, `FLOOR`, `CEIL` |
| `math:greaterThan`, `lessThan`, `notGreaterThan`, `notLessThan`, `equalTo`, `notEqualTo` | numeric comparisons |
| `log:equalTo`, `notEqualTo` | term equality / equality binding |
| `string:concatenation`, `contains`, `startsWith`, `endsWith`, `matches` | `CONCAT`, `CONTAINS`, `STRSTARTS`, `STRENDS`, `REGEX` |
| `dt:datatype`, `dt:lexicalForm` (Eyeling datatype namespace) | `DATATYPE`, `STR` |
| `log:dtlit` with bound lexical text and datatype | `STRDT` |
| `1 log:includes/notIncludes { ... }` | current-store `FILTER EXISTS / NOT EXISTS` |

Built-in dependencies are ordered automatically; unsupported binding directions are errors. Arithmetic and inspection bind their output from bound inputs; they do not solve inverse equations. Regex and numeric lexical rendering follow the SPARQL engine. Current-store containment is an explicitly limited extension: it emits a warning, runs eagerly in source order, and never retracts earlier heads. It does not implement general N3 formula containment or a truth-maintenance system.

This is a supported-subset compiler, not a translation of every bundled Eyeling profile. Existential head nodes, recursive backward helpers, ordinary list-valued rule heads, named graphs, arbitrary formula operations, `log:skolem`, exponentiation/logarithmic QUDT conversions, CDT parsing, unsupported built-ins and unsafe/unbound heads produce diagnostics. The executor defaults to 100 rounds and 100,000 facts and throws on limit exhaustion instead of returning incomplete output. These limits can be configured.

The consumer projection supports direct predicates, inverse paths and sequences, optional/required fields, literal datatype and node-kind filtering, class constraints, `sh:in` and existing `sh:hasValue`. It does not fabricate constants, repair cardinality, cast values or replace SHACL validation. Alternative/repeated output paths and nested/logical consumer shapes are rejected.

The default N3 QUDT rules normalize direct quantity-value records to one output unit using matching dimension vectors and positive unambiguous multipliers. Missing offsets default to zero through a backward N3 helper. Consumer SHACL needs a target class, required `qudt:numericValue` and `qudt:unit`, and one target `sh:hasValue`; `sh:unit` on the numeric field can repeat the same target. Unknown or incompatible units do not yield a normalized record. Numeric result types follow SPARQL arithmetic and must match the consumer datatype. See the [QUDT example](examples/sparql-construct/qudt-museum-dimensions/README.md).

Run `npm run test:sparql-construct` for translator/Eyeling parity, rule editing, chaining and recursion, compiler diagnostics, library and browser parity, Comunica execution and message isolation.

## Bundled Rule Profiles

Default profiles are discovered from rule-set folders under `rules/`:

- [OWL 2 RL](rules/owl2rl/README.md) - `rules/owl2rl/owl2rl-eyeling.n3`
- [SKOS Core](rules/skos/README.md) - `rules/skos/skos-entailment.n3`
- [QUDT/CDT normalization](rules/qudt/README.md) - `rules/qudt/qudt-cdt-normalization.n3`

The experimental SHACL validation profiles are documented separately in [rules/shacl-experimental/README.md](rules/shacl-experimental/README.md) and are not loaded by default.

QUDT/CDT normalization also ships a precompiled same-folder runtime snapshot, `rules/qudt/qudt-cdt-normalization.runtime.n3`, so package installs and browser builds do not need to fetch or materialize `https://qudt.org/qudt-all`.

## Vocabularies

Project-defined RDF terms are published as HTML+RDFa through GitHub Pages:

- [OWL inconsistency diagnostics](https://www.pieter.pm/rdfjs-inference-engine/ns/inconsistencies)
- [QUDT inference](https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference)
- [Internal implementation terms](https://www.pieter.pm/rdfjs-inference-engine/ns/internal)

The internal namespace is not an application contract and may change between releases. Example-specific `https://example.org/...` IRIs describe only fixture data and are not project vocabularies.

## Browser Bundle And Playground

The browser bundle exposes `window.RdfjsInferenceEngine`, including `InferenceEngine`, `Parser`, `Writer`, `DataFactory`, `parseRdfOrMessages()`, `writeQuads()`, and `writeMessages()`.

```html
<script src="https://www.pieter.pm/rdfjs-inference-engine/browser/rdfjs-inference-engine.min.js"></script>
```

The root [index.html](index.html) file is a browser playground. Every scenario starts with an RDF Message Log and a pair of trusted SHACL contracts: SHACL IN describes the source representation and SHACL OUT describes the representation the application needs. The playground shows that alignment flow, background ontology, input messages, and output messages directly; rule-profile selection, stateful materialization, and the generated N3 runtime are available under advanced controls.

Each ontology, SHACL IN, SHACL OUT, and message editor has a URL field and **Load** button directly in its panel. Loading fills the visible CodeMirror editor with editable RDF; inference uses those editor contents. RDF Message Logs retain their message boundaries.

The playground parses editor fields with `rdf-parser-ts`, covering Turtle, TriG, N-Triples, N-Quads, RDF 1.2, and RDF Message Logs. URL sources are dereferenced with [ldfetch](https://www.npmjs.com/package/ldfetch), which negotiates and parses Linked Data formats such as JSON-LD, RDF/XML, RDFa, Microdata, SHACL Compact syntax, Jelly-RDF, and the same Turtle-family formats. This keeps the local text-field parser predictable while broadening remote data ingestion.

At browser-build time the playground bundles the default rule profiles from `rules/`, including QUDT's precompiled runtime snapshot. SHACL contracts specialize applicable rules where supported, prune irrelevant input facts, and project inferred output while preserving message boundaries. They are optimization contracts rather than a replacement for validation.

Build only the browser artifacts with:

```bash
npm run build:browser
```

## Examples

Examples are self-contained folders under `examples/`, with their own README, `input.messages.trig`, `shapes-in.n3`, `shapes-out.n3`, and background ontology fixtures.

- [Transit fleet](examples/transit-fleet/README.md)
- [Shipment logistics](examples/shipment-logistics/README.md)
- [SKOS taxonomy](examples/skos-taxonomy/README.md)
- [OWL + SKOS catalog](examples/owl-skos-catalog/README.md)
- [SHACL shape planning](examples/shacl-shape-planning/README.md)
- [Inconsistency diagnostics](examples/inconsistency-diagnostics/README.md)
- [Transit RDF Messages](examples/transit-messages/README.md)
- [Stateful RDF Messages materialization](examples/stateful-materialization/README.md)
- [QUDT mixed speeds](examples/qudt-mixed-speed/README.md)
- [QUDT temperatures with OWL](examples/qudt-temperature-owl/README.md)
- [QUDT units with SKOS](examples/qudt-speed-skos/README.md)
- [QUDT logarithmic measurements](examples/qudt-logarithmic/README.md)
- [QUDT quantity-object safety](examples/qudt-quantity-safety/README.md)

Run all example output checks with:

```bash
npm run test:examples
```

## Tests

```bash
npm test
```

The default test command builds the Node output, checks default rule loading, stateful skolemization, the MARC list fixture, SKOS and QUDT inference, and the compatible OWL 2 RL MobiBench and W3C subsets.

Useful focused commands:

```bash
npm run test:default-rules
npm run test:skos
npm run test:qudt
npm run test:owl
npm run test:owl:mobibench
npm run test:owl:official
npm run test:shacl-shape-planning
```

The profile-specific README files describe the rule-level test coverage.

## Generated Runtimes

`load()` performs a preprocessing pass before input inference:

1. compute the closure of the selected rules and stable background quads;
2. compile a generated runtime, optionally selecting only rules that can still fire for future input and partially evaluating common static OWL 2 RL schema joins;
3. keep the runtime in memory, or persist it with `saveRuntime()`;
4. run incoming RDF through the generated runtime and emit newly inferred quads.

This pattern fits ingest pipelines where rules and background knowledge are stable but input RDF changes frequently. Pass `{ selectRuntimeRules: false }` when conformance tests or applications provide new schema/shape axioms during `infer()`.

Trusted SHACL `shaclIn` and `shaclOut` hints can specialize runtime rules, prune per-input facts, and project output to the desired shape. Validate upstream if shape conformance is not guaranteed.

## Project Pattern

```text
rules/
   my-profile/
      README.md
      profile.n3
background/
   domain.n3
generated/
   runtime.n3
examples/
   my-example/
      README.md
      ontology.n3
      input.messages.trig
      expected-output.n3
      run.ts
```

Keep rule profiles and background data versioned, regenerate compiled runtimes when either changes, and deduplicate emitted triples outside the reasoner before storing or publishing them.


## License

© Ghent University - IMEC. MIT licensed.

Maintainer: Pieter Colpaert
