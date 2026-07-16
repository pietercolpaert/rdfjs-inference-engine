# QUDT logarithmic measurements

Separate message properties preserve the meanings of decibel power ratios, octave frequency ratios, and pH hydrogen-ion activity. Expected linear values are `20 dB -> 100`, `10 dB -> 10`, `3 oct -> 8`, and `pH 7 -> 1e-7`.

The decibel rule deliberately uses the documented power-ratio convention, `10^(dB/10)`. SHACL OUT uses separate shapes even though all three results are represented as unitless QUDT quantity values. Each result also includes the equivalent normalized `cdt:ucum` literal with the canonical unit token `1`, such as `"100 1"^^cdt:ucum`. Open `index.html#example=qudt-logarithmic` with QUDT enabled.
