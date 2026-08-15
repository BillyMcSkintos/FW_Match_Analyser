# Visual Match Playback — Discovery and Design

Status: pitch-first MVP implemented on the playback feature branch; generated bitmap
artwork remains a separately reviewable future enhancement.

This document treats `parser.js` and the repository's observed fixtures as the source of
truth. Playback is a presentation adapter over the existing parsed match model. It must
not reinterpret raw narrative, weaken parser validation, or fabricate match detail.

## 1. Parser findings

### Source and normalized model

- `scraper.js` collects raw narrative, telemetry, team names, the five kickoff tactics,
  match statistics, and the match URL.
- `parser.js` merges narrative phases with telemetry phases into
  `match.opportunities[].steps[]`.
- A step is the atomic gameplay unit consumed by analytics and the current pitch view.
  Playback should consume the same steps rather than reparsing narrative text.
- `match.tacticalEvents[]` contains observed administrative/tactical events separately
  from opportunity gameplay.
- `match.validation` records unmatched blocks, phase mismatches, unknown lines, and
  confidence. Playback must surface degraded confidence and must not pretend an
  uncertain opportunity is exact.

### Opportunity and relationship data

Each opportunity supplies minute, narrative sequence, initiating team/side, score before
and after, start type, counter-attack state, ordered steps, final outcome, raw source
lines, tactical phase references, and stream-match confidence. Relationships are the
ordered step sequence, for example:

```text
START_PASS → MID_DUEL → PB_PASS → PB_DUEL → SHOT
```

Other observed shapes include direct long shots, direct and delivered free kicks,
corners, dribbles, counter-attacks, blocked-pass recoveries, and arbitrarily repeated
shots after goalkeeper rebounds. Step-level `attackingSide` and `defendingSide` remain
authoritative after a counter-attack.

### Spatial truth

FinalWhistle does **not** provide event coordinates. The truthful spatial inputs are:

- narrative phase/step zone: midfield, penalty box, corner, free kick, direct shot;
- opportunity `startType` from telemetry (`DEF`, `MID`, `GK`, or `CA` where present);
- player position codes: `GK`, `LB`, `CB`, `RB`, `LWB`, `DM`, `RWB`, `LM`, `CM`,
  `RM`, `LW`, `OM`, `RW`, `FW`;
- team side and attack direction;
- pass height (`low`/`high`), optional observed pass modifier, and shot context.

The existing pitch already maps positions to deterministic rows and left/centre/right
lanes. Playback may reuse those schematic anchors and apply small deterministic variation
inside a bounded zone. It must label the view as schematic and must never present those
anchors as observed coordinates.

### Existing visual/timeline concepts

- A portrait SVG pitch with role/lane anchors, pass arrows, duel nodes, shot routes, goal
  direction, team colours, counter-attack styling, and opportunity highlighting.
- A match timeline with one marker per opportunity and click/hover/pin interaction.
- No event clock inside an opportunity, no play/pause controller, no cue scheduler, and
  no artwork/vignette asset system.
- `stepsToChain()` currently summarizes an opportunity for a static highlight. Playback
  needs the full ordered `steps[]`, especially for multiple passes and rebound shots.

## 2. Event inventory

### Gameplay steps

