# TeqRallly

TeqRallly is a browser-based 3D teqball game built with Babylon.js, TypeScript,
and Vite. Play solo against the CPU, learn in Practice, compete in a cup or
league, or take someone on online.

## Run locally

```bash
npm install
npm run dev                 # open the printed URL
npm run dev -- --host      # make the dev build reachable from a phone
npm run build              # production files in dist/
```

The game supports keyboard, touch, and Gamepad API controllers, and plays
either way up on a phone.

| Action | Keyboard | Gamepad | Touch (landscape) | Touch (portrait) |
| --- | --- | --- | --- | --- |
| Move | WASD or arrows | Left stick | Move stick | Tap where to stand |
| Play a set-up | WASD or arrows | Left stick | Move stick | Tap where to put the ball |
| Aim a kick | Hold Space, then WASD | Hold A, then stick | Hold STRIKE, then stick | Direction of the swipe |
| Kick | Release Space | Release A | Release STRIKE | Swipe |
| Serve | Space or Enter | A / Cross | STRIKE | Swipe |
| Take a touch | K | B / Circle | RECEPTION | Tap, with the ball already near |
| Pause | Escape | Start / Options | Pause button | Pause button |

Portrait has no room for a stick and two buttons, so the whole screen becomes
the controller instead — a tap and a swipe, and nothing else. A resting finger
deliberately does nothing: on a surface where every pixel is a control, an
ambiguous gesture is safest doing nothing at all. Both layouts feed the same
input state, and turning the phone switches between them mid-rally.

One rule decides what a tap means: **a tap where the ball is is a touch, a tap
where the ball is not is a shift.** With the ball still on its way there is
time to go somewhere, so the tap sends the player there. With the ball already
in the vicinity there is no time to go anywhere, so the same tap plays it — and
plays it *to the tapped spot*, which is what makes a set-up placed deep as
available as one placed wide (`POP_CARRY` in `src/match.ts` is how far a touch
can carry).

The first touch of a possession is automatic. Standing in the vicinity of an
incoming ball is enough to receive it — no press, no timing; a tap only steers
where it goes. Every touch after that has to be asked for, and in portrait the
tap is the asking. Chasing a ball down to make contact at all was never the
interesting decision; what to do with it is (`AUTO_RECEPTION_REACH` in
`src/match.ts`, `autoFirstReception` to switch the first touch back to manual).

A set-up never lands on the player's own half: playing the ball onto your own
table is a fault, and a placement the player asked for must not be the thing
that loses them the point.

## Kicks, and missing with them

A kick aims at a point anywhere on the court and is struck at a power the
player chooses. Landscape holds the kick control: the stick moves the aim
marker while the charge builds, and letting go strikes. Portrait swipes: the
direction aims it and the *speed* of the swipe is the power, so a flick is a
low fast drive and a slow drag is a floater. The animation follows the power,
because a lob played with a drilled foot volley reads as a bug.

Every aim, and every landing it scatters to, is clamped to `PLAY_BOX` — the
table plus a hand's width of margin. A kick has to be able to miss; it does not
have to be able to reach the crowd, and a ball that leaves the picture is a
worse punishment than the point it already cost. Kept that narrow, every miss
reads as one that nearly went in, which is the only kind worth watching.

Where the ball actually lands is that aim plus a spread (`src/aim.ts`):

```
radius ∝ power × weak-foot wobble × how far the striker had to reach
         ÷ the striker's precision
```

Nothing clamps the result back onto the table. That is the point — pace has to
cost accuracy or there is no reason ever to play a soft kick, and a player who
aims at the line and hits flat out should sometimes watch it go long. Precision
is the counterweight and the trait a player will later be able to improve; it
divides the spread, so an improved striker can hit hard and still keep it in.
`SAFE_POWER` in `src/match.ts` is where the power bar's marked band ends — past
it the ball goes harder and lands less reliably.

**Where you stand decides what you can hit.** The flat, hard shots — foot
volleys and backflips — need the middle line. From behind it a kick's loft has
a floor under it that grows with the distance, so a full-speed swipe from the
back of the court gets its pace as a lob rather than as a missile. There is no
angle through which a driven ball from deep clears the net and still lands, and
letting one exist made position irrelevant. Attacking therefore means coming
forward, and coming forward costs the time it takes to get back.

The floor ramps from exactly where the flattest kick already is (`loftFloor`
starts at `loftFor(1)`), so crossing the line costs nothing and the cost grows
smoothly from there — a player can feel where it is without being told.

## Practice

Not a match with the scoring switched off. There is no score, no set, no serve
rotation and no result screen, because every one of those turns "am I learning
this" into "am I winning", and a player who is losing a tutorial stops
listening to it. The stands are empty and the automatic first reception is off:
a lesson taught with the assistance on teaches a game they never play again.

Two chapters, in the order they matter. **Defending** is reading where the ball
is going and being there before it is. **Attacking** is the three things that
actually win a point here — step in to the middle line, hit it hard, take it
early. The opponent is the coach: everything said is said by the player on the
other side of the table.

The world freezes while the coach talks, which is what lets each lesson be one
sentence instead of a paragraph racing a live ball.

**The first launch goes straight into it and cannot be skipped.** Teqball is a
sport most people have never played, with controls nobody can guess, and a
title screen offering four modes to somebody who has not seen a rally is a
title screen they close. It is remembered the moment the last step is done —
not when they leave the screen — so closing the app mid-knockabout does not
make them sit through it again. Afterwards it is an ordinary menu item.

That has one consequence worth knowing about: a fresh browser profile *is* a
first launch, so every harness in `scripts/` seeds the preference through
`scripts/returning-player.mjs` before the page boots. That is not a test mode;
it is the second launch.

