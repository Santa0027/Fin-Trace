# Legacy Migration Plan

Source tables: `public.*`
Target tables: `fintrace.*`

Steps:
1. Pre-migration backup of `public` schema.
2. Data mapping and validation logic execution.
3. Transactional copy and tenant mapping.
4. Rollback via restoring snapshot if issues arise.