| Event | Available data | Relationships | Suggested visual treatment |
|---|---|---|---|
| `START_PASS` | passer/receiver identity, positions, teams/sides, pass height/type/request, pass quality | begins or resumes midfield progression; followed by `MID_DUEL` | draw schematic arrow between bounded role/zone anchors; animate ball dot along it |
| `MID_DUEL` | attacker/defender, positions, reception/assistance/tackle quality, outcome, foul/card/recovery | resolves preceding start pass; may end, restart, reach PB, dribble, or counter | reception node then compact duel pulse; illustrated tackle vignette only in a later asset tier |
| `PB_PASS` | same pass data as `START_PASS` | enters/continues penalty-box phase; followed by `PB_DUEL` | arrow into the box; high-pass arc when observed |
| `PB_DUEL` | same duel data as `MID_DUEL` | may resolve to shot, foul/penalty, corner, clearance, interception, or possession | box-zone highlight plus split attacker/defender node; optional tackle/foul vignette |
| `SP_PASS` | corner taker/receiver, pass height/type, pass quality | corner restart followed by `SP_DUEL` | corner quadrant pulse and curved delivery arrow; no full artwork required |
| `SP_DUEL` | attacker/defender and duel values/outcome | contest after corner; may lead to shot | box duel node; optional tackle/header asset only when explicitly supported |
| `FK_PASS` | free-kick taker/receiver and pass data | delivered free kick followed by `FK_DUEL` | restart marker and delivery arrow |
| `FK_DUEL` | attacker/defender and duel values/outcome | contest after delivered free kick; may lead to shot | box/midfield duel node according to established step geometry |
| `DRIB` | dribbler, defender, reception/dribble/tackle values, outcome | standalone phase between progression phases | short path, player node translation, defender pressure ring; no invented run route |
| `SHOT` | shooter/GK identities and positions, shot type, weak-angle flag, one-on-one, long-shot/penalty flags, shot/GK values, outcome, miss type, GK context, recovery and recovery resolution | follows a duel/direct long shot or another rebound shot | strike vignette plus deterministic goal trajectory; outcome-specific resolution vignette |
| `FK_SHOT` | shooter/GK, direct-FK/long-shot/shot type, shot/GK values, outcome, miss type, recovery | direct free kick with no delivery/duel | direct-free-kick strike vignette and outcome resolution |

### Normalized outcomes and contextual actions

| Event/outcome | Available data | Relationships | Suggested visual treatment |
|---|---|---|---|
| `POSSESSION` / `WON` | winning attacker and duel context | progression continues | node confirmation pulse; retain completed route |
| `CLEARED` | defender when named; duel/phase context | ends current attack unless a later observed phase exists | clearance arrow toward pitch edge; fade opportunity |
| `BLOCKED` | blocked pass and optional recovery | may create another same-type pass/duel phase | impact flash on pass, loose-ball dot, recovery node |
| `SHOT_BLOCKED` | shooter, GK if named, recovery if observed | terminal shot outcome with possible loose-ball aftermath | strike plus defender silhouette/impact vignette; no inferred blocker identity if absent |
| `GK_INTERCEPT` | goalkeeper identity/position and phase | terminates a delivery before a shot | keeper collection/interception vignette |
| `FOUL` | fouler, attacking/defending side, phase, possible later card/penalty/free kick | terminates phase or creates restart | whistle/impact vignette; do not invent foul victim or foul type |
| `CORNER` | phase, defender/GK when named | ends one phase and may precede `SP_PASS` opportunity content | ball-to-corner arc, corner flag pulse; restart remains pitch flow |
| `OFFSIDE` | phase and involved pass participants; no named official | terminates attack | dashed line/wipe and flag vignette; no exact defensive line coordinates |
| `GOAL` | shooter, GK if parsed, shot context and values | shot resolution; score change available at opportunity level | goal/net-impact vignette, brief score pulse |
| `SAVED` | shooter, GK, shot/GK values and context | controlled terminal save | keeper collection/save vignette; no dive direction |
| `FUMBLED` | shooter, GK, values, loose-ball recovery and optional clearance | may lead to arbitrary additional `SHOT` steps | rebound vignette, loose-ball animation, then continue ordered cues |
| `POST` | shooter, GK where available, values | terminal woodwork outcome | post-impact vignette and rebound away; parser does not distinguish post vs bar semantically |
| `MISSED` | shooter, GK where parsed, values, `wide`/`narrow` descriptor | terminal shot outcome | trajectory outside frame; use wide/narrow as prose/category, not left/right distance |
| yellow card | named carded player, team/side through step, phase | follows foul/duel | card overlay/vignette after foul |
| recovery | named player/team/side; after blocked pass or fumbled shot | resumes attack or confirms defender possession | loose-ball dot travels only to player's bounded zone anchor |
| recovery clearance | recovering defender plus `looseBallResolution: CLEARED` | resolves fumbled shot without another shot | recovery node, then clearance arrow; never create phantom shot |

