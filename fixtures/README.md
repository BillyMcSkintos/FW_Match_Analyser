# Integration fixtures

Each subdirectory is one scenario used by `integration.test.js` to exercise the full
`parseMatch()` → `analytics.js` data path.

```
<scenario>/
  narrative.txt   — narrative input text
  telemetry.txt   — telemetry input text (may be empty for a degraded-alignment case)
  expected.json   — a small set of invariant facts, not a full model dump
```

`expected.json` intentionally holds only a handful of top-level counts (opportunities,
shots, goals, counter-attacks, tactical phases, `validationConfidence`, `warnings`). It
is not a snapshot of the whole parsed match — a snapshot would break on every unrelated
field addition and stop being useful as a *regression* signal. These numbers are meant
to catch the specific class of bug Phase D's integration tests exist for: a parser
change that still passes parser.test.js in isolation but silently changes what analytics
computes from it.

## Provenance

**These are not verbatim scraped FinalWhistle match reports.** Every line here is
adapted from, or copied verbatim out of, this project's own `parser.test.js` fixtures —
which were themselves written against real observed FinalWhistle narrative/telemetry
wording, not invented. Player names (`Player A`, `Player B`, ...) and team names (`Home
Team`, `Away Team`) are placeholders; no real club, player, or account-specific data is
included anywhere in this directory. Where a fixture combines lines from more than one
`parser.test.js` test into a single scenario (e.g. `substitutions-position-change`),
that combination is new, but the individual narrative construct wording (pass/duel/shot
lines, "Issued order-" lines, tiredness/sub lines) is not — it is the same wording
already exercised and asserted on elsewhere in this repo.

`extra-time-offside/` is adapted the same way, from parser.test.js's own offside/
extra-time/preferred-side tests — which are themselves anonymized from a single real
knockout-cup report that went to extra time (the first time this project encountered
any of those three constructs; see CHANGELOG.md).

No FinalWhistle manual text is reproduced in this directory.

## Scenarios

| Directory | Covers |
|---|---|
| `open-play/` | Two straightforward opportunities (one scoring, one cleared), no set pieces or tactical events |
| `counter-attack/` | Opportunity started by one team, counter-attacked and scored by the other — step-level ownership (`attackingSide`) diverges from the opportunity's own `teamSide` |
| `corner/` | `SP_PASS`/`SP_DUEL` set-piece delivery, shot missed |
| `delivered-free-kick/` | `FK_PASS`/`FK_DUEL` delivered free kick (has a pass line, unlike a direct shot) |
| `direct-free-kick/` | `FK_SHOT` only — no pass line at all |
| `save-fumble-rebound/` | A fumbled save followed by a second, separate shot in the same opportunity |
| `same-minute-tactical-events/` | A position change, a substitution and a mentality change all issued in the same minute, immediately followed by an opportunity — narrative-sequence ordering, not minute-only ordering |
| `substitutions-position-change/` | A position change and a substitution as independent tactical events, each producing its own phase boundary |
| `tactical-phase-transition/` | One opportunity before a mentality change, one after — tests `phasePerformance`'s per-phase opportunity attribution |
| `degraded-alignment/` | Narrative opportunity with no matching telemetry at all — `validation.confidence` must read `'degraded'` and propagate into analytics confidence fields |
| `zero-opportunities-team/` | Away Team never creates an opportunity but does appear via a tactical event — tactical phases must still exist for a team with zero opportunities |
| `extra-time-offside/` | An offside trap that succeeds (flag ends the attack, `OFFSIDE` outcome) and one that fails (attack continues normally), a preferred-side order, and the two extra-time break markers landing with no `Opportunity for` line between them and the previous opportunity |
