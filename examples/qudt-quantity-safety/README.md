# QUDT quantity objects and safety

This example uses QUDT quantity objects rather than CDT literals. Centimetres normalize to metres, an already-normalized metre value remains two metres, and messages containing seconds or no unit produce no misleading length result.

SHACL IN describes the incoming quantity envelope and deliberately permits a missing unit so the safety behavior remains visible. SHACL OUT is strict: one normalized `qudt:QuantityValue` in `unit:M`. Open `index.html#example=qudt-quantity-safety` with QUDT enabled.
