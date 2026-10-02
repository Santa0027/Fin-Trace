# Backup and Restore

Backup strategy:
1. Daily `pg_dump` of `fintrace` schema and critical tables.
2. Encrypted storage in secure bucket with 30-day retention.
3. Pre-migration ad-hoc backup snapshots.

Restore Rehearsal: Must be verified quarterly.
