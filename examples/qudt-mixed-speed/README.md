# QUDT mixed speed normalization

This playground example normalizes independent RDF Messages containing metres per second, kilometres per hour, miles per hour, and knots to `unit:M-PER-SEC`. The malformed fifth message produces no normalized output and does not affect the four valid messages.

SHACL IN describes the accepted `cdt:speed` field and uses the CDT-specific `qcr:UcumUnitIn` RDF list to declare the four alternative units encoded in its lexical form. SHACL OUT requests one QUDT quantity object in metres per second. Enable the QUDT profile and open `index.html#example=qudt-mixed-speed`; the bundled precompiled QUDT projection supplies unit metadata without dereferencing the network.
