# SHACL validation example

This example runs the default bundled SHACL Core validation profile over a small people dataset.

The shapes describe a valid `ex:Person` as having:

- at least one `ex:name` value with datatype `xsd:string`;
- an `ex:age` value greater than or equal to `0` and at most `120`;
- at most one `ex:email` value matching a simple email-like pattern.

`ex:Alice` conforms. `ex:Bob` violates four constraints: missing name, negative age, too many email values, and one malformed email value.

## Files

- `shapes.n3` — SHACL shapes graph.
- `input.trig` — RDF data graph.
- `expected-output.n3` — selected validation results.
- `run.ts` — example runner that uses the default bundled rule profiles.

## Run

From the repository root:

```bash
npm run example:shacl-validation
```

## Check

```bash
npm run test:shacl-validation
```
