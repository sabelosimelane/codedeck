# Scoring policies

The scoring engine accepts JSON observations and returns JSON measurements. It runs in ordinary JavaScript without a database, HTTP server, or model client. CodeDeck's adapters supply the run snapshots, timing, and reviewed acceptance criteria.

Use `scoreEnvelope(input, policy)` to score a subject. The envelope carries its format version, the subject type and ID, the configuration ID and revision, the policy version, and the observations. Each metric reports its value, unit, direction, version, eligible and excluded counts, and the observation IDs behind the measurement. An unavailable measurement has a null value.

To add a dimension, create a registry with the existing policy's definitions and a new metric. Give it a unique ID and version. Its `eligible` function selects observations and its `aggregate` function calculates the value. Extend the policy's `prepare` function if the metric needs an additional validated input. Publish the changed registry under a new policy version and use that version for both sides of a comparison.

The [scoring tests](../../server/__tests__/team-scoring-engine.test.js) exercise an additional metric and replay a serialized envelope in a separate Node process. Team delivery and trial rules live in [team.mjs](team.mjs). Workflow comparisons live in [workflow.mjs](workflow.mjs).