### Tactical and match events

| Event | Available data | Relationships | Suggested visual treatment |
|---|---|---|---|
| `SUBSTITUTION` | team/side, player out/in and positions, minute/sequence | changes tactical state | timeline badge and compact lower-third; not an action vignette |
| `POSITION_CHANGE` | player, old position, new position, team/side | changes tactical phase | timeline badge; schematic role node shifts between anchors |
| `MENTALITY_CHANGE` | team/side and new mentality | tactical phase boundary | timeline/tactics badge only |
| `STYLE_CHANGE` | team/side and Style of Play value | tactical phase boundary | timeline/tactics badge only |
| `PREFERRED_SIDE_CHANGE` | team/side and value | tactical phase boundary | timeline/tactics badge and optional lane glow; no inferred player movement |
| `ISOLATE` | issuing team when resolvable, target player/position; zone unknown | tactical phase boundary | timeline/tactics badge; do not highlight a zone |
| `TIREDNESS` | player, position, team, tired/very tired | contextual status; not a phase boundary | small player-status badge |
| `INJURY` | player, position, light/severe/unknown; side may be unresolved | contextual status | injury vignette only when side/player attribution is resolved; otherwise neutral timeline notice |
| `HALF_TIME` | minute/sequence | match break; clears reported tiredness state | full-width break card |
| `EXTRA_TIME_BREAK` | minute/sequence and start/halfway period | match break | full-width extra-time break card |

### Raw telemetry vocabulary

The stream parser recognizes opportunity headers `O_*`, numeric values `V_PASS`,
`V_ASSISTANCE`, `V_RECEPTION`, `V_TACKLING`, `V_SHOT`, `V_REFLEX`, terminal/context
events `E_CORNER`, `E_FREE_KICK`, `E_GOAL`, `E_BLOCK`, `E_INTERCEPTION`, `E_FUMBLE`,
`E_OFFSIDE`, `E_CARD`, `E_PENALTY_KICK`, `E_INJURY`, `E_TRAP_SUCCESS`,
`E_TRAP_FAILURE`, `E_COUNTER_ATTACK`, and ignores `C_*` gameplay-wise as coaching
metadata. Playback should consume normalized steps/events, not these raw tokens.

## 3. Recommended events worth illustrating

### Initial asset set

1. Shot strike (normal; reused before all ordinary shot outcomes).
2. Long-shot strike.
3. Penalty/direct-free-kick strike (shared composition with restart variants).
4. Goal/net impact.
5. Controlled goalkeeper save.
6. Goalkeeper fumble/rebound.
7. Woodwork impact.
8. Miss.
9. Shot block.
10. Goalkeeper interception.
11. Foul.
12. Yellow card.
13. Offside.
14. Injury.

### Later, only if the value is proven in real fixtures

- Tackle won/lost can be illustrated from duel outcome, but its small-screen benefit
  should be validated after the pitch-first MVP.
- A header-specific strike should be added only after an observed fixture proves the
  parser's `shotType` contains that distinction. The current observed asset requirement
  is a `lob` shot; a generic one-word parser capture is not evidence every possible word
  occurs.
- No cross asset until the parser exposes an observed, semantic cross distinction.
- No red-card asset: the current parser only recognizes yellow cards.
- No left/right save variants: no save direction is provided.

## 4. Pitch/flow events without illustrations

Opportunity begin/end, passes, receptions, zone progression, high/low delivery,
possession confirmation, blocked-pass recovery, dribbles, counter-attack boundaries,
corners and delivered free-kick restarts should remain SVG pitch cues. They are clearer
as an accumulating route than as repeated cutaway art.

Reception is not a separate normalized step; it is a value on a duel step. Playback may
stage a reception pulse immediately before the duel pulse, but both must reference the
same `MID_DUEL`/`PB_DUEL`/`SP_DUEL`/`FK_DUEL` step.

