# CDT temperature normalization with OWL and QUDT

Three RDF Messages use concise `cdt:temperature` literals for Celsius, a local Fahrenheit token, and Kelvin, and normalize them to `unit:K`. The local token resolves to `ex:LocalFahrenheit` through `qudt:symbol`. The background declares `unit:DEG_F owl:sameAs ex:LocalFahrenheit` in the reverse direction. Without OWL 2 RL, the local Fahrenheit message cannot be resolved; OWL symmetry supplies the alignment and QUDT then performs the affine conversion to 273.15 K.

SHACL IN accepts `cdt:temperature` literals in the three declared units through `qcr:UcumUnitIn`. SHACL OUT requires one normalized QUDT quantity in Kelvin. Open `index.html#example=qudt-temperature-owl` with OWL 2 RL and QUDT enabled.
