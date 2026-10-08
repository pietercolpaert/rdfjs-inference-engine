# Museum object heights with QUDT

Select **Museum object heights (QUDT: cm/mm → m)** in the SPARQL CONSTRUCT playground. Generate the query, then run it with Comunica on the bundled messages.

The fictional collection records describe a Delftware vase, a display case, and a cabinet. Measurements are represented as QUDT quantity-value nodes, with a numeric value and a unit. The consumer needs all heights in metres:

| Input | Constructed output |
| --- | --- |
| 32 centimetres | 0.32 metres |
| 450 millimetres | 0.45 metres |
| 1.2 metres | 1.2 metres |

`ontology.ttl` contains the explicit measurement-class and property mappings, plus a small QUDT unit projection. [CentiM](https://qudt.org/vocab/unit/CentiM), [MilliM](https://qudt.org/vocab/unit/MilliM), and [M](https://qudt.org/vocab/unit/M) share a length dimension vector; their multipliers are 0.01, 0.001, and 1. The query embeds this metadata, so executing it needs no unit-ontology fetch.

SHACL IN documents the allowed source units through `sh:in` on `qudt:unit`. SHACL OUT declares the desired numeric unit with `sh:unit unit:M` and requires `qudt:unit` to have `unit:M`. The generated query changes both the number and its unit:

```text
output = (input × sourceMultiplier + sourceOffset − targetOffset) / targetMultiplier
```

The compiler generates a `VALUES` table and decimal arithmetic in `BIND`, not a precomputed result. The same logic is available in Node.js through `generateSparqlConstruct`. Conversion is limited to direct, required `qudt:numericValue` and `qudt:unit` fields, explicitly declared source units, one target unit, and dimension-compatible affine QUDT metadata. It rejects missing or ambiguous metadata, nonpositive multipliers, and logarithmic units. Unknown source units, missing units, and nonnumeric values cannot construct a normalized record. CDT encodings and general unit-expression algebra are not supported by this SPARQL compiler.

Identifiers, object links, and message boundaries are preserved. `expected-output.messages.trig` provides the three resulting quantities. Run `npm run test:sparql-construct` to verify the conversions in both Node.js and the actual browser Comunica worker, including offset arithmetic and invalid-input handling.