## 5. Visual style specification

### Direction

Classic UK/European football-management-game highlight illustration, influenced by
late-1990s/early-2000s editorial sports graphics and match-program artwork. It should be
dramatic and graphic, but not manga/anime, photorealistic broadcast footage, or a
miniature 3D simulation.

### Fixed style rules

- 16:9 vignette composition at 1280×720 master resolution; safe central action area for
  display around 480×270 CSS pixels.
- Consistent three-quarter touchline camera, slightly below shoulder height, attacking
  direction left-to-right inside the vignette.
- Athletic but believable adult proportions; strong silhouettes and readable limbs.
- Ink-like dark navy contour, controlled line weight, semi-flat gouache/screen-print
  shading, limited texture, two shadow steps, one highlight step.
- Night-match atmosphere with cool floodlight rim, dark desaturated crowd/pitch shapes,
  and a restrained warm impact highlight.
- Generic unbranded kits. Home is cool cyan/navy; away is warm orange/charcoal. Generate
  paired palette variants by editing the approved key image rather than independently
  redrawing the composition.
- Consistent white goal frame, subdued green pitch, navy vignette border treatment, and
  no embedded words, numbers, logos, badges, sponsors, real players, or real clubs.
- Ball remains high-contrast and slightly exaggerated for small-size readability.
- Keep backgrounds simple; motion and event silhouette take priority over faces/detail.
- Transparent foreground/action layers where practical, with background and effect
  overlays separated for CSS/SVG animation.

### Accessibility and motion

- Never communicate outcome through colour alone.
- Provide a persistent text caption outside the artwork from parsed data.
- Respect `prefers-reduced-motion`: replace pan/shake/parallax with a 150 ms crossfade
  and show the final pitch state immediately.
- Provide pause, replay, previous/next cue, and 0.5×/1×/1.5×/2× speed controls.

## 6. Master image-generation prompt

```text
Create one frame from a coherent illustrated football match highlight system for a
browser-based football management game. Classic UK/European football-management and
editorial sports-graphic influence, late-1990s/early-2000s match-program energy; not
manga, not anime, not photorealistic, not 3D game footage. Consistent three-quarter
touchline camera slightly below shoulder height, action reads left-to-right. Believable
adult footballer proportions, strong silhouettes, clear limb positions, dark navy
ink-like contours with controlled line weight, semi-flat gouache/screen-print shading,
two shadow steps and one cool floodlight rim highlight. Subdued dark stadium and green
pitch, simple white goal frame where required, limited clutter, high-contrast ball,
restrained warm impact accent. Generic unbranded kits only: [ATTACKING_KIT];
[DEFENDING_KIT]. No real players, no real clubs, no badges, no sponsors, no jersey text,
no embedded words, no scoreboard, no watermark. 16:9 composition, 1280×720, central
safe action area remains legible at 480×270. Preserve the approved reference image's
camera, proportions, line weight, palette, lighting, pitch, goal, rendering, and framing.
Event-specific action: [EVENT_ACTION]. Layering request: [LAYERING].
```

The first approved key image should be the standard-shot frame because it establishes
player scale, ball readability, pitch, goal, goalkeeper, both kits, and the most reused
camera. Every later image should use it as a style/reference image. Palette-swapped and
action variants should use image editing/reference controls, not isolated fresh prompts.

## 7. Asset manifest

The detailed manifest is in [`visual-match-playback-assets.json`](visual-match-playback-assets.json).
Its runtime implementation should be a local JavaScript constant rather than fetched
JSON, because this extension deliberately forbids runtime network/fetch sinks. The JSON
is the reviewable design source; implementation tests must enforce parity with the
runtime constant.

Manifest triggers are defined only in terms of existing normalized step/event fields.
Variants never depend on unsupported coordinates, shot direction, keeper dive direction,
foul type, or player appearance.

## 8. Individual generation prompts

Each manifest entry supplies an `eventPrompt` intended to replace `[EVENT_ACTION]` in
the master prompt. Common kit variables are:

- Home attack: `attacker in cool cyan shirt and navy shorts; defenders/keeper in warm
  orange and charcoal`.
- Away attack: `attacker in warm orange shirt and charcoal shorts; defenders/keeper in
  cool cyan and navy`.

Generate the standard-shot key image first. For every subsequent event, pass the approved
key image as the primary style reference and the nearest preceding action as a composition
reference. Use editing/inpainting for kit swaps and outcome changes so the same fictional
match world, player proportions, pitch, goal, and lighting persist.

## 9. Animation techniques

| Asset/cue | Technique | Duration | Entry/exit |
|---|---|---:|---|
| opportunity begin | pitch-zone glow, route layer reset | 300 ms | fade in / persist |
| pass | SVG path draw + ball dot motion; high pass uses a curved arc | 550 ms | draw / persist |
| reception/duel | node scale pulse, split ring, small impact flash | 450 ms | scale / persist |
| dribble | bounded node translation and short trail | 500 ms | fade / persist |
| restart/corner | fixed restart marker + curved delivery | 600 ms | wipe / persist |
| standard/long/restart shot | illustrated frame crop reveal, 2% push-in, SVG ball trajectory | 750–900 ms | directional wipe / cut to outcome |
| goal | net overlay displacement, warm flash, restrained 2 px shake | 1100 ms | flash / dissolve |
| controlled save | two consistent frames (`ready` → `collect`) plus ball easing | 950 ms | cut / fade |
| fumble | `contact` frame, ball rebound path, recovery cue continues on pitch | 900 ms | impact flash / return to pitch |
| post | ball-to-frame SVG path, metal flash, short shake | 850 ms | cut / fade |
| miss | trajectory exits goal frame; no left/right choice | 750 ms | wipe / fade |
| shot block | defender reveal, ball deflection, impact burst | 800 ms | cut / return to pitch |
| GK interception | keeper step/collect frames, delivery path ends at hands | 850 ms | crop reveal / fade |
| foul | tackle/contact still, whistle-ring SVG, desaturate finish | 700 ms | cut / fade |
| yellow card | official-hand/card silhouette layer lifts; parsed caption outside art | 650 ms | slide / fade |
| offside | dashed schematic line across pitch, flag vignette, route desaturates | 700 ms | wipe / fade |
| injury | kneeling/player-down still with subdued vignette; no medical diagnosis | 900 ms | slow fade / fade |
| opportunity end | completed route holds | 650 ms | hold / route fades |

Use CSS transforms/opacity and SVG `stroke-dashoffset`; avoid canvas simulation and
continuous per-player physics. `requestAnimationFrame` should only drive the controller's
clock when CSS/SVG animation cannot express a cue.

## 10. Proposed file/folder structure

```text
docs/
  visual-match-playback-design.md
  visual-match-playback-assets.json

playback-model.js          # pure match model → ordered cue model
playback-controller.js     # play/pause/seek/speed state machine; no parser logic
playback-view.js           # SVG pitch cue rendering + illustrated overlay lifecycle
playback.test.js           # cue mapping, truthfulness, repeated-shot and timing tests
playback-view.test.js      # safe DOM/SVG output, controls, reduced-motion tests

assets/playback/
  style-reference/
    key-standard-shot.webp
  backgrounds/
    stadium-base.webp
  shot/
    standard-contact.webp
    long-contact.webp
    restart-contact.webp
  outcomes/
    goal-net.webp
    save-ready.webp
    save-collect.webp
    fumble-contact.webp
    post-impact.webp
    miss.webp
    blocked.webp
    gk-intercept.webp
  incidents/
    foul.webp
    yellow-card.webp
    offside.webp
    injury.webp
  masks/
    ...optional alpha masks for kit/effect recolouring...
```

