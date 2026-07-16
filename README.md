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
const data = parseToQuads(readFileSync('examples/transit-fleet/input.trig', 'utf8'));

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
- `infer(quads)` returns newly inferred RDF-JS quads.
- `inferAsync(quads, { store })` runs with Eyeling's async runner and optional named persistent fact store.
- `createInferenceStream()` / `stream()` creates an object-mode transform stream.

## Bundled Rule Profiles

Default profiles are discovered from rule-set folders under `rules/`:

- [OWL 2 RL](rules/owl2rl/README.md) - `rules/owl2rl/owl2rl-eyeling.n3`
- [SKOS Core](rules/skos/README.md) - `rules/skos/skos-entailment.n3`
- [QUDT/CDT normalization](rules/qudt/README.md) - `rules/qudt/qudt-cdt-normalization.n3`

The experimental SHACL validation profiles are documented separately in [rules/shacl-experimental/README.md](rules/shacl-experimental/README.md) and are not loaded by default.

QUDT/CDT normalization also ships a precompiled same-folder runtime snapshot, `rules/qudt/qudt-cdt-normalization.runtime.n3`, so package installs and browser builds do not need to fetch or materialize `https://qudt.org/qudt-all`.

## Browser Bundle And Playground

The browser bundle exposes `window.RdfjsInferenceEngine`, including `InferenceEngine`, `Parser`, `Writer`, `DataFactory`, `parseRdfOrMessages()`, `writeQuads()`, and `writeMessages()`.

```html
<script src="https://www.pieter.pm/rdfjs-inference-engine/browser/rdfjs-inference-engine.min.js"></script>
```

The root [index.html](index.html) file is a browser playground. At browser-build time it bundles the default rule profiles from `rules/`, including QUDT's precompiled runtime snapshot. The advanced profile selector can enable or disable individual profiles.

Build only the browser artifacts with:

```bash
npm run build:browser
```

## Examples

Examples are self-contained folders under `examples/`. Each runnable example keeps its own `README.md`, `run.ts`, ontology/background file, input file, and expected output fixture.

- [Transit fleet](examples/transit-fleet/README.md)
- [Shipment logistics](examples/shipment-logistics/README.md)
- [SKOS taxonomy](examples/skos-taxonomy/README.md)
- [OWL + SKOS catalog](examples/owl-skos-catalog/README.md)
- [SHACL shape planning](examples/shacl-shape-planning/README.md)
- [Inconsistency diagnostics](examples/inconsistency-diagnostics/README.md)
- [Transit RDF Messages](examples/transit-messages/README.md)
- [Stateful RDF Messages materialization](examples/stateful-materialization/README.md)

Run all example output checks with:

```bash
npm run test:examples
```

## Tests

```bash
npm test
```

The default test command builds the Node output, checks default rule loading, stateful skolemization, the MARC list fixture, SKOS entailment, and the compatible OWL 2 RL MobiBench and W3C subsets.

Useful focused commands:

```bash
npm run test:default-rules
npm run test:skos
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
      input.trig
      expected-output.n3
      run.ts
```

Keep rule profiles and background data versioned, regenerate compiled runtimes when either changes, and deduplicate emitted triples outside the reasoner before storing or publishing them.


## License

© Ghent University - IMEC. MIT licensed.

Maintainer: Pieter Colpaert