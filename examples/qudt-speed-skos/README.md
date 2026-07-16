# CDT speed normalization with SKOS and QUDT

The messages use concise `cdt:speed` literals with local unit tokens for kilometres per hour, miles per hour, and knots. The ontology connects those tokens to local unit IRIs through `qudt:symbol`. Reverse `skos:exactMatch` assertions then become usable local-to-QUDT mappings only when the SKOS profile runs. QUDT converts each value to metres per second; SKOS itself performs no arithmetic.

SHACL IN admits `cdt:speed` literals containing the three local units through `qcr:UcumUnitIn`. SHACL OUT requires `unit:M-PER-SEC`. Open `index.html#example=qudt-speed-skos` with SKOS and QUDT enabled; disabling SKOS leaves these messages unnormalized.
