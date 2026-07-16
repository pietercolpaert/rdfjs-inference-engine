# QUDT speed normalization with SKOS

The messages use local identifiers for kilometres per hour, miles per hour, and knots. Reverse `skos:exactMatch` assertions in the background become usable local-to-QUDT mappings only when the SKOS profile runs. QUDT then converts each value to metres per second; SKOS itself performs no arithmetic.

SHACL IN admits the three local identifiers and preserves the quantity fields. SHACL OUT requires `unit:M-PER-SEC`. Open `index.html#example=qudt-speed-skos` with SKOS and QUDT enabled; disabling SKOS leaves these messages unnormalized.
