# QUDT normalization tests

`run-qudt-normalization.ts` uses a compact local QUDT fixture so the rule-level suite is deterministic and fast. The browser and packaged profile use `rules/qudt/qudt-cdt-normalization.runtime.n3`, the checked-in projection of QUDT 3.4.0. No test or rule execution dereferences the network.

`run-qudt-playground-examples.ts` parses all five RDF Message logs and their SHACL IN/OUT graphs. It checks that the real prepared runtime retains OWL- and SKOS-derived background facts, then executes the examples against the same raw rules and a compact unit projection. Run both with:

The playground test also verifies that SHACL unit constraints reduce the bundled QUDT background to the requested units (or the compatible target dimension when the source is open), omit an unrelated unit, and still execute a complete example through the specialized prepared runtime.

`run-browser-qudt-runtime.ts` bundles the browser engine used by the playground, enforces a 60 KiB ceiling for the logarithmic example, and verifies that all four RDF Messages expose their normalized QUDT quantity objects. This guards against the Node and browser implementations drifting apart.

```bash
npm run test:qudt
```

SHACL IN is passed to `load()` as a trusted input contract for rule selection, input pruning, and join planning. SHACL OUT defines the required normalized predicates and units. The fixture assertions demonstrate its cardinality, quantity-object class, target unit, and numerical requirements; they compare numeric values rather than lexical serialization.

RDF Messages are parsed as separate quad arrays. The normalization suite runs messages independently, checks that invalid messages do not block valid ones, verifies that source blank nodes are not referenced across boundaries, and preserves the message count. OWL `sameAs` and SKOS `exactMatch` composition tests use reverse mappings so normalization is impossible before entailment and succeeds afterward.

Supported categories are linear and affine conversion, dimension checks, logarithmic-to-linear exponentiation, and reversible linear-to-logarithmic exponentiation. Known limitations are generic same-dimension ambiguity, absolute versus difference temperature semantics without an application profile, and contextual or non-algebraic conversions. See `rules/qudt/README.md` for the complete list and the `qcr:normalizationProfile` override.
