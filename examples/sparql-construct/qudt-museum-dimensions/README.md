# Museum object heights with QUDT

Select **Museum object heights (QUDT: cm/mm → m)** in the SPARQL CONSTRUCT playground. Generate the query, then run it with Comunica on the bundled messages.

The execution plan shows all queries in numbered editors. The inference query contains the conversion `BIND` expressions; the final query selects the normalized measurements. **Copy queries** includes the complete plan.

The fictional collection records describe a Delftware vase, a display case, and a cabinet. Measurements are represented as QUDT quantity-value nodes, with a numeric value and a unit. The consumer needs all heights in metres:

| Input | Constructed output |
| --- | --- |
| 32 centimetres | 0.32 metres |
| 450 millimetres | 0.45 metres |
| 1.2 metres | 1.2 metres |

`ontology.ttl` contains the explicit measurement-class and property mappings, plus a small QUDT unit projection. [CentiM](https://qudt.org/vocab/unit/CentiM), [MilliM](https://qudt.org/vocab/unit/MilliM), and [M](https://qudt.org/vocab/unit/M) share a length dimension vector; their multipliers are 0.01, 0.001, and 1. The N3 runtime embeds this metadata, so executing it needs no unit-ontology fetch.

SHACL IN documents the allowed source units through `sh:in` on `qudt:unit`. SHACL OUT declares the desired numeric unit with `sh:unit unit:M` and requires `qudt:unit` to have `unit:M`. The generated query changes both the number and its unit:

```text
canonical = (input + sourceOffset) × sourceMultiplier
output = canonical / targetMultiplier − targetOffset
```

The engine’s bundled QUDT normalization profile expresses this arithmetic using `math:sum`, `math:product`, `math:quotient`, and `math:difference`. The runtime translator emits SPARQL `BIND` expressions directly from those rules. Its backward offset helper supplies zero when offsets are absent. Generation unfolds small positive helper views and combines compatible queries to reduce the execution plan. This example retains multiple queries because its normalization rules include current-store negation. Comunica executes the optimized SPARQL queries to a fixed point before running the consumer output query. N3 is used only during generation. Changing that N3 arithmetic changes the result; there is no separate TypeScript conversion implementation.

The same translator and executor are exported by the Node.js library. Generation uses the same `InferenceEngine.load` runtime as the main playground, including the bundled QUDT metadata snapshot. OWL derives `schema:about` from `museum:heightOf`; QUDT creates normalized quantity nodes linked to the original quantities through `qcr:sourceQuantity`. Consumer SHACL explicitly selects subjects of `qcr:sourceQuantity`, identifying those normalized records and follows `(qcr:sourceQuantity schema:about)` to the museum object. Original source values and identifiers remain intact. The SPARQL runtime uses deterministic SHA256 identifiers for generated nodes; these identifiers differ from Eyeling’s allocation scheme.

SHACL contracts specialize the profile, including its unit metadata. Units with a configured target profile can be selected in SHACL OUT; another target requires profile metadata or a custom profile. Arithmetic result datatypes follow SPARQL arithmetic and are preserved by the best-effort consumer projection; SHACL validation can happen afterwards. This is a supported-subset N3 compiler: logarithmic conversions and some datatype features still report unsupported constructs, and blank-node arguments to `log:skolem` raise an execution error. Use IRIs for quantity identifiers in this example.

Message boundaries are preserved. `expected-output.messages.trig` provides the resulting normalized quantities and source provenance. Run `npm run test:sparql-construct` to verify bundled-runtime reuse, conversions, offsets, configured reverse conversion and execution in the actual browser Comunica worker.
