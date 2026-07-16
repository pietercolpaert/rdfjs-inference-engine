# QUDT/CDT normalization rule profile

This folder contains `qudt-cdt-normalization.n3`, a profile for normalizing QUDT quantity values and Linked Data Type (`cdt:`) quantity literals.

## What It Does

The profile derives normalized quantity values using canonical target units. It supports:

- QUDT `qudt:QuantityValue` nodes with `qudt:numericValue` and `qudt:unit`;
- `cdt:` quantity literals such as typed UCUM strings;
- unit lookup from QUDT symbols, UCUM codes, and expressions;
- conversion multipliers and offsets;
- selected logarithmic units with explicit profile metadata.

The normalized result uses the `https://w3id.org/qudt-inference#` vocabulary and QUDT units.

For QUDT object inputs, applications may map a source property to a quantity profile:

```turtle
ex:length qcr:normalizationProfile qcr:LengthProfile .
```

This contract takes precedence over dimension-only profile selection. It prevents a time-valued object on a length property from receiving a misleading result and lets applications distinguish quantity kinds that share a dimension vector.

### CDT unit alternatives

This profile defines `qcr:UcumUnitIn` for SHACL property shapes whose value nodes are CDT literals:

```turtle
qcr:UcumUnitIn a rdf:Property ;
  rdfs:comment "Allowed QUDT units encoded by a CDT literal, interpreted disjunctively." .
```

Its value is one RDF list. Every list member is a QUDT unit IRI, and membership is interpreted as an alternative: the unit encoded in the CDT lexical form is expected to be any one member of the list.

```turtle
sh:property [
  sh:path ex:speed ;
  sh:datatype cdt:speed ;
  qcr:UcumUnitIn (
    unit:M-PER-SEC
    unit:KiloM-PER-HR
    unit:MI-PER-HR
    unit:KN
  )
] .
```

When exactly one unit is possible, use the SHACL 1.2 annotation directly, for example `sh:unit unit:DeciB`. Do not use an RDF list as the value of `sh:unit`.

`qcr:UcumUnitIn` is a trusted planning extension, not a SHACL Core validation component. The engine uses it to retain the alternative source units in the prepared QUDT projection. Applications that accept untrusted data must separately validate that the unit token encoded in each CDT literal belongs to the declared list.

## What It Does Not Do

The profile is not a complete dimensional-analysis or unit-algebra engine. It depends on the unit metadata present in the bundled QUDT projection and the normalization profiles encoded in `qudt-cdt-normalization.n3`.

Generic `cdt:ucum` values are resolved by dimension where the profile has a single normalization target. Ambiguous domain choices remain outside this initial profile.

## Precompiled QUDT Runtime

QUDT normalization needs unit metadata from `https://qudt.org/qudt-all`. Loading the full QUDT ontology on every package install, browser load, or runtime compilation would make the package network-dependent and would repeatedly materialize a large graph.

For that reason this folder includes `qudt-cdt-normalization.runtime.n3`, a checked-in generated runtime projection containing the QUDT statements used by this profile. `InferenceEngine` activates this precompiled runtime automatically when the QUDT profile is selected by itself, or when a mixed-profile load-time vocabulary contains QUDT/CDT terms. It stays dormant for unrelated mixed OWL/SKOS loads.

When SHACL IN and SHACL OUT provide unit constraints, the engine specializes this projection before attaching it. It reads scalar `sh:unit` annotations, CDT alternatives from `qcr:UcumUnitIn`, and `sh:hasValue`/`sh:in` constraints on `qudt:unit`. Exact input constraints retain only the named source and target units. If SHACL IN intentionally leaves the source unit open, all units sharing a QUDT dimension vector with the requested output unit are retained. Local unit identifiers are resolved through load-time OWL `owl:sameAs`, SKOS `skos:exactMatch`, or `qcr:alignedQudtUnit` facts before specialization.

The executable normalization kernel and its canonical datatype profiles remain in the generated runtime. The large QUDT fact projection is the specialized part; omitting individual kernel declarations based only on predicates would be unsound because CDT literals encode their source unit in the lexical form rather than as an RDF object.

Generated runtimes store SHACL planning metadata in a compact form and reconstruct derived indexes and join hints when reopened. For composed QUDT loads, the embedded static closure is limited to facts involving the supplied background vocabulary; this retains local OWL/SKOS unit alignments without copying unrelated rule-profile declarations into every runtime.

Refresh the bundled projection against the current QUDT release with:

```bash
npm run build:qudt-profile
```

The generated runtime records the source release label and SHA-256 digest. Normal builds and package installs use the checked-in snapshot and do not require network access.

The profile does not use `log:semantics`; neither rule execution nor the playground dereferences QUDT over the network.

## Third-Party Notice

The generated file `qudt-cdt-normalization.runtime.n3` contains a projection derived from the QUDT Ontologies at <https://qudt.org/qudt-all>.

The QUDT Ontologies are licensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0). Attribution: QUDT.org.

License: <https://creativecommons.org/licenses/by/4.0/>

## Testing

The fixture suite covers linear and affine length, mass, time, speed, area, volume, pressure, energy, power, and temperature conversion; current and legacy CDT literals; QUDT objects; symbols and UCUM codes; malformed lexical forms; dimension mismatches; and logarithmic conversion in both directions for bel, decibel, neper, octave, decade, and pH. Floating-point values are compared numerically with tolerances.

It also processes multi-message RDF Message logs and verifies independent valid/invalid results, source blank-node isolation, and message boundaries. OWL and SKOS tests prove that reverse local-unit mappings fail without the corresponding entailment profile and succeed after composition.

Run the QUDT suite, including all five playground fixtures, with:

```bash
npm run test:qudt
```

The default rule-loading test checks that the QUDT profile carries its precompiled runtime and that the runtime activates only for standalone QUDT loads or mixed loads with QUDT/CDT vocabulary:

```bash
npm run test:default-rules
```

The browser playground uses the same bundled profile metadata, so selecting QUDT in the advanced profile list includes the precompiled runtime snapshot.

## Playground Examples

- [Mixed speed normalization](../../examples/qudt-mixed-speed/README.md)
- [Temperature normalization with OWL](../../examples/qudt-temperature-owl/README.md)
- [SKOS-assisted speed units](../../examples/qudt-speed-skos/README.md)
- [Logarithmic measurements](../../examples/qudt-logarithmic/README.md)
- [Quantity objects and dimensional safety](../../examples/qudt-quantity-safety/README.md)

Build the browser and open `index.html#example=<example-id>`. SHACL IN is a trusted planning contract that retains relevant incoming paths and helps prune rules. SHACL OUT projects the required normalized paths; the tests then check its cardinality, unit, class, and numeric expectations semantically.

## Known Limitations

- Generic `cdt:ucum` and unannotated quantity objects select profiles by dimension. Use `qcr:normalizationProfile` when quantity kinds share a dimension, such as energy and torque.
- Absolute temperature and temperature differences need distinct application profiles; the bundled temperature profile models absolute conversion to kelvin.
- Reciprocal, calendar-aware, currency, lookup-table, and contextual conversions are not implemented.
- Generic decibels use the documented power-ratio convention. Field/amplitude ratios require a more specific application profile.
