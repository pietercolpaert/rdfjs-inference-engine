# QUDT temperature normalization with OWL

Three RDF Messages normalize Celsius, a local Fahrenheit unit, and Kelvin to `unit:K`. The background declares `unit:DEG_F owl:sameAs ex:LocalFahrenheit` in the reverse direction. Without OWL 2 RL, the local Fahrenheit message cannot be resolved; OWL symmetry supplies the alignment and QUDT then performs the affine conversion to 273.15 K.

SHACL IN keeps the quantity-object structure needed by the composed profiles. SHACL OUT requires one QUDT quantity in Kelvin. Open `index.html#example=qudt-temperature-owl` with OWL 2 RL and QUDT enabled.
