# SHACL Validation as Inferencing

This folder contains an experiment in which validation reports are generated through N3 rules. These profiles are not loaded by default and are not bundled into the browser playground's default rule profile.

## Status

This experiment will not be further developed as part of this repository but is left here for reference. If you like the ideas outlined here, you’ll also like this project: https://github.com/giacomociti/eye-shacl

## Profiles

- `shacl-core-eyeling.n3` is an Eyeling-targeted SHACL Core validation profile. It emits `sh:ValidationResult` triples for closed-world validation and is tested against the W3C SHACL Core suite by the boolean `sh:conforms` criterion.
- `shacl12-core-eyeling.n3` is a draft SHACL 1.2 Core extension layer for `shacl-core-eyeling.n3`, not a standalone profile.

The current SHACL Core rules cover Core targets, node and property shapes, directly targeted property shapes, deactivation, goal-directed SHACL property paths, `sh:class`, `sh:datatype` including ill-formed literals, count constraints, value constraints, `sh:in`, numeric/date comparison facets, string length facets, `sh:pattern`, and the Core list/boolean shape combinations exercised by the suite.

The current SHACL 1.2 additions cover `sh:ShapeClass`, explicit data-side `sh:shape` targets, constant Core node expressions for `sh:values` and `sh:defaultValue`, `sh:singleLine`, nested property-shape bindings used by validation-report tests, and reifier-shape checks in the test harness' RDF 1.2 annotation rewrite.

Full validation-report graph isomorphism and guarantees beyond the W3C boolean-conformance harness remain out of scope.

## Tests

The root package keeps these tests available, but they explicitly load the rules from this experimental folder.

```bash
npm run test:shacl
npm run test:shacl12
npm run test:shacl-manual
```

`npm run test:shacl` downloads and caches W3C SHACL Core fixtures under `.cache/shacl-test-suite/`, runs all Core manifests against `rules/shacl-experimental/shacl-core-eyeling.n3`, and compares the expected `sh:conforms` boolean.

`npm run test:shacl12` downloads and caches fixtures under `.cache/shacl12-test-suite/`, runs the SHACL Core profile together with `rules/shacl-experimental/shacl12-core-eyeling.n3`, rewrites RDF 1.2 annotation syntax used by reifier tests into helper triples for the current RDF-JS parser, respects `sh:conformanceDisallows`, and checks the expected `sh:conforms` value.

For debugging a SHACL Core fixture or manifest:

```bash
npm run build:node --silent && node dist/tests/run-shacl-core.js --only=core/complex/shacl-shacl.ttl
npm run build:node --silent && node dist/tests/run-shacl-core.js --manifest=core/complex/manifest.ttl
```
