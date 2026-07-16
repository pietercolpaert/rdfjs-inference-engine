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

## What It Does Not Do

The profile is not a complete dimensional-analysis or unit-algebra engine. It depends on the unit metadata present in the bundled QUDT projection and the normalization profiles encoded in `qudt-cdt-normalization.n3`.

Generic `cdt:ucum` values are resolved by dimension where the profile has a single normalization target. Ambiguous domain choices remain outside this initial profile.

## Precompiled QUDT Runtime

QUDT normalization needs unit metadata from `https://qudt.org/qudt-all`. Loading the full QUDT ontology on every package install, browser load, or runtime compilation would make the package network-dependent and would repeatedly materialize a large graph.

For that reason this folder includes `qudt-cdt-normalization.runtime.n3`, a checked-in generated runtime projection containing the QUDT statements used by this profile. `InferenceEngine` activates this precompiled runtime automatically when the QUDT profile is selected by itself, or when a mixed-profile load-time vocabulary contains QUDT/CDT terms. It stays dormant for unrelated mixed OWL/SKOS loads.

Refresh the bundled projection against the current QUDT release with:

```bash
npm run build:qudt-profile
```

The generated runtime records the source release label and SHA-256 digest. Normal builds and package installs use the checked-in snapshot and do not require network access.

## Third-Party Notice

The generated file `qudt-cdt-normalization.runtime.n3` contains a projection derived from the QUDT Ontologies at <https://qudt.org/qudt-all>.

The QUDT Ontologies are licensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0). Attribution: QUDT.org.

License: <https://creativecommons.org/licenses/by/4.0/>

## Testing

The default rule-loading test checks that the QUDT profile carries its precompiled runtime and that the runtime activates only for standalone QUDT loads or mixed loads with QUDT/CDT vocabulary:

```bash
npm run test:default-rules
```

The browser playground uses the same bundled profile metadata, so selecting QUDT in the advanced profile list includes the precompiled runtime snapshot.