## Checks

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint (type-aware)
npm test             # Vitest unit tests
npm run check        # all three
```

The unit tests in `tests/` cover the pure gameplay maths — ball physics and
trajectory solving, clip timing, character traits, and the AI presets. They run
in Node in under a second and need no browser. `tests/config.test.ts` also
parses `Animation.txt` and fails if the frame numbers in `src/config.ts` drift
away from it.

GitHub Actions runs all four steps (typecheck, lint, test, build) on every push
to `main` and every pull request.

## Browser test helpers

Anything that needs a real scene — asset loading, rendering, the match loop —
is driven through headless Chromium instead. Start a server on port 5199, then
run:

```bash
npm run dev -- --port 5199
node scripts/simulate.mjs 60      # headless match, logs state each second
node scripts/screenshot.mjs       # screenshots of the menus and a match
node scripts/verify-practice.mjs  # the first-launch lesson, unasked and unskippable
```

To smoke-test a production build end to end (this is the check that catches a
broken asset pipeline — the wrong loader import still typechecks and builds):

```bash
npm run build
npm run preview -- --port 5199 --strictPort
node scripts/verify-build.mjs
node scripts/verify-portrait.mjs        # the phone-upright control scheme
node scripts/verify-purchase-gate.mjs   # the locked venue, and the restore path
```

The account flow needs a server as well as a page, because what it checks is
the two of them reaching each other — a cross-origin reply the page is not
allowed to read looks fine from either side alone:

```bash
npm run relay                      # port 8787
node scripts/verify-accounts.mjs   # sign up, recover onto another device
```

It signs up from a real browser, reads the leaderboard, then opens a second
page with empty storage — the closest a script gets to a new phone — restores
the account onto it with the recovery code, and checks the first page is signed
out afterwards.

`?ts=8` speeds up simulation time. `?q=medium|high` forces a graphics tier for
the session, overriding both the remembered choice and auto-detection. `?q=low`
and `?light=1` still parse, and now resolve to `medium`.

## Phone layout

`scripts/ui-shots.mjs` captures every screen at the dimensions of the devices
this is played on and reports layout defects, which is how the landscape menus
were found to be unusable — the back button sat above the viewport and the last
two options below it.

```bash
npm run build && npm run preview -- --port 5199 --strictPort
node scripts/ui-shots.mjs     # screenshots in /tmp/ui, problems on stdout
```

It checks five things a screenshot alone will not tell you: controls outside
the viewport, tap targets under 44px, controls covered by something drawn over
them, panels overlapping each other, and text clipped mid-line. The last two
matter because a `pointer-events: none` overlay passes a hit test while still
visually burying the control underneath.

Landscape phones are the tight case — roughly 360px of height for what was
laid out expecting 430. `@media (max-height: 500px)` in `src/style.css`
compresses the vertical rhythm rather than scaling everything down, since
proportional shrinking keeps the same overflow at a smaller size.

The look is a lit arena rather than a dark utility screen: floodlit blue,
teqball's vermilion for anything that starts a match, and chunky bordered
panels. Every raised control sits on a flat colour lip (`--lip`) and drops
onto it when pressed, which is what reads as a button on a phone — a
one-pixel border and a hover state say nothing to a finger. One rule carries
the whole palette: warm means "do this", everything else is cool, so the
action on a screen is never ambiguous.

## Graphics quality

`src/quality.ts` defines two tiers, picked automatically on first launch from
`navigator.deviceMemory`, core count and whether the device is touch, then
overridable from SETTINGS › DISPLAY on the title screen and remembered in
`localStorage`.
Applying a tier reloads the page — the engine's MSAA is fixed when the WebGL
context is created.

| | Pixel ratio cap | MSAA | Shadow map | Venue backdrop |
| --- | --- | --- | --- | --- |
| MEDIUM | 1.0 | off | 1024 | loaded |
| HIGH | 2.0 | on | 1024 | loaded |

There was a third tier below these. LOW dropped the venue backdrop to save a
1-5 MB download, which meant the venue a player had chosen did not appear — too
high a price for the framerate it bought. A stored or requested `low` now
resolves to `medium`.

The match simulates at a fixed 60 Hz regardless of display rate (`SIM_DT` in
`src/main.ts`), so a 30fps phone and a 120fps phone play the same game. Presses
are latched between simulation steps — see `latchInput` in `src/input.ts`.

## Scoring

A set is **first to three points**; a match is **best of three sets**. Short on
purpose: a rally here is a handful of touches and a phone match has to fit in
the gap it is being played in — a queue, a train, an advert break. First to
three makes every point a point that matters, and best of three keeps the shape
of a real match around it, because losing a set and still winning is the thing
that makes the second one worth playing.

`WIN_SCORE` and `SETS_TO_WIN` in `src/config.ts`. Anything measured in points
is sized against them — the daily challenge goals, the server's bounds on a
posted result — and `tests/progress.test.ts` holds every goal to being
reachable in a session, so shortening a set again cannot quietly turn a daily
challenge into a weekly one.

## The career

Everything a player keeps between matches lives in `localStorage` and nowhere
else. No account, no server, no sync — which is what lets it work on a plane,
and what stops a game about kicking a ball opening with a login wall.

```
match result ──► trophies ──► league tier ──► coins per match
             ├──► coins ─────► character levels ──► precision
             └──► daily challenges ──► coins
