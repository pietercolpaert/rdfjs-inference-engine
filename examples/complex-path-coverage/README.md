# Complex path coverage example

This example combines all three bundled profiles for a practical catalog quality check:

- **SKOS Core** expands the topic taxonomy with broader/narrower consequences.
- **OWL 2 RL** uses an `owl:propertyChainAxiom` to propagate an asset's `:theme` from a narrow SKOS concept to its broader SKOS concepts.
- **SHACL Core** uses a complex property path to validate catalog records reached from a required broad concept.

The SHACL path in `ontology.n3` is:

```turtle
sh:path ( [ sh:inversePath :theme ] [ sh:inversePath :describes ] )
```

From the focus concept `:vehicle`, it walks backwards to every asset with inferred `:theme :vehicle`, then backwards again to the catalog records that describe those assets:

```text
:vehicle <- :theme - ?asset <- :describes - ?record
```

This is useful when records are cataloged with specific SKOS concepts such as `:electricBus` or `:dieselBus`, while the quality rule is maintained at a broader concept such as `:vehicle`.

## Files

- `ontology.n3` — OWL classes/properties, SKOS taxonomy, and SHACL complex-path shape.
- `input.trig` — catalog records and assets.
- `expected-selected-output.n3` — selected inferred themes, class entailments, and validation results.
- `run.ts` — example runner using the default bundled rule profiles.

## Run

From the repository root:

```bash
npm run example:complex-path-coverage
```

## Check

```bash
npm run test:complex-path-coverage
```

## What to look for

- `:bus-42 :theme :vehicle` and `:bus-77 :theme :vehicle` are not asserted; they come from SKOS broader topics plus the OWL property chain.
- `:electric-bus-card` is only asserted as a `:QualityCheckedRecord`; OWL 2 RL infers that it is a `:ReviewedCatalogRecord`, so it satisfies the shape.
- `:diesel-bus-draft` is reachable through the complex path but is not a `:ReviewedCatalogRecord`, so SHACL emits one `sh:ValidationResult`.
