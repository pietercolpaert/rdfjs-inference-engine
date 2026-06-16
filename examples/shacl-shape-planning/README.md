# SHACL in/out shape planning playground

This command-line example shows how `load(..., { shaclIn, shaclOut })` can use SHACL shapes as trusted optimization hints.

The shapes are **not** used for SHACL validation. They describe the expected incoming RDF and desired outgoing RDF so the generated runtime can keep a smaller rule subset.

Files:

- `ontology.n3` — tiny RDFS background ontology.
- `input.messages.trig` — ten-message RDF Messages stream to infer over.
- `shapes-in.n3` — trusted input shape contract.
- `shapes-out.n3` — trusted output shape contract, split into observation and sensor node shapes.
- `run.ts` — command-line playground.

Run it from the repository root:

```bash
npm run build:node --silent
node dist/examples/shacl-shape-planning/run.js
```

Compare with shape planning disabled:

```bash
node dist/examples/shacl-shape-planning/run.js --no-shapes
```

Save the generated runtime for inspection:

```bash
node dist/examples/shacl-shape-planning/run.js --save-runtime
```

That writes `generated/shacl-shape-planning-runtime.n3` with comments describing the compiled input/output shape plan.