Use local WebP for opaque/transparent art where quality is sufficient; use PNG only for
alpha edges WebP cannot preserve acceptably. Prefer SVG/CSS for ball paths, net motion,
flashes, lines, masks, and UI controls. Do not add external fonts, video, CDN assets, or
runtime downloads.

## 11. Integration plan

### Cue model (no parser redesign)

Add a pure `buildPlaybackCues(match, options)` adapter. It reads the current model and
returns immutable cues such as:

```js
{
  id: 'opp-12-step-4-resolve',
  kind: 'shot.resolve',
  opportunityIndex: 12,
  stepIndex: 4,
  minute: 63,
  attackingSide: 'away',
  defendingSide: 'home',
  zone: { from: 'PB', to: 'GOAL', precision: 'schematic' },
  players: { actor: step.shooter, goalkeeper: step.gk },
  outcome: 'FUMBLED',
  asset: 'fumble',
  durationMs: 900,
  sourceConfidence: opportunity.streamMatchConfidence
}
```

One `SHOT` step may create a strike cue, an outcome cue, and—only when observed—a
recovery cue. Rebound chains remain ordered because every parsed shot is already a
separate step. Cue expansion never mutates or replaces the step.

### Deterministic schematic anchors

Extract the current position/lane geometry into a small shared playback geometry object,
or duplicate it only after a parity test proves both renderers agree. Preferred approach:
one shared pure geometry file consumed by static pitch and playback.

Use a stable hash of `opportunity.sequence + stepIndex + role` to choose an offset inside
an allowed zone cell. The same match always replays identically. Variation must remain
bounded and carry `precision: 'schematic'` in the cue/debug model.

### UI

- Add a Playback mode beside the existing opportunity/pitch controls, not a replacement
  for Opportunities.
- Controls: play/pause, restart, previous/next cue, speed, opportunity-only/full-match,
  and close playback.
- During playback, progressively accumulate route layers on the existing SVG pitch.
- Show an illustrated overlay only for mapped significant cues; captions are generated
  from parsed fields outside the artwork.
- Clicking an existing opportunity/timeline marker seeks to that opportunity. Existing
  hover/pin behavior remains unchanged outside Playback mode.
- Degraded/uncertain opportunities show a visible confidence indicator; playback still
  uses known narrative steps but does not hide parser warnings.

### Tests and delivery stages

1. **PR 1 — design/model contract:** this document, manifest, cue schema, pure adapter,
   and exhaustive mapping tests; no artwork.
2. **PR 2 — pitch playback MVP:** controller, controls, progressive SVG flow, seeking,
   reduced motion, and old-scrape compatibility; still no generated art dependency.
3. **PR 3 — illustrated highlights:** approved reference image, local optimized assets,
   overlay renderer, and asset/source-condition tests.
4. **PR 4 — polish:** responsive layout, performance profiling, manual Chrome/Firefox
   verification, export/storage/package-size review, and documentation.

Every PR must run `npm run verify`. Add smoke coverage for classic-script load order,
static-audit coverage preventing external asset/network sinks, XSS tests for captions,
fixture tests for counter-attacks and repeated shots, and manual reduced-motion/browser
checks before merge.

## Explicitly unsupported or ambiguous

- No exact event coordinates, distance, trajectory, running route, speed, or event-second
  timing inside a minute.
- No complete 22-player positions or continuous player movement.
- No left/right shot placement or goalkeeper dive direction.
- No semantic cross event.
- No red-card parser event.
- No named tackler/blocker for every blocked shot; use only identities present on step.
- No reliable header variant until observed fixture evidence exists.
- `POST` combines post and crossbar in the normalized model.
- `good angle` is recognized raw wording but is not stored as positive `shotAngle`; only
  the weak-angle flag is currently explicit.
- `MISSED` descriptors `wide`/`narrow` are qualitative source wording, not distances.
- No inferred kits, formation, preferred side, or tactics from flow. Artwork colours are
  generic UI representation, never claims about real club kits.
- No simulated actions inserted merely to make transitions look natural. A cue may hold,
  fade, or cut when the source does not describe the intervening action.
