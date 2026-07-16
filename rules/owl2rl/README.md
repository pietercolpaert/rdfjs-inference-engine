# OWL 2 RL rule profile

This folder contains `owl2rl-eyeling.n3`, an implementation-oriented OWL 2 RL/RDF ruleset for Eyeling. The engine treats it as ordinary N3 text; OWL and RDFS semantics are not hard-coded into `InferenceEngine`.

## What It Does

The profile materializes RDFS and OWL 2 RL consequences used by ingest-time RDF applications, including:

- `rdfs:subClassOf`, `rdfs:subPropertyOf`, `rdfs:domain`, and `rdfs:range`;
- `owl:sameAs`, equivalent classes/properties, inverse properties, property characteristics, property chains, keys, and selected class expressions;
- datatype recognition, validation, canonicalization, equality, and inequality through Eyeling's `dt:` builtins;
- explicit inconsistency diagnostics as `owlrl:Inconsistency` resources.

The runtime compiler can partially evaluate stable ontology facts loaded through `load()`. For example, static domain/range, subclass, subproperty, equivalence, and inverse-property axioms can become direct runtime rules over incoming data.

## What It Does Not Do

The profile is a materialization profile, not a complete OWL reasoner. It does not aim to cover OWL DL reasoning outside OWL 2 RL/RDF rule consequences.

Application-mode output filters closure-maintenance facts that are usually not useful application triples, including reflexive `owl:sameAs`, internal helper predicates, generated Skolem helper triples, anonymous class-expression type triples, and datatype helper facts with literals in subject position.

## Building

The profile is plain N3 and does not need a separate build step. It is included in the package and browser playground by the root build:

```bash
npm run build
```

Generated runtimes are produced when `InferenceEngine.load()` is called. Save one with `saveRuntime()` if a project wants to reuse a compiled runtime.

## Testing

Run the OWL 2 RL tests from the repository root:

```bash
npm run test:owl
```

This runs both the MobiBench RDF-based OWL 2 RL harness and the supported W3C OWL 2 Test Case Repository subset.

The MobiBench harness downloads and caches `testsuite-owl2-rdfbased.zip`, reads the `owl2rl` subsuite, and checks positive entailment and inconsistency cases:

```bash
npm run test:owl:mobibench
npm run build --silent && node dist/tests/run-mobibench-owl2rl.js --list
```

The official harness downloads and caches W3C RDF/XML manifests, selects RDF-Based OWL 2 RL tests with RDF/XML premise ontologies, and checks positive entailment, negative entailment, consistency, and inconsistency cases:

```bash
npm run test:owl:official
npm run build --silent && node dist/tests/run-official-owl2rl.js --list
```

The `--all` mode on either harness is stricter than the default supported subset and may expose unsupported areas.

## Notes

The OWL profile uses Eyeling's datatype builtins:

```n3
@prefix dt: <https://eyereasoner.github.io/eyeling/datatype#> .
```

This lets datatype rules compare values such as `"01"^^xsd:integer` and `"1.0"^^xsd:decimal` by value instead of by lexical string. The profile also emits explicit inconsistency resources instead of deriving bare `false`, which lets ingest systems log or quarantine bad input without stopping the whole processor.