```

**Trophies and the ladder** (`src/league.ts`). Nine rungs from BEGINNER to
ELITE. The tier is *read off* the trophy count rather than stored, so there is
no ladder state that can drift out of agreement with the trophies themselves. A
win pays more than a loss takes at every difficulty — a ladder that gives back
exactly what it takes leaves a player where they started after an evening, and
that is the fastest way to make them stop — but a loss still costs something,
or the rank means nothing. A loss also still *pays* coins: the twenty minutes
were spent either way, and a game that pays nothing for a losing match teaches
the player to quit as soon as they fall behind.

**Characters** (`src/progress.ts`). Playing with a character levels it, win or
lose; coins level it now. A level buys **precision**, which is what the kick
spread divides by (`src/aim.ts`) — so an improved player is one whose hard
kicks stay in, not one who kicks harder. That is what the spread was for. The
roster unlocks against the *best* trophy count ever reached, so relegation
never takes a character away from someone who already earned it.

**Daily challenges** (`src/challenges.ts`). Three a day, drawn from a fixed
pool by the date itself: the date is the seed and the seed is the whole
synchronisation mechanism, so every device shows the same set on the same day
with nothing asked of a server. Never two of the same kind — three variations
on "play some matches" is one challenge wearing three hats. The day is local,
because the day has to turn over while the player is asleep and whose midnight
that is depends on where they are.

Practice pays nothing, because it cannot be lost. Everything else does,
including online — see below for how a result between two strangers is made
trustworthy enough to count.

## Accounts and the backend

`server/` is one process serving two things on one port: the match relay, and
the accounts API the community features will be built on. One deployment, one
URL to configure, and `apiBase()` derives the API's address from the relay's so
they cannot end up pointing at different places.

```
server/relay.mjs      the websocket relay, and the HTTP server both share
server/api.mjs        eight endpoints, no framework
server/accounts.mjs   ids, names, tokens, and what a match is worth
server/store.mjs      where players are kept
server/rules.mjs      GENERATED — the game's own career rules
```

**The id is the point.** Eight Crockford base32 characters, minted once and the
same next week and on the next phone. Every community feature — a friend list,
a club, a rivalry, a shared replay — hangs off it. The name is a label on top,
changeable, because people change their minds about names and never about
wanting to keep their trophies.

**Authentication is a bearer token** minted at registration and kept on the
device. No password, no email, no reset flow: those are three screens and a
mail provider standing between a player and a game, and what is being protected
is a trophy count.

A phone still gets lost, so there is a **recovery code** — sixteen Crockford
characters in four groups, shown once on a screen with no way past it but the
acknowledgement. Entering it on a new device moves the account there and
revokes the old one, which is the point: an account that keeps answering to the
phone it was recovered away from has not been recovered. The code is spent when
it is used and a fresh one issued, so a slip of paper somebody photographed
stops working.

Neither secret is stored as it was issued (`server/secrets.mjs`). The token is
kept as a plain SHA-256 because it is also the lookup key and has 192 bits
behind it; the recovery code is salted, because it is short enough for a person
to type and therefore short enough to attack in a leaked table. A database
snapshot that leaks should not hand anybody every account in the game.

The typed code is forgiving about case, hyphens and spaces, and folds the three
letters Crockford's own decoder folds — O to zero, I and L to one. Not Q: an
earlier version folded Q to zero too, and `tests/accounts.test.ts` caught that
every minted code containing a Q could never be typed back in.

**The server scores matches; the client reports them.** A leaderboard built
from totals the client posts is a ranking of whoever edited their save file
best. So the client sends a *result* — who played, at what difficulty, won or
lost, points, sets, rallies — and the server settles it with the same
arithmetic the client just ran, then hands back the career it now holds. Every
posted result is checked against what a match can physically produce, and there
is a cooldown per player, so a scripted climb takes as long as playing would.
That is not cheat-proof, which would mean running the simulation server-side
and is a different project; it is enough to keep a leaderboard worth looking at.

Both sides run the same arithmetic because there is only one copy of it.
`src/rules.ts` re-exports the pure, environment-free pieces, and
`scripts/build-rules.mjs` bundles them into `server/rules.mjs`:

```bash
npm run rules        # regenerate after touching league/challenges/progress
```

The bundle is committed because `server/Dockerfile` deliberately copies only
the server directory — an image carrying the whole build toolchain to
regenerate one file is a poor trade. `tests/rules.test.ts` fails if it has
drifted, and separately asserts that both copies score an identical match
identically. A server settling matches by last month's rules is a leaderboard
nobody can explain.

**Friends by code.** Add somebody with the eight characters on their card and
it is mutual immediately — no request to accept. There is nothing to protect
against: a player code is published nowhere, so whoever adds you already had it
from you, and a request-and-accept flow would be two screens and a notification
system in exchange for a permission that was granted when the code was shared.
Removing takes them off both lists, because a friendship one side can see and
the other cannot is a bug that shows up as a message nobody receives.

The list is ordered by the server, online first: "who can I play right now" is
the question the screen exists to answer, so the answer is at the top of it.
Presence is a count of open sockets in `server/presence.mjs`, written by the
relay and read by the API — a count rather than a set, because a phone that
reconnects before the old socket's close is noticed would otherwise mark itself
offline on the way in. Anyone without a socket shows when they were last seen,
rounded to *just now*, *today*, *this week* or *not for a while*: a friends
list asks "recently or not", and reporting that somebody was here 43 minutes
ago is both more precision than the answer needs and more than they agreed to
share.

**Clubs.** Ten people, by invitation, with a board of their own. The size is
the design rather than a tuning parameter: in a club of ten every name means
something to everybody else, and being fourth is a fact about people you know.
A club of five hundred is a chat room with a leaderboard attached, and the game
already has a leaderboard.

Invitation is a code, not a request-and-accept — the same reasoning as friends,
and for the same reason. What that costs is a leaked code, and the answer to a
leaked code is that the owner rotates it and removes whoever walked in, both
one press. So a club carries two identifiers: an `id` that never changes and
that `player.clubId` points at, and an `invite` that is meant to be thrown
away. Rotating an invite that doubled as the id would orphan every member.

The owner is the only one who can rename the club, replace the code or put
somebody out, and the only one shown the code — everybody can share a club they
are in, but one person should be deciding who is in it. An owner who leaves
hands the club to the longest-serving member rather than closing it: nine
people should not lose their club because one person moved on. The last member
out does close it, and the name and the code come free with it, because an
empty club holding a name is just a name nobody else can have.

The board is ordered by trophies, and the owner is marked rather than pinned to
the top. Being in charge is not the same as being top, and pretending otherwise
would make the ranking a lie.

**Ranked online.** An online result is worth more than any match against the
CPU — the opponent was also trying, and it is the one difficulty a player
cannot choose to make easier — so it is also the one that most needs to be
true.

Both sides report their own view of the match against a `matchId` the relay
minted when the two seats filled. A single report is *held*, not paid: the
server answers `202 pending`, the client says nothing about a rank, and if the
other side never reports then nobody gets anything. That is the right answer to
an unexplained claim. When both arrive they must tell one story — exactly one
winner, the winner holding the sets it takes to win — and disagreement pays
nobody.

The other way it settles is a walkover, and the deciding fact there is **not**
the surviving player's word. The relay watched the socket close, so the relay
is what gets asked (`server/matches.mjs`). Quit inside the opening set and the
match is void for both — a train going into a tunnel on the first point is not
rage-quitting, and punishing it would make the ladder a measure of signal
strength. After that it is a forfeit: the leaver takes the loss, the stayer
takes the win.

A forfeit is the one result that is a win without having won the sets, so the
coherence check `validateResult` normally applies is relaxed for it — and only
when the relay has already confirmed the disconnect, which is what stops
"they left, I won" being a free win for anybody who says it.

None of this makes cheating impossible; that would mean running the simulation
server-side, and it is a different project. It does mean a result requires two
clients to agree, or a socket to have genuinely closed.

**Names on the wire.** The relay looks up the account behind each socket from
its token, and tells each side who the other actually is. Verified rather than
announced: a name a client can choose for itself is a name that can be somebody
else's, and the whole point of an account is that the person across the net is
who the card says they are. Playing without an account still works — the
opponent is simply shown as a guest.

**Two stores, one interface.** Every method is async — including the ones a
file could answer instantly — because the store this deploys onto is Firestore
and an interface shaped around the in-memory case would have had to be torn up
the day it moved.

```bash
npm run relay                                  # JSON file in ./data
DATA_DIR=/var/teq npm run relay                # …somewhere that survives
FIRESTORE_PROJECT=teqopen-4c7ae npm run relay  # what production runs
```

`FirestoreStore` keeps three collections: `players/{id}`, and two index
collections `names/{lowercase}` and `tokens/{digest}`. Firestore has no unique
constraint and no cheap find-by-field — a document id *is* the index — so
taking a name is a transaction over the index and the player together, rather
than two writes with a race between them. Rank is two counting queries rather
than a table scan, so it stays cheap at the size the game hopes to reach.

`tests/firestore.test.ts` runs the store against a double that implements only
the calls it makes and throws on anything else. That is not a claim it works
against Google's Firestore — nothing short of pointing it at one proves that —
but it does hold the part that is mine: the shape of every read and write, that
the name index is taken *inside* the transaction, and that a recovered token
replaces the old one rather than joining it.

**Deploying.**

From a machine with `gcloud` signed in:

```bash
./server/deploy.sh                 # Cloud Run, europe-west9, Firestore
VITE_RELAY_URL=wss://… npm run build
```

Or from the GitHub UI, with no machine and no local credentials: Actions ->
**Deploy server** -> Run workflow. It runs the same script and then chains an
APK build against the URL that came back, so the two cannot drift — a build
carrying yesterday's relay address is a build with online play quietly pointed
at nothing, which has happened here before. The one-time credential setup is
written out at the top of `.github/workflows/deploy.yml`; the keyless route is
worth the extra ten minutes, because the alternative is a JSON key that is
valid until somebody remembers to rotate it.

Credentials come from the Cloud Run service account: nothing to configure, no
key file to leak. The script re-checks that `server/rules.mjs` is not stale
before it pushes, because that is the last moment a server about to score
matches by last month's rules can be caught.

`europe-west9` is Paris, and it is the region because that is where this
project's Firestore database lives. Cloud Run and Firestore do not have to be
in the same region, and every read pays for it when they are not: the database
is behind every request the server serves, so a hop across Europe is added to
all of them. A Firestore location cannot be changed after it is set, so it is
the service that moves to the database, never the other way around.

Nothing about an account is required to play. The career already works offline;
signing in makes it the server's copy instead of the device's. Every request
has a six-second ceiling and every failure is a no-op, so a server having a bad
minute costs a player a moment and never a match.

## Ratings

`src/ratings.ts` turns the balance values in `config.ts` — metres per second, a
multiplier on a spread radius — into REACTIVITY / POWER / CONTROL on a 0–100
scale, plus a TOTAL POWER that is just the three added up. The scale runs from
the weakest any character starts at to the strongest any character can be
trained to, so a fresh roster has nobody at 100: the top of the bar is a place
to get to. The floor is 40, because none of these characters is bad at
anything — they are differently good, and a bar reading zero says the opposite
of what the roster means.

The same numbers appear in three places: the picker, the roster cards, and the
head-to-head on the card before the whistle. That last one is the only moment a
player looks at both players at once, which makes it the cheapest place to
teach what the traits mean — and the one place where learning the opponent is
quicker actually matters, because they are about to play them.

## Scale

`TABLE_SCALE` in `src/config.ts` sizes the table, and the ball, the players,
their reach, the standing room behind the table, the serve spot and every
contact tolerance are multiplied by it too — they only look right in proportion
to one another, and anything left in bare metres quietly walks out of
proportion the moment the scale moves. It sits above the rulebook's true
dimensions because the game is played on a phone at arm's length, where a
correctly sized court reads as a set of miniatures in a large arena.

The other half of apparent size is the lens. `CAMERA` is deliberately tight: a
wide shot of a teqball court is mostly empty floor and stands, while everything
the player has to read is carried by two figures and a ball. Portrait cannot be
tightened as far as it looks like it should allow — its lens is pinned
horizontally (see `scene.ts`), so the field of view *is* the width of the shot,
and the shot is narrowest in world units exactly where the near player stands.
`tests/config.test.ts` holds that limit.

## Navigation

Every screen answers one question, and the title screen asks the easiest one.

```
TITLE ── PLAY ───────┬── FRIENDLY ──── difficulty ── pick ── match ── result
      │              ├── PRACTICE ──── pick ── match
      │              ├── COMPETITION ─ cup / league ── pick ── run
      │              └── ONLINE ────── quick / friend / code
      ├── CHAMPIONS ──── the roster, and what it costs to grow it
      ├── CHALLENGES ─── today's three
      ├── PROFILE ────── your name and code ─┬─ FRIENDS
      │                                       └─ LEADERBOARD
      └── SETTINGS ───── DISPLAY / GAMEPLAY / AUDIO
