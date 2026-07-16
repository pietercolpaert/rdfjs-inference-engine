# Waterinfo Gent-Terneuzen Canal

This playground example shows unit normalization for EC20 conductivity observations from the Gent-Terneuzen canal.

The input is an RDF Message log of SOSA observations. The original values are conductivity readings in microsiemens per centimetre. The example restores that missing unit by encoding each result as a `cdt:ucum` literal, then uses the QUDT/CDT rules to normalize every message independently to Siemens per metre.

## Files

- `input.messages.trig` - five Waterinfo-style RDF Messages with story comments.
- `ontology.n3` - local context for the sensor and EC20 conductivity.
- `shapes-in.n3` - the incoming Waterinfo contract.
- `shapes-out.n3` - the application contract requiring normalized `S/m` output.

## Expected Behavior

Each `sosa:Observation` receives:

- `qcr:normalizedQuantity`, a `qudt:QuantityValue` in `unit:S-PER-M`;
- `qcr:normalizedUcumLiteral`, a compact `cdt:ucum` literal in `S.m-1`.

For example, `3.23327E3 uS.cm-1` normalizes to approximately `0.323327 S.m-1`.

The output preserves the five RDF Message boundaries so downstream stream processors can handle every observation independently.
