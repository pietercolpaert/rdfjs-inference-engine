# Museum object heights with QUDT

Select **Museum object heights (QUDT: cm/mm → m)** in the SPARQL CONSTRUCT playground. Generate the query, then run it with Comunica on the bundled messages.

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

The editable N3 mapping profile expresses this arithmetic using `math:sum`, `math:product`, `math:quotient`, and `math:difference`. The runtime translator emits SPARQL `BIND` expressions directly from those rules. Its backward offset helper supplies zero when offsets are absent. Comunica executes the translated rules to a fixed point before running the consumer output query. Editing the N3 arithmetic changes the result; there is no separate TypeScript conversion implementation.

The same translator and executor are exported by the Node.js library. The default profile supports direct, required quantity-value fields and one output unit, with positive, unambiguous multipliers and matching dimensions. Missing or invalid metadata prevents the normalization rule from firing. Unknown units, missing units and nonnumeric values cannot construct a complete normalized record. Numeric result datatypes follow SPARQL arithmetic and are filtered by consumer SHACL. Logarithmic/CDT conversions and general unit-expression algebra require built-ins or representations beyond this supported subset; unsupported rules produce compiler diagnostics.

Identifiers, object links, and message boundaries are preserved. `expected-output.messages.trig` provides the three resulting quantities. Run `npm run test:sparql-construct` to verify the conversions in both Node.js and the actual browser Comunica worker, including offset arithmetic and invalid-input handling.