```

Nothing is ever more than Home → Category → Choice deep, and every screen has
its BACK control in the same place. The title screen carries one dominant
action and four quiet ones: a player opening the game for the first time only
has to recognise PLAY. The career doors are chips rather than cards for the
same reason — the screen still has exactly one thing on it that looks like the
thing to do. A finished challenge waiting to be collected puts an orange dot on
CHALLENGES, which is the only thing on that screen allowed to compete with
PLAY, and only as a dot.

Coins, trophies and the current rank ride in a strip above every screen where
those numbers are the reason the player is looking — and nowhere near a live
match, where a currency counter over the court is one more thing moving while a
ball is in the air.

Settings sit on the title screen rather than in the play menu — a player who
came to start a match should not have to read past a settings card to find one,
and a player looking for a setting is not thinking about game modes.

`src/settings.ts` remembers everything that is not the graphics tier: language,
music, sound, the camera a match opens in, and whether the first touch is
automatic. The tier is the exception the DISPLAY screen warns about — the
engine's MSAA is fixed when the WebGL context is created, so changing it
reloads the page, and the row says so before it is touched and asks again
before it happens.

The venue is not in settings. It is a per-match choice, so it is picked on the
last screen before the whistle, beside the player and the ball.

## Language

`src/i18n.ts` holds every string outside the 3D scene, in English, French,
Spanish and Portuguese — the four countries on the court. The English
catalogue is the source of truth: its keys are the type, so a translation that
misses one, or invents one, fails the build rather than showing a player a
blank button. The interface language is guessed from the device on a first run
and remembered once chosen.

The typeface is Exo 2, bundled as two variable-weight subsets in
`assets/fonts/` (71 KB together, SIL OFL). It is not fetched from a font CDN:
the packaged app has no network guarantee, and a menu whose type arrives late
reflows in front of the player.

## Venues

A venue is a backdrop model plus a procedural court that suits it, defined in
`src/venue.ts` and picked from its own tab on the select screen, beside the
player and the ball (`?venue=` overrides it for a session). There are four: the
indoor sports hall, and three outdoor grounds. A new install opens on
STREETBALL — the sports hall is the one behind the purchase, so it cannot be
the default.

The venue tab shows the **real scene** rather than a model in the viewer's
studio: the venue is already built behind the picker, so browsing steps out of
the studio and lets the court show through. A 4.8 MB arena loaded a second time
to render a worse version of something already on screen would be the wrong
trade. On the locked venue, PLAY becomes UNLOCK — the screen showing what you
cannot have is the screen that should sell it.

Nothing in a venue touches gameplay. The bounds players move inside
(`COURT.minX`, `maxX`, `maxZ`) and `GROUND_Y` are the same everywhere, which is
what lets it stay a local choice: two peers online can be looking at a
basketball hall and a football pitch and still run the same simulation. Only
the floor, the line colours, the boards and the sky change.

The outdoor courts set `surface: "venue"`, meaning the model's own blacktop,
grass or hard court is what the players stand on and only the teqball lines are
drawn over it. That is what makes them look like three places rather than one
court with three wallpapers — and when the tier skips the backdrop, the court
falls back to painting its own floor in the venue's colour, so LOW still gets
green grass or blue hard court for no download at all.

### Set dressing

The venue models are empty sports grounds. What makes one look like a match is
built in `src/environment.ts` from a palette in the venue preset — a ring of
lit sponsor boards around the court, a crowd standing behind it, corner flags —
because a real teqball court sits inside exactly that.

The board ring is procedural and costs nothing to ship: panels are merged into
one mesh per colour, so a 72-panel ring around the sports hall's ellipse is
three draw calls.

The crowd is `assets/models/Crowd/Crowd.glb` — 19 standing figures, 1,389
triangles each, 0.19 MB. Every figure is thin instanced, so a crowd is one draw
call per distinct figure rather than one per person: 65 people on the
basketball court cost 14 calls and 89k triangles.

Three things that pass a build and fail on screen, all found by looking:

- **Spectators are sized against the players, not against life.**
  `CHARACTER_SCALE` puts a character at about 1.45 m in an otherwise 1:1 world,
  so a realistic 1.75 m spectator stands a head taller than everyone on court.
- **One scale for the whole crowd, from the median figure.** Normalising each
  figure to the same bounding-box height shrinks exactly the people with their
  arms up — which, in a cheering pack, is most of them.
- **Recentre each figure on its own footprint, not just the floor.** The source
  pack is one grandstand and every figure carries the seat it was exported at.
  `MergeMeshes` bakes world matrices into vertices, so that offset survives
  inside the geometry, and a thin instance placed at the touchline lands at
  touchline-plus-seat. It scattered a third of the crowd across the pitch, and
  it is invisible from the play camera — `TOP=1 node scripts/venue-shots.mjs`
  is what showed it.

The crowd moves. `src/crowd.ts` rocks everyone on the spot during a rally and
jumps the whole stand when a point lands, listening to the match's own
`point-awarded` and `serve-committed` events rather than being told by every
caller that starts a match.

The animation is in the instance transforms, because a thin instance cannot be
skinned — it is a matrix sharing one skeleton-less mesh with every other copy.
That suits the material: the figures are already posed mid-cheer with their
arms up, so a vertical hop reads as celebration without a single new pose. A
matrix keeps its translation at indices 12, 13 and 14 of its sixteen floats,
so a person costs three writes a frame and the whole crowd is a rounding error.
It runs on wall-clock time outside the simulation — it is scenery, it must not
consume simulation steps, and it should keep moving under a menu.

Seated figures fill the benches the outdoor models already contain. Their
positions are measured out of the model rather than guessed: eight benches,
four a side, seat surface 0.31 m up. Those are the ten figures the standing
crowd throws away, so they cost nothing extra.

`tiers` builds a bowl of bleachers and is written and working, but no venue
uses it. The indoor hall's seating is modelled as concentric rings with no
per-seat geometry, so there is nothing to read a rake off, and every guess at
one put people through a wall or out on the grass. It needs the bowl's real
first-row radius and rise — a measurement, not another guess. Until then the
hall gets a courtside row inside the ring like the outdoor grounds.

The whole lot rides with the backdrop and is skipped on the tier that skips it.

#### Where the crowd came from

A purchased pack (3DExport, Basic Licence). Preparing it was four steps, none
of which are in the repository because the sources are 20x the size of the
result:

1. One placement extracted per distinct figure — the pack is 187 seats drawn
   from 29 people.
2. The 10 figures posed *sitting* dropped. They are seated on stadium seats
   that are not in the export, so on flat ground they look like they have
   fallen over. Height and the fraction of the body below mid-height separate
   them cleanly: seated figures are 127-139 cm and bottom-heavy, standing ones
   are 156-210 cm and top-heavy.
3. Colours assigned from the material *names*. The pack's own `.mtl` is 0.8
   grey everywhere with texture paths to a drive that does not exist, so which
   body part a material belongs to — hair, head, eyes, skin, clothes — is the
   only usable colour information in it. At the size a spectator is on screen,
   that plus a per-figure palette is enough.
4. `gltfpack -si 0.10 -cc -km -kn`: 9,222 triangles per figure down to 1,389,
   6.97 MB down to 0.28 MB for all 29.

The pose is recorded in the node name (`stand_`/`sit_`) because nothing else in
the file records it, and the loader finds it by walking *up* the parent chain:
the compression pass nests a generated `node0` between the named node and its
meshes, so a figure's immediate parent is anonymous.

At load, each figure's five materials are baked to vertex colours and merged,
so a person is one mesh with one material and can be instanced.

**The licence constrains how this ships, not whether.** It permits commercial
use in one product, royalty-free, up to 250,000 downloads. It also forbids
distributing the model "in a file format that is usable by any 3D
application" — and a `.glb` in an APK, or served from a web host, is exactly
that. Two consequences worth keeping in mind:

- **Do not make this repository public while `Crowd.glb` or `Props.glb` is in
  it.** A Shipaton submission asking for a repo link is the obvious way that
  happens by accident. The scenery props are purchased packs under the same
  kind of terms; their source files are deliberately kept out of the repo, and
  `scripts/props/` holds the recipe rather than the ingredients.
- Baking the crowd into the venue backdrop as merged static geometry is the
  stronger position for a shipped build, since it leaves no separable figure to
  extract. It costs the instancing — 65 people become 65 copies of the
  geometry — so it is a trade to make deliberately, not a default.

### Surroundings

The arena models are a fenced site with sky beyond the fence, which reads as a
diorama however good the court is. `src/surroundings.ts` builds the world each
one stands in — a city block, parkland, a beach — procedurally, so it costs no
download.

Realism at this budget is not detail, which a phone cannot afford and nobody
can see past a fence anyway. It comes from three things:

- **Silhouette and depth** — buildings at varying heights and distances, trees
  at varying scales, a horizon that recedes.
- **Haze** — exponential fog toward the horizon colour. This is most of what
  makes distance read as distance, and it hides the edge of the built world.
- **A sky with a gradient in it.** A flat clear colour is the most
  diorama-like thing in a scene; a graded dome is one unlit mesh.

Surfaces are tiled photographs rather than flat colours: `assets/textures/` —
eight 512x512 WebP tiles, 576 KB for the set. `Tile` in `src/venue.ts` gives
each one a name and **how much world one repeat covers**, and that number
matters as much as the image. Too large and the ground smears; too small and
it shimmers into noise at distance. The first pass put brick at 8 m a repeat
and the bricks came out a metre tall.

A texture also has to take the diffuse *colour* to white when it is applied —
`diffuseColor` multiplies the texture, so leaving the flat fallback colour in
place tints every photograph toward it. The flat colours stay as the fallback
for a venue with no tile.

Three of the eight arrived with measurable edge discontinuities and only one
of those — the water — had a seam you could actually see when tiled 2x2.
Brick, concrete and marble measured worse and looked fine. Measure, then look:
the metric flags contrast at the edge, which is not the same thing as a seam.
The water is mirrored in one axis, which wraps by construction and is
invisible on ripples that have no direction.

Two things it got wrong first, both worth keeping in mind for anything else
placed in the world:

- The world ground has to sit below everything the *venue* owns, not just
  below its court. The arena models stand on a foundation slab whose base is
  0.6 m under the playing surface, so a ground plane tucked 6 cm under the
  court drew straight over the top of it and turned every venue into the same
  sheet of grey. `WORLD_Y` is that height, and **everything outside the fence
  has to be placed on it** — the first row of parked cars was placed at court
  height and hovered a metre off the road.
- A vertex colour multiplies a StandardMaterial's **diffuse**, not its
  emissive. An unlit dome with white emissive comes out flat, and with black
  emissive comes out black; the gradient has to ride on diffuse.

### Scenery props

The boxes and sphere-trees above read as a world at a hundred metres and as a
diorama at thirty. `assets/models/Props/Props.glb` is 50 modelled props —
20 houses, 14 trees, 8 cars, 6 palms, 2 shrubs — in 0.45 MB, one material and
no textures at all. `src/props.ts` loads them; `src/surroundings.ts` places
them. A streetball court now stands in a neighbourhood, a pitch in a wood, a
hard court under palms.

They are cheap for three reasons, and the third is the one that is easy to get
wrong:

- **The colour is baked into the vertices.** All four packs colour themselves
  from one atlas of flat palette swatches — every window, wheel and door in
  them is geometry, not texture detail — so the atlas is sampled per vertex at
  build time and thrown away. That also killed a rainbow-striping artefact:
  aggressive simplification drags UVs across neighbouring swatches, and with
  no UVs there is nothing to drag.
- **They are decimated at build time.** Houses arrive at 3-8k triangles and
  ship at ~1k. `gltfpack -si` alone reduces these models by 5%: they are
  faceted, so every edge is an attribute seam, and only `-sa` will collapse
  one.
- **A draw call is per model, not per copy.** `Scatter.models` is a draw-call
  budget: twenty houses placed from twenty models cost twenty calls and buy
  nothing visible at forty metres, where six models at varied scale and
  rotation read the same. The first pass placed 56 props from 42 models and
  paid 42 calls for it.

Three that cost real time:

- **Quantized positions do not survive `bakeCurrentTransformIntoVertices`.**
  `getVerticesData` hands back the raw integers, the bake transforms *those*,
  and the props came out as 1 cm slabs. The file is packed `-vpf` for that
  reason.
- **Baking does not refresh the bounding box.** It stays as the loader built
  it from the file's accessor bounds, so a height read straight after a bake
  is the height from before it, and every prop gets scaled by the wrong
  number.
- **A PBR material can hide bad vertex colours**, which makes it a bad
  baseline. Half an hour went into chasing "broken normals" that were the
  pack's own near-black roofs, invisible under the glTF material that was not
  showing the vertex colours at all.

Rebuilding the file needs the source packs, which are not in the repo: see
`scripts/props/pack-props.sh`, which documents the whole pipeline and the
reason for every flag in it.

### The establishing shot

An offline match opens on the venue rather than on the table: `src/intro.ts`
swings the camera in from wide and high over about three and a half seconds,
under a broadcast card naming the venue and the two players. Any press skips
it. The simulation is held while it runs, because the CPU is perfectly happy
to serve during a camera move.

Online matches do not get one. Holding the local simulation while the other
peer keeps playing is a forfeited point, and there is no reason for the two
phones to agree about a camera.

The shot is plain numbers rather than Babylon vectors so `tests/intro.test.ts`
can assert the parts that fail silently: that it ends exactly on the live play
camera, that it never dips below the floor, and that a bounded sweep stays
inside its bounds. Each venue can name its own `sweep`, and the sports hall
needs one — it is enclosed, so pulling back leaves the bowl and lifting hits
the roof trusses. Its shot stays at the play camera's own height, which is the
one line through the hall the game already proves is clear.

### Preparing a backdrop model

The three outdoor arenas arrived at ~8 MB each, split into 400-720 meshes over
15-21 materials. Draw calls are what a backdrop costs on a phone — not
triangles — and 723 of them is more than ten times the rest of the scene.

```bash
scripts/pack-arena.sh raw/Basketball.glb assets/models/Arena/Basketball.glb
```

That is `gltfpack -cc -mm -km`, and the flags are explained in the script. It
takes each arena to ~1.2 MB in one mesh per material:

| | before | after |
| --- | --- | --- |
| Basketball | 8.10 MB, 723 meshes | 1.22 MB, 21 |
| Soccer | 9.02 MB, 685 meshes | 1.45 MB, 15 |
| Tennis | 6.96 MB, 400 meshes | 1.10 MB, 16 |

`mergeByMaterial` in `src/scene.ts` does the same merge at runtime for models
that arrive unpacked — the sports hall goes 86 → 41 that way. It skips any mesh
that has instances: `MergeMeshes` disposes the sources it consumed, and
disposing a mesh takes its instances with it, so merging a model whose exporter
shared one mesh across many nodes would silently delete every bench but the
first. `-mm` above exists to avoid handing it that shape in the first place.

```bash
npm run build && npm run preview -- --port 5199 --strictPort
node scripts/venue-shots.mjs             # draw calls per frame + a screenshot each
node scripts/venue-shots.mjs --no-merge  # the same without merging, to compare
QUALITY=low node scripts/venue-shots.mjs # the no-backdrop fallback
```

`venue-shots.mjs` counts real draw calls by wrapping the engine's draw entry
points for a couple of seconds, because counting meshes misleads in both
directions: one mesh with several submeshes is several calls, and a hundred
instanced copies are one. Comparing merged against `--no-merge` is also the
only way to know the merge draws the same picture — on the basketball court it
took 723 calls to 21 with every differing pixel belonging to the characters and
the HUD.

## Texture budget

Character textures are capped at 1024x1024. This matters more than file size:
a 2048x2048 texture is about 1 MB as WebP but ~16 MB of RGBA once decoded (~21 MB
with mipmaps), and each character carries eleven of them. The cap took each
character from ~185 MB of decoded texture memory to ~46 MB.

`scripts/shrink_textures.py` applies the cap (needs `pip install Pillow`):

```bash
python3 scripts/shrink_textures.py --dry-run assets/models/characters/*.glb
python3 scripts/shrink_textures.py --max 1024 assets/models/characters/*.glb
```

It rewrites the GLB in place, moving the EXT_meshopt_compression block as one
piece so the compressed geometry is never reinterpreted. Re-run
`scripts/verify-build.mjs` afterwards — it loads the models in a real browser,
which is the only thing that proves a rewritten GLB still works.

Music must be MP3: a 30-second 24-bit stereo WAV is 7.9 MB against 0.5 MB at
128 kbps.

## Online play

The netcode is **host-authoritative with client-side prediction**. One peer
runs the whole match — both characters, the ball, the rules — and sends a full
snapshot at 20 Hz; the other sends its controls every step and applies what
comes back. The guest predicts its own character locally so its stick still
feels immediate, and `reconcile` in `src/net/reconcile.ts` eases that
prediction back onto each snapshot, snapping only when the error is large
enough that easing would be visible as sliding.

An earlier design let the striking peer roll its own dice and send the
resulting ball state, with authority passing back and forth. It was elegant and
it did not work: both peers were running complete independent matches, so
everything not carried by a strike message — where the *other* player was
standing, which clip they were playing — drifted apart within a rally.
`snap` carries positions, velocities and clip names for both sides precisely
because guessing at any of them is what broke.

The guest's world is mirrored so both players see themselves on the near side;
`reframe` in `src/net/protocol.ts` rotates every message 180° about the
vertical axis on the way in and out, and swaps the two seats with it.

```bash
npm run relay        # PORT=8787, health check on /healthz
```

### Deploying with only a phone

Everything below can be done from a mobile browser.

1. **Host the relay.** Sign in to a container host with GitHub, create a service
   from this repository, and let `render.yaml` configure it. Wait for the
   `wss://…` URL, and confirm `https://…/healthz` answers `{"ok":true}`.
2. **Tell the app where it is.** GitHub → Settings → Secrets and variables →
   Actions → Variables → new repository variable `VITE_RELAY_URL`, set to the
   `wss://` URL. Or skip this and type the URL each time in step 3.
3. **Build.** GitHub → Actions → *Android APK* → **Run workflow**, optionally
   pasting the relay URL. The run summary prints which relay was baked in.
4. **Install.** Download the `teqrallly-debug-apk` artifact from the finished
   run, unzip, open the APK. Repeat on the second phone.

A build with no relay configured still installs and plays; online is shown as
unavailable rather than failing partway through a lobby.

### Where the relay runs

A Firebase project is also a Google Cloud project, so the relay belongs on
**Cloud Run** in the same project as Hosting — one console, one bill, and
WebSockets over TLS with no certificate work.

Two things not to try:

- **Firebase Hosting cannot proxy WebSockets.** A `rewrite` to Cloud Run works
  for ordinary requests but not for the upgrade, so the game connects straight
  to the Cloud Run URL rather than through `yourapp.web.app`.
- **Realtime Database is the wrong transport for match data.** It is a fine
  lobby, but 20 Hz of position updates per player is not what it is priced or
  tuned for, and it adds a hop the relay does not.

```bash
gcloud run deploy teqopen-relay \
  --source server \
  --region europe-west9 \
  --allow-unauthenticated \
  --max-instances 1 \
  --min-instances 1 \
  --timeout 3600
```

`--max-instances 1` is **required, not tuning**: rooms live in the relay's
memory, so two players routed to different instances would sit in separate
rooms with the same code and never see each other. Sharing room state (Redis,
or Realtime Database) is what would lift that cap.

`--min-instances 1` avoids a cold start on the first connection, and
`--timeout 3600` stops Cloud Run cutting a long WebSocket at its default.

Then point the game at the deployed URL — builds cannot discover it, because a
packaged app's own origin is `https://localhost`:

```bash
VITE_RELAY_URL=wss://teqopen-relay-xxxxx.europe-west9.run.app npm run build
```

`src/net/endpoint.ts` falls back to the page's own host on port 8787, which is
correct for `npm run dev:lan` and deliberately wrong for a packaged build that
forgot the variable — `looksReachable` detects that case so online play can be
shown as unavailable instead of failing at the end of a lobby flow.

`server/relay.mjs` knows only about rooms and seats and forwards every other
frame verbatim — no game state lives there, so it cannot disagree with the
clients and can be restarted mid-match. A WebSocket relay rather than WebRTC
because a DataChannel needs signalling plus a TURN fallback, which is not where
a deadline should go.

`tests/relay.test.ts` and `tests/rally.test.ts` run the real server and two real
sockets, and assert that a rally's worth of frames leaves both peers agreeing
about the score and each player on their own side of their own table.

```bash
npm run build && npm run preview -- --port 5199 --strictPort
npm run relay
node scripts/verify-online-match.mjs   # two headless clients play a real match
```

That one is worth the wall-clock: it caught a guest whose opponent never moved,
and again a guest whose opponent moved but never animated, both of which
typecheck and pass every unit test.

## Purchases

Everything paid hangs off one entitlement, **Teqie Pro**, and `src/purchases.ts`
is the only module that imports the SDK — so there is one answer to "is this
player pro" rather than one per call site. Products are `monthly`, `yearly` and
`lifetime`; the game never asks which one somebody bought, because all three
mean the same thing to a locked arena.

It goes through `@revenuecat/purchases-capacitor` rather than Kotlin because the
game is TypeScript in a WebView: the plugin *is* the native Android SDK
(`purchases-hybrid-common` wraps `com.revenuecat.purchases:purchases`), and an
entitlement the WebView cannot read is one that nothing can act on.

`purchasesAvailable()` is false in a browser, so the dev server, the hosted
build and every harness run with no store and nothing to stub.

What it sells is the **sports hall**. The three outdoor courts stay free, so
what is given away is a whole game rather than a demo. The rule sits on the
venue itself (`premium: true` in `src/venue.ts`), which makes adding a venue ask
the question, and `permittedVenue(id, pro)` re-checks a *remembered* choice at
boot — a subscription can lapse between two sessions, and the venue saved in
`localStorage` must not stay unlocked after it does. The check runs once the
store answers rather than before it, because holding the first frame on a
network round trip would make a paying player wait to see what they paid for.

The padlock on the locked chip is drawn from an SVG mask rather than typed as
🔒: an emoji is a font the device may not have, and headless Chromium proves
the point by rendering a tofu box. A `?venue=` URL override is not gated — it is
the harness hook, and hiding a client-side check in an open web bundle would be
theatre.

Two things that are easy to get wrong and fail quietly: the entitlement
identifier is a dictionary key and must match the dashboard exactly, and the
default API key is a **Test Store** key — a Play release needs the `goog_…` one
via `VITE_REVENUECAT_KEY`. See **PURCHASES.md** for the dashboard setup, usage
examples and the release checklist.

## Balls, and the shirt

A ball is not just a colour. Each carries multipliers on the player's traits in
`BALLS` (`src/config.ts`), every one of them a trade — a ball that were only
better would make the choice a formality and the other three decoration. Each
character also has one ball that suits them (`BALL_AFFINITY`), which multiplies
that ball's *upside* by `AFFINITY_BONUS`; the downside is left alone, so
affinity is a reward rather than something to think twice about.

`withBall(def, ball)` is shaped like `withCareer`: traits in, traits out. It is
applied inside `startMatch`, the one place a match is built, so the physics, the
AI and the card on the picker all read one already-modified `CharacterDef` and
none of them has to know a ball was involved. The picker shows the difference
rather than the total — `+6 POWER` is a reason to own a ball and `104 POWER` is
not.

Four of the original eight balls are gone. They came from a Nike Pitch export
and carried the mark plainly enough to read on a phone, and `publicDir` is the
whole `assets/` folder — so a model that is merely unreferenced still ships
inside the APK. They were deleted, not just delisted.

**The shirt.** `src/kit.ts` composites a name across the back, a number under
it, and a small crest on the chest into the shirt's own albedo texture. Not a
decal: Babylon builds a decal as static geometry from the mesh's current pose,
and these characters are skinned, so a decal number would hang in mid-air the
moment the player ran. The only thing that follows a skinned mesh is its
texture.

Where the marks go was measured, not guessed — an 8×8 labelled grid painted
onto the shirt and photographed from both sides put the back panel at cells
B2–C4 and the front at F2–G4, which is what `BACK_PANEL` and `FRONT_PANEL`
record. Getting the artwork back to composite onto needs `readPixels`, because
the glTF loader keeps its images inside the `.glb` and `texture.url` is
`data:/models/…glb#image3` — a name, not something fetchable. Those rows come
back bottom-up, as WebGL has always returned them, and are flipped on the way
into the canvas.

## Testing on a phone

**Quickest — no Android tooling at all.** The game is a web app, so a phone on
the same Wi-Fi can just open the dev server:

```bash
npm run dev:lan          # prints a Network: http://192.168.x.x:5173 URL
```

Open that URL on the phone. This exercises the real GPU, the real touch
controls and the real device tier detection, and it hot-reloads on save. It is
the fastest way to check how the game actually feels.

The one thing it does not test is the WebView: Chrome on Android and the
WebView the packaged app runs in are not always the same engine version. For
anything performance- or WebGL-sensitive, confirm in a real build too.

### Android build

```bash
npm run android:apk      # build, sync, then assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it
to the phone and install, or `adb install -r <path>`.

Requires the Android SDK (platform 35 and build-tools) plus JDK 21.
`npm run android:open` opens the project in Android Studio, which will offer to
install anything missing — the easiest first-time route.

### Live reload inside the real WebView

Best of both: the packaged app, but loading from the dev server so edits appear
without a rebuild.

```bash
npm run dev:lan
CAP_SERVER_URL=http://192.168.x.x:5173 npx cap sync android
npm run android:apk
```

Unset `CAP_SERVER_URL` and re-sync before building anything you intend to ship,
or the app will point at a dev machine that is not there.

Debug builds allow cleartext HTTP and WebSockets to the local network
(`android/app/src/debug/res/xml/network_security_config.xml`) so the device can
reach the dev server and a relay running on a laptop. Release builds refuse
cleartext, so a shipped app must use `https://` and `wss://`.

## Deploy

TeqRallly is a static site; Firebase Hosting serves the built `dist/` folder.

```bash
npx firebase-tools login
npm run build
npx firebase-tools deploy --only hosting --project YOUR_FIREBASE_PROJECT_ID
```

The relay lives on Cloud Run (`server/deploy.sh`), currently at
`https://teqrallly-rpvbgjr3wa-od.a.run.app` in europe-west9 — the same region as
Firestore, because the database is on the other side of every request it serves.

**Any build not served by the dev server has to be told where that is.** Online
play derives its address from the page origin otherwise, which in a packaged app
is `https://localhost`, and `looksReachable` then correctly offers online play as
unavailable. That is how builds 22-24 shipped with it quietly switched off:

```bash
VITE_RELAY_URL=wss://teqrallly-rpvbgjr3wa-od.a.run.app npm run build
npx cap sync android
```

`.github/workflows/deploy.yml` chains the two so they cannot drift; a build made
by hand has to pass the variable by hand.

Firestore's composite indexes are declared in `firestore.indexes.json` and are
not optional — the queries fail outright without them:

```bash
npx firebase-tools deploy --only firestore:indexes
```

## Project notes

- `src/scene.ts` — Babylon scene, court, table, backdrop, and asset loading.
- `src/venue.ts` — venue presets: which backdrop, which court palette.
- `src/character.ts` — character rigs, animation timing, and contact offsets.
- `src/ball.ts` / `src/match.ts` — ball physics, rallies, scoring and sets.
- `src/ai.ts` / `src/input.ts` — CPU behavior and keyboard, touch, and gamepad input.
- `src/ui.ts` / `src/main.ts` — menus, practice flow, cameras, and application flow.
- `assets/` — compressed GLB models, audio, and the local Meshopt decoder.
- `tests/` — Vitest unit tests for the pure gameplay maths.
- `scripts/` — headless-Chromium helpers for the parts unit tests cannot reach.

Babylon is emitted as its own `babylon-*.js` chunk, so shipping game code does
not invalidate the ~1.8 MB engine a returning player already has cached. Only
the statically reached part of the engine goes in there — Babylon's shaders and
texture loaders stay in the lazy chunks Rollup already splits them into.

The models use Meshopt geometry/animation compression and WebP textures so the
hosted game downloads quickly while keeping the original rigs and animation
groups.

## Codex and GPT-5.6

I built and tested TeqRallly in Codex with GPT-5.6. Codex helped implement and
debug the animation, physics, match rules, AI, input, mobile, and
hosting work. Product decisions and playtesting remained mine.
