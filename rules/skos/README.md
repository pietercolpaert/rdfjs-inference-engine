# SKOS Core rule profile

This folder contains `skos-entailment.n3`, a positive materialization profile for SKOS Core entailments.

## What It Does

The profile implements positive entailment-relevant parts of W3C SKOS Reference sections 3-10, including:

- concept-scheme links;
- lexical label and note super-properties;
- semantic-relation hierarchy, inverses, and transitive closures;
- collection member-list expansion;
- mapping-property hierarchy, symmetry, and selected transitivity.

## What It Does Not Do

The profile deliberately excludes SKOS-XL, integrity constraints, validation checks, qSKOS/SHACL quality checks, warnings, and best-practice diagnostics.

It also avoids overreaching materialization such as treating `skos:broader` itself as transitive, treating `skos:closeMatch` as transitive, or automatically inferring concept-scheme containment across ordinary semantic relations.

## Building

The profile is plain N3 and is included by the root build:

```bash
npm run build
```

No separate generated asset is required.

## Testing

Run the SKOS tests from the repository root:

```bash
npm run test:skos
```

The test harness uses local fixtures derived from positive entailments and explicit non-entailments in W3C SKOS Reference sections 3-10. It covers concept schemes, labels, notes, semantic relations, ordered collections, mapping properties, `skos:exactMatch` transitivity, and guards against intentionally unsupported entailments.
