# SHACL 1.2 + OWL RL grandfather example

This example is based on Holger Knublauch's grandfather example and shows SHACL 1.2 working in symbiosis with OWL RL inference.

The shapes graph defines `ex:Grandfather` as an OWL class for people that:

- have `ex:gender "male"`;
- have at least one grandchild through the OWL property chain `( ex:child ex:child )`, materialized as `ex:hasGrandchild`.

The file enables both targeting styles by default:

- `ex:GrandfatherShape1` keeps the SHACL 1.2 `sh:targetWhere` form from the original example and targets nodes directly from the data pattern.
- `ex:GrandfatherShape2` uses the simpler `sh:targetClass ex:Grandfather` form. This works because OWL RL infers that `ex:P1` is an `ex:Grandfather` from the class expression and property chain.

Both shapes use the same visible validation constraint: grandfathers must have an `ex:name`. In the input data, only `ex:P1` is a male person with grandchildren, and it has no `ex:name`, so the output contains two SHACL validation results for `ex:P1`: one from the direct SHACL 1.2 `sh:targetWhere` target and one from the OWL-inferred `sh:targetClass` target.

## Files

- `shapes.n3` — OWL RL background plus SHACL 1.2 shapes graph.
- `input.trig` — RDF data graph from the grandfather example.
- `expected-output.n3` — selected validation results proving that both shapes target `ex:P1`.
- `run.ts` — example runner using the default bundled rule profiles.

## Run

From the repository root:

```bash
npm run example:shacl12-grandfather
```

## Check

```bash
npm run test:shacl12-grandfather
```
