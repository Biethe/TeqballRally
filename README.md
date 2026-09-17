# TeqRallly

TeqRallly is a browser-based 3D teqball game built with Babylon.js, TypeScript,
and Vite. Play solo against the CPU, learn in Practice, compete in a cup or
league, or take someone on online.

## Run locally

```bash
npm install
npm run assets:fetch       # the art is not in this repo — see below
npm run dev                # open the printed URL
npm run dev -- --host      # make the dev build reachable from a phone
npm run build              # production files in dist/, needs VITE_ASSET_KEY
```

**The models, textures, audio and video are not committed.** They are licensed
packs, and this repository is public; `npm run assets:fetch` pulls them from
private storage given `ASSET_BUNDLE_URL` and `ASSET_BUNDLE_KEY`. Without them
you still get a repository that typechecks, lints, passes its tests and builds
with `npm run build:plain` — everything except a playable stage. See
[Protecting the art](#protecting-the-art).

The game supports keyboard, touch, and Gamepad API controllers, and plays
either way up on a phone.

| Action | Keyboard | Gamepad | Touch (landscape) | Touch (portrait) |
| --- | --- | --- | --- | --- |
| Move | WASD or arrows | Left stick | Move stick | Tap where to stand |
| Play a set-up | WASD or arrows | Left stick | Move stick | Tap where to put the ball |
| Aim a kick | Hold Space, then WASD | Hold A, then stick | Hold STRIKE, then stick | Sideways part of the swipe |
| Kick | Release Space | Release A | Release STRIKE | Swipe — up lofts, down drives, speed is power |
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
`src/config.ts`, `autoFirstReception` to switch the first touch back to manual).

## Staying with the ball

Two different things can own a player's feet, at two different moments, and
keeping them apart is what makes the assist an assist rather than a takeover.

**A ball coming at you is yours to go and get.** Nothing runs for you. The
stick steers, and what the game adds is shaping: a bend onto the contact point
when you are already pushing roughly at it (`REACH_ASSIST`), and — once you are
outside the free circle — damping on the half of the push that is *leaving*,
plus a leash drawing you back into the room you are not using (`RECEPTION_ZONE`
in `src/config.ts`). The leash fades out as you push away and is gone entirely
at a full push, so leaving is always a decision you can make. It fades on
pushing *away* rather than on pushing at all, because on this stick a held
direction is also how the coming touch is aimed, and a leash that faded on a
sideways hold would quietly cancel the help needed to reach the ball and play
it.

How much of that help you get is a question about time, not distance:

```
slack = time until the ball arrives  -  distance / your top speed
```

Negative and you get nothing — the ball is going to beat you however hard you
run, and a fast or well-placed shot has to be able to win the point. Positive
and it fades in across `REACH_ASSIST.slackFull`. A ball three metres away with
a second of hang is worth helping with; the same ball driven flat is not. A
lateral band used to answer this instead, which said no to a lofted ball two
paces to the side and yes to a drive that was already past.

Around the contact point is a circle you move freely inside — which side of the
ball to stand, how square to be, how long to let it drop, all untouched. Its
radius is *derived*, not chosen: the anchor stands `ANCHOR_STEP_BACK` behind the
drop so the ball comes down in front of you, which puts the ball that much
further away than the anchor is. Any wider and there would be a band where the
game says your feet are your own and then the ball is out of reach from where
you stood — which is exactly how an idle player was left watching a reception
that was theirs to make. `tests/reception.test.ts` holds that.

**A ball you put up yourself is not.** Once your own set-up is in the air it is
going nowhere else, there is nothing left to decide, and the run under it cannot
be refused or pushed out of (`AUTO_RUN`). This is the one place the game takes
the feet, and it is the fix for the failure it was built for: an oriented
reception played out to the side used to switch its own run off the moment the
ball cleared a lateral band, stranding the player two paces from a ball they had
just placed, with the next touch gone through no fault of their thumb. The run
releases at the drop, where choosing a side of the ball becomes the decision
worth making, and picks back up if the anchor moves further than the arrival
covers — the recovery a set-up that came off the body badly should demand.

In the last stretch before a first touch the stick stops being a run and becomes
the shape of the touch: a player holding a direction as the ball lands on them
is crafting a set-up, not asking to walk away from one, so there the feet go to
the assist and the push is read as aim alone (`receptionSettling`).

One spot does all of it — the bend, the circle, the leash and the run all aim at
the same anchor — and it is read off the ball's live flight rather than from what
a touch intended, together with when the ball gets there. A set-up that came off
the body badly therefore moves it.

## Touches, and what they are worth

A touch is not a yes or a no. Three things decide how well the ball was met,
and all three are things the player did before it arrived (`src/touch.ts`):

```
height   the ball is where the chosen limb actually strikes, not half a body off
reach    it is in front of them, not at full stretch
timing   the contact falls in the middle of the window, not at either end
```

There is no clock to hit and no bar to watch — the grade is geometry the player
produced by standing somewhere and asking for the touch when they did. Height
leads the weighting, because where you stand is the thing you have most control
over; timing is last, because a game that graded timing hardest would be a
rhythm game with a table drawn on it.

What it buys is *control*, never permission. A well-met set-up sits the ball up
where it was asked for; a scrappy one comes off lower, shorter and drifting —
on past the spot if the ball was taken early, short of it if it was taken
late — which is an awkward second touch rather than a lost point. There is a
floor under the grade for exactly that reason. On a kick the cost lands on the
line rather than the pace: a rushed attack is still fast, and no longer aimed.

Reading the direction matters. Meeting the ball early, up on the body, is the
*good* contact; leaving it until it is nearly on the floor is the poor one —
which is the sport, and which is why `practice.early` ("strike while the ball
is still high") is now backed by something.

## Three touches, three parts of the body

Two touches in a row may not use the same part of the body. That is the
rulebook, and it is enforced where the limb is chosen rather than as a foul
afterwards: the game picks the limb, so it picks a legal one. A player who has
just chested the ball knows the next touch is a knee or a foot, and can put the
ball at the height that picks the one they want.

The parts are not reskins of each other (`PART_SETUP` in `src/config.ts`):

| | What it is for |
| --- | --- |
| Chest | Control. Barely moves the ball, puts it exactly where it was asked for, and forgives a bad contact. |
| Knee | The in-between touch: enough carry to step out of a bad spot, enough hang time to get there. |
| Foot | Moves the ball furthest and hangs it lowest — the quick set-up into an attack, and the one that punishes a poor contact hardest. |
| Head | Buys the most time, at the cost of placement. A finishing limb: there is no heading clip that leaves the ball playable. |

Which one arrives is decided entirely by where the ball is and where the player
is standing. Height picks the band; how far to the *side* the ball is arriving
slides the whole ladder down, because reaching for a ball is what the leg does
and a ball in front is met with whatever is already there (`bandShift`). So the
same ball played square is a chest touch and played wide is a knee.

## Nothing is rolled

Clip selection used to roll dice — a band jitter on every contact, a weighted
coin for which side took a central ball, another for which head serve was
played, another again for whether a weak-side ball was headed. It bought
variety, at the price of the thing the variety was for: two identical balls
could be played two different ways, so nothing a player learned about where to
stand held.

All of it is now read from the state instead. The spread across a match is the
same — a rally still sees every clip — but each one happens for a reason the
player can see and can cause again. The weak foot, in particular, stopped being
a die roll and became a *reach*: how far across the body that foot is trusted
before the head takes over, so at 20 nearly every high ball on that side is
headed and at 95 the foot goes right out to the touchline.

What is still random is the landing spread on a kick, deliberately: pace has to
cost accuracy. `tests/possession.test.ts` pins the distinction by playing the
same rally against two very different random streams and requiring the same
clips out of both.

A set-up never lands on the player's own half: playing the ball onto your own
table is a fault, and a placement the player asked for must not be the thing
that loses them the point.

## Kicks, and missing with them

A kick aims at a point anywhere on the court and is struck at a power the
player chooses. Landscape holds the kick control: the stick moves the aim
marker while the charge builds, and letting go strikes.

Portrait swipes, and the swipe says two things at once. Its **sideways** half
aims the ball. Its **steepness** chooses the shot:

**Three things a swipe says, three things a shot is, and nothing riding along
with anything else.**

| What the swipe does | What it decides |
| --- | --- |
| How far across it went | Which side of the table |
| How far up or down it went | The arc — up lofts it, down drives it flat |
| How fast it was drawn | How hard it is struck |

Depth is deliberately not on that list. The arc and the pace already decide it —
high and slow drops short, flat and hard runs deep — so a fourth dial would ask
the player to specify something already answered. `swipeTarget` derives it.

**A kick is aimed at the table, not thrown a distance from the player.** That
sounds like a detail and was the whole problem. The target used to be placed a
fixed carry from the striker — up to eleven metres, in a court under six metres
deep — so where somebody happened to be standing decided whether *anything*
could land in. From a normal receiving position it meant every drive and every
rally ball overshot the table and a downward lob was the only swipe that could
score. Aiming at the opponent's half, the way the CPU already does through
`tableTarget`, means a shot lands where it was sent from anywhere on the court,
and over-hitting is paid for in accuracy — the spread grows with power — rather
than in an arbitrary length.

That independence is the point. Steepness used to set the arc, the pace *and*
the depth together, which made two real shots impossible: the fast high ball
played over somebody standing in, and the slow flat one dropped just over the
net. Both exist now. The fast lob is not forbidden — it is punished by carrying
past the table, which is a consequence rather than a rule.

Two things the scheme will not give you, and says so. A *totally* flat slow ball
is not available: it cannot clear the net, and `solveLaunchClearingNet` lengthens
the flight until it does, so the real floor is "the flattest ball that still
crosses". And from behind the middle line the loft floor binds — the arc there
is forced up whatever the thumb asks — so the axis is remapped into the range
that is legal where you stand (`swipeShot` takes `loftFloor(x)`). A full-down
swipe always gives the flattest ball available *from there*, rather than being
silently overridden and feeling dead. It cannot be used to buy a flat drive from
deep; that still costs coming forward.

The bands are deliberately forgiving: a thumb does not draw a clean 45°, so
anything clearly upward is a lob all the way to straight up, and the shapes
blend across their boundaries rather than switching at them (`swipeShot` and
`SWIPE_BAND` in `src/aim.ts`).

A downward swipe used to aim the kick *backwards*, at a point in the player's
own half — the one gesture in the scheme that could only ever lose the point.
It is now the lob, which is the shot anyone reaching for that direction was
trying to play.

Every aim, and every landing it scatters to, is clamped to `PLAY_BOX` — the
table plus a hand's width of margin. A kick has to be able to miss; it does not
have to be able to reach the crowd, and a ball that leaves the picture is a
worse punishment than the point it already cost. Kept that narrow, every miss
reads as one that nearly went in, which is the only kind worth watching.

Where the ball actually lands is that aim plus a spread (`src/aim.ts`):

```
radius ∝ power × weak-foot wobble × how far the striker had to reach
         × how badly the ball was met
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

The aim is a **standing instruction**, not something re-set every time the ball
comes back. It used to snap to the middle of the opponent's half on every
possession, on the reasoning that a corner should never be inherited silently —
except the marker is on screen for the whole possession, so it never was
silent, and the reset was precisely why the aim was *always* in the middle of
the table. Moving it costs a held press, and a press held long enough to reach
a corner is a lob rather than a drive (`KICK_INPUT.hold` is 0.2 s, and the
marker crosses half the court in about that) — so a target that had to be
re-earned at that price every possession was a target most rallies never left,
and the width of the court went unused. Aim wide once and it stays wide.

The run back under your own set-up hands the stick to the marker as well. The
game owns the feet there, so the stick is doing nothing whatsoever for the
length of a hang, and spending it on the aim costs nothing and asks for
nothing. It is the one moment in a rally with a free control and a decision
worth making with it — and it is only ever a set-up already played, so it never
collides with the reception aim, which is what the stick means during the
settle before a *first* touch.

## The opponent

The CPU's fallibility is three honest, human mistakes, and nothing else: it
reads the drop point wrong (`misjudge`, metres of error rolled once per
inbound ball), it starts late (`reactionTime` is spent standing still before
the run begins, and again before the touch), and it cruises below the
character's top speed. The run delay is the one that makes the others matter —
an opponent that sets off the frame the ball is struck arrives at everything
however wrong its read was, which is what made earlier builds feel like the
CPU retrieved every ball. It still never *declines* to play: a ball put
straight at it comes back, and beating it means making it move. Presets in
`DIFFICULTIES` (`src/ai.ts`), held monotonic by `tests/ai.test.ts`.

It also plays a *shot* rather than a coordinate. Once per possession it decides
what kind of ball to send — wide, deep, a drop just over the net, a fast flat
one, or a high loop — and it decides it against where the player is standing:
stand deep and invite the drop, stand wide and get the ball across you, stand
central and get pace, because there is no gap to find. `tactics` in
`DIFFICULTIES` is how often that choice is made at all rather than the ball
simply being returned somewhere legal, and it is separate from `aimError`,
which only decides how well the choice is executed.

Each intent asks a different question, and the answer is where the player was
standing before the ball was struck: a lateral adjustment, a step back, a sprint
forward, a ball that has to be taken above the waist. The point is not that the
opponent varies — it is that the player learns to *read* what is coming. The
table is deliberately small; the tactical depth this game wants is in what the
player can do with the ball, and an opponent only has to be able to ask the
questions.

Between points both players are walked to where the next point actually
starts: the server to the service line, the receiver to a mark behind their
own — through every serve phase, because outside a rally the stick does not
drive the characters and a walk that stops halfway reads as the player moving
on its own.

## When the queue is empty

A new game's online mode is empty almost all of the time, and an empty online
mode is not a quiet one — it is a dead end. A player taps QUICK MATCH, waits,
and learns that this part of the game does not work. They only need to learn
that once.

So the queue has a floor. It is searched first, for `QUEUE_WAIT_MS` — long
enough that two people tapping within a few seconds of each other still meet,
which is the whole point of having a queue — and if nobody is there, one of the
rivals in `src/rivals.ts` plays instead.

A rival is a name, a shirt with something written on it, a character from the
roster and a way of playing that is theirs. None of that is decoration. What
makes an opponent read as a person is that they are *consistent*, that the one
who hit everything flat last week hits everything flat again, and consistency
is the one thing a difficulty slider cannot give. The four styles are built
from the same knobs the CPU ladder uses; what is new is the combinations, since
a ladder moves every knob together and a person does not. `atLevel` then scales
a style without changing its shape, so a weak technician is still a technician
rather than a generic beginner.

Two limits on where this reaches.

**Only with a connection.** Online play is refused outright on a device with no
network rather than quietly turned into something else. A player with no signal
knows they are offline, so an opponent found there would be transparently
invented, and the deception would be the thing they remember.

**Never in place of somebody real.** The queue is searched first and a rival is
the fallback, so one never takes a match a person was waiting for.

## Asking a friend for a game

A room code works between two people who are already talking to each other. It
is no use at all to two people who are not, which is most of the time — so a
friend on the list can now simply be asked.

The obstacle was never the invite, it was being reachable. A player held a
connection to the relay only while they were in the online lobby or a match,
which is precisely the moment they least need asking, and it is why the green
dot on the friends list meant so little: presence is counted from identified
sockets, so a friend read as online only while they were already looking for a
game. `PresenceLink` in `src/net/presence.ts` is the fix — a connection held
for as long as the app is open that joins nothing, owns nothing and says one
thing when it opens (`hello`, which identifies without asking for a seat).

The invite itself carries almost nothing, because the asker has already minted
a private room and taken the host seat in it. Accepting is then an ordinary
join by code down the path that already works, and an invite nobody answers
costs one empty room that the relay sweeps like any other. The relay checks two
things before forwarding: that the asker is who the token says, never what the
frame claims, and that the two are actually friends — an invite from a stranger
is a stranger reaching somebody who never gave them anything.

Everything it carries is an offer to play *now*, which is why nothing is
queued. An invite that arrives at a socket which has just died is dropped and
the asker is told the friend is not there, because that is true; one that waited
for a socket to come back would be an offer to play at some unspecified past
moment. The link retries quietly for as long as the app is open and never
reports a failure, since there is nothing in it for a player to act on.

## The tour

`src/practice.ts` teaches the sport. This teaches the app, and they are not the
same problem: a rally can show you where to stand, and nothing in a rally can
tell you that the shirt is yours to write on, that a profile is what carries
your trophies to the next phone, or that the game plays differently depending
on which way up you hold it. Those are the things nobody finds by accident, and
the things people ask about first.

Two rules shape it (`src/tour.ts`).

**Every step is finished by doing the thing, never by pressing Next.** A tour
that advances on acknowledgement teaches somebody to tap Next four times. The
kit step ends when there is a name on the shirt; the profile step ends when
there is an account; the tilt step ends when the phone has actually been
turned — whichever way it started, because insisting on landscape is a step
somebody already holding it that way cannot finish. What the player is left
with is a shirt with their name on it and the memory of having done it, rather
than a screen they read.

**It points at one thing at a time.** A ring around the element and one
sentence under it. The ring carries the dimming itself in a box-shadow spread
wider than the screen, so there is no mask and no second element, and nothing
on the layer takes the pointer except the button that leaves — an overlay that
swallowed taps would make its own instructions impossible to follow. It is
re-measured every frame rather than placed once, because these screens are
rebuilt from their markup whenever they are shown and the phone can be turned
mid-step.

Nothing in the tour advances the tour. `main.ts` reports what is true — is
there a profile, is there a name on the shirt, has a setting been touched,
which way up is the phone — and `Tour` decides from that whether the current
step is done, so there is no path by which a step completes without the player
having done it. Those four facts change in four different places, which is why
they are polled rather than watched: four subscriptions would be four ways for
the tour to get stuck, and asking is one.

A step the player has already satisfied is skipped rather than demanded.
Somebody who made a profile before opening this has learnt what that step
teaches. It is what the first launch opens with, in place of the stack of cards it used
to show. Cards are read and dismissed, and what survives the dismissing is
nothing; this leaves a profile, a name on a shirt, and the memory of having
made them. It lives in settings afterwards as something to replay.

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

The world freezes while the coach talks — **once per step**. Each lesson stops
the world the moment it becomes relevant, says its one sentence, and never
interrupts again: the instruction (and the input it needs) lives on in the
corner panel, where it can be re-read without a live ball being stopped for
it. The first version paused on every possession until the step was passed,
which turned a missed strike into the same card three rallies running.

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

## The first launch, and the menus over the court

A new player gets the title screen and a short skippable tour
(`ui.showUiTutorial`), gated on one `coached` flag in `src/settings.ts`. The
tour is four cards on a desktop and five on a phone: the extra one says the
game plays **both ways up**.

That card exists because the feature was real and completely undiscoverable.
Portrait moves by tapping the court and kicks with a swipe, landscape has a
stick and two buttons, `Input` swaps between them live on `orientationchange`
so turning the phone mid-rally works — and nothing on any screen had ever said
so. The dots under the cards are built from the steps rather than written into
the markup, so a tour that is sometimes four cards and sometimes five cannot
lie about how much is left.

The menus themselves stand on `#menu-backdrop`. The screen transition irises
open and shut with `clip-path`, and outside that circle nothing in the DOM
paints at all — so for the length of the animation the only thing on those
pixels was the game canvas, which draws the live arena every frame whether a
match is on or not. Back-navigation was the worst of it: a 380 ms collapse to
nothing followed by a 540 ms reveal from nothing, most of a second of bare court
between two menus. The backdrop is one element under every screen, painted with
the same gradient the screens use, so the iris opens onto more of the menu. The
four screens that genuinely want the 3D behind them — the HUD, the picker with
its model viewer, the result card and the pause card over a live match — call
`showSceneBehind()`, and everything else gets it by default, because a new menu
should have to opt out of covering the arena rather than remember to opt in.

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

| | Pixel ratio cap | MSAA | Shadow map | Venue backdrop | Players and balls |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | 1.0 | off | 1024 | loaded | lite copies |
| HIGH | 2.0 | on | 1024 | loaded | full |

**Phones draw lighter players.** The player models were 90k–190k triangles
each and the balls up to 44k, and a match draws both players twice (the shadow
map is a second pass over them). A Samsung A20e ran a match against the AI at
sixteen frames a second with over a million triangles a frame, and the pixel
ratio cap had nothing left to give: it was already rendering 780×360. The build
writes a lighter copy of each (`scripts/lite-models.mjs`, between `vite build`
and asset protection): meshoptimizer's simplifier to about a sixth of the
triangles within 1% of the model's size, and textures capped at 512px, which
also takes a player's textures from ~50 MB of GPU memory to ~12 MB. The medium tier loads
the copy and falls back to the full model where there is none — every dev-server
session, since the copies only exist in a build. A gym frame drops from about
750k triangles to 250k; connection stats show the count. The arenas are not
thinned: their triangles are thousands of separate seats and boards, the
simplifier could only reduce a piece by eating it, and locking the pieces'
edges saved nine per cent.

There was a third tier below these. LOW dropped the venue backdrop to save a
1-5 MB download, which meant the venue a player had chosen did not appear — too
high a price for the framerate it bought. A stored or requested `low` now
resolves to `medium`.

### The look

Both tiers render through **ACES tone mapping** (`scene.ts`), applied in the
material pass rather than as a post-process — highlights roll off instead of
clipping, which is most of what separates "3D viewport" from "broadcast" on a
scene of flat saturated colours. It darkens, so the exposure buys the level
back; grade with both hands or with neither. Shadows are PCF rather than the
exponential map, whose filtering smeared every contact into a grey blob that
never quite touched the feet.

Two model repairs worth knowing about, both in `loadTable`/`fixMetallicMaterials`:
several exports leave glTF's default `metallicFactor: 1` on materials with no
environment map, which renders as a black mirror — the table read as a burnt
slab from every camera until it got the same repair the balls already had. And
the table's dark materials have their albedo pulled down and their sheen
flattened, because under the outdoor rig's three suns' worth of light the
export's charcoal renders mid-grey, and the real table — checked against
broadcast footage of the 2022 World Championships — is matte near-black with
the white trim and orange legs doing the talking.

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

## What a competition is worth

A cup is two matches and a league three, and until recently finishing one paid
exactly what those matches paid on their own: winning the trophy was worth the
same as winning the third-place play-off, and a cup was indistinguishable from
two friendlies at the same difficulties. The champion was a line of text.

`competitionPrize` in `src/league.ts` pays for the run itself, once, on top of
its matches — by format, because a league is the longer sitting, and by
finishing place. Second and third still pay: getting to a final and losing it
is a good run, and a competition that paid only the winner would teach a player
to abandon a cup the moment the semi went badly. Fourth pays nothing extra,
because a prize for coming last is not a prize.

The screen between rounds carries a running total of what the run has earned so
far, which is the one thing a competition never used to say. It is a line, not a
result card: a full card between every round would turn a cup into a series of
receipts, which is why the per-match card is suppressed there in the first
place. Winning the whole thing brings out confetti — DOM and CSS, like the
title screen's drifting motes, because the project has no particle system and
one competition every twenty minutes does not justify introducing one — and
finally calls `cheerCrowd()` and `playApplause()`, both of which already existed
and were wired only to individual points.

## A competition you can put down

A cup is three matches back to back and a league is three rounds, which is a
long sitting on a phone — long enough that it will routinely be interrupted by
a bus stop, a phone call, or the battery. Both used to live entirely in closure
variables in `src/main.ts` and die with the page.

They are written to `localStorage` between rounds now (`src/competition.ts`),
and the competition menu offers the run back before anything else on it. Not on
the title screen: PLAY is the only thing that screen says, and a competition the
player may have forgotten about is not worth breaking that for.

Between rounds, never during one. A round is the unit the competition already
thinks in, and the alternative — snapshotting a live match — means serialising
the ball, the characters and the rally state and keeping all three in step with
every future change to them. Quitting mid-match therefore costs that match and
nothing else.

Only ids are stored, never whole `CharacterDef`s: those carry career level and
traits that are recomputed on load, and a saved copy would go stale the moment
the player levelled up. The draw *is* stored, because it is shuffled once when
the run starts — re-rolling it on resume would hand the player a different
tournament from the one they were halfway through. Anything that does not parse
into a complete, self-consistent run is treated as no run at all, which
`tests/competition.test.ts` pins: a tournament with the wrong opponents or the
wrong score is worse than being told the saved one is gone.

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

**Characters** (`src/progress.ts`). The roster is a **ladder**: BRAZIL is free
and is the weakest player in the game, and each unlock above them — ENGLAND at
60 trophies, FRANCE at 160, SPAIN at 300 — is plainly better than the one
below. Not "differently good", better, and `totalPower` on the card says so.
That is a deliberate reversal of how it used to be. Four equals give a player
nothing to want, and everything else in the career — the trophies, the coins,
the levels — hangs off wanting the next one.

They still have shapes, or the ladder is one number four times: ENGLAND is a
hammer with no acceleration, SPAIN is quick and technical, FRANCE is even.
`tests/config.test.ts` holds both halves of that — every rung strictly above
the last on total power, and every rung giving something up somewhere.

Playing with a character levels it slowly (five matches); coins level it now,
and the first level costs about two wins. A level lifts precision most —
that is what the kick spread divides by (`src/aim.ts`), so an improved player
is one whose hard kicks stay in — and agility, stamina, a little speed and
reach with it. Power and the serve are left alone: they are what make ENGLAND
ENGLAND, and training out of them would flatten the roster back into one
character. The roster unlocks against the *best* trophy count ever reached, so
relegation never takes a character away from someone who already earned it.

Because the roster is a ladder, the CPU opponent is no longer drawn at random:
`matchedOpponent` in `src/main.ts` weights the draw toward the rung nearest
the player's own total power. A beginner handed SPAIN would be playing someone
better at everything, and the difficulty they picked would mean nothing.

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

## Legs, and what is sold for them

Stamina is the one trait a match takes away from you, and it is a **one-way
ratchet**. A player carries two numbers (`src/character.ts`): `effort`, what is
in the legs right now, and `reserve`, the ceiling recovery can reach. Running
costs both. Standing still buys back some `effort` — never `reserve`, which
only ever falls.

That is the whole model, and it is what stops a match being a sawtooth. Without
the ceiling, resting returned a player to exactly where they started and every
point was independent; with it, the first set is genuinely paid for in the
third. Measured over a full match of ~3.5 s of chasing per point:

| | fresh | 3 points | 6 | 9 | 12 | 15 |
| --- | --- | --- | --- | --- | --- | --- |
| legs left | 100% | 90% | 80% | 69% | 59% | 49% |

A player who chases absolutely everything can empty the tank inside a rally and
reach the floor (`MIN_EFFORT`), which is about a third of their pace with the
acceleration penalty on top — they can still reach a ball played at them, and
no longer one played away from them. `MIN_RESERVE` stops a long match ending
with two players unable to cross their own half.

Most of the cost is acceleration rather than top speed. A model that took real
reach away would make one brave point lose a whole game, and attacking already
means coming forward and getting back; the top-speed term exists so the drain
is visible in a straight chase, which is where a player actually notices they
have run out. The HUD bar shows both numbers — the fill is `effort`, and the
hatched part on the right is the reserve this match has taken for good, so
nobody waits for a bar that is never coming back.

The shelf (`src/supplies.ts`) is **three** items, down from five. The old one
had two drinks and two supplements that differed only by how much stamina they
bought, which is four prices for one decision. What is left is one of each kind
a player can tell apart: ISOTONIC is fitness, DOUBLE ESPRESSO is fitness *and*
sharpness, and RECOVERY PROTOCOL is the permanent one you save up for. Each
carries a `boost` over several traits rather than stamina alone, applied
through `withSupplies` — shaped like `withBall` and `withCareer`, so the
physics, the AI and the card all read one already-modified `CharacterDef`.

Deliberately no `power` on the shelf. Pace belongs to the character and to the
ball; a shop that sells a harder ball is a shop that decides matches.

## Protecting the art

**The art is not in this repository.** That is the load-bearing part, and it is
worth stating before the cryptography, because for most of this project's life
the cryptography was the only part and it protected nothing.

`assets/` was committed in full — 39 MB of plaintext `.glb`, plus the Mixamo
`.fbx` rigs and the crowd's `.vat` bakes. `scripts/protect-assets.mjs` ran over
`dist/`, which is never committed, so the encryption applied only to build
output while the originals sat in git beside it. Making the repository public
would have handed over every model with one `git clone`. No cipher fixes that,
and no amount of care reading the code was needed to defeat it.

So the models, textures, venue cards, audio and video are gitignored and live
in an encrypted bundle in private storage:

```sh
ASSET_BUNDLE_URL=… ASSET_BUNDLE_KEY=… npm run assets:fetch   # get the art
ASSET_BUNDLE_KEY=… npm run assets:pack                       # publish a new bundle
```

`assets.manifest.json` **is** committed. It is paths, sizes and SHA-256 digests
— it gives up nothing, and it turns a truncated download into an error at fetch
time instead of a texture that silently never appears. The Exo 2 fonts and
`meshopt_decoder.js` stay committed too: an OFL font and a public third-party
script are not anybody's to withhold, and the page needs both to render.

A clone with no bundle still typechecks, lints, passes all 674 tests and builds
with `npm run build:plain`. It cannot produce a *playable* build, which is
deliberate rather than an oversight: these are licensed packs whose terms
forbid redistributing them in a form other tools can open.

Raw art also lives in `art-source/` rather than `assets/source-animations/`,
because Vite copies all of `publicDir` to the root of `dist/` with no way to
exclude a subdirectory. While the rigs sat there, every deployed build served
them at `/source-animations/crowd/Idle.fbx` — unencrypted, and the most
directly reusable files in the project.

### The cipher

`scripts/protect-assets.mjs` encrypts everything under `dist/{models,textures,
venues,video,audio}` into `.teq` files at build time, and `src/protected.ts`
decrypts them on the way into Babylon, the audio element and the DOM. It covers
**every shipped asset**, not the `.glb` files alone — encrypting the models
while serving the music and the venue photographs in the open beside them
protected the expensive third of a build and left the rest in a folder for
anybody who typed the path.

It is **AES-256-GCM**, through WebCrypto: real, authenticated encryption. An
encrypted asset is indistinguishable from random bytes — no header to
recognise, no structure to guess at, nothing to unpick from the file alone —
and a single altered byte fails the authentication tag rather than decrypting
to plausible rubbish. Each file gets a fresh random IV, which GCM requires and
which matters here because these files come in groups sharing a header byte for
byte: the glTF magic on every model, the WebP one on every texture. The cost is
28 bytes per file and, on the hardware AES every ARMv8 phone has, a fraction of
a second across the whole 43 MB set.

`VITE_ASSET_KEY` sets the passphrase, and there is **no fallback**: both halves
refuse to run without it. There used to be one — `"teqrallly-default-key"`,
written in this repository — and since no workflow ever set the variable, it
was the passphrase every shipped build actually used.

The scheme exists twice — `scripts/scramble.mjs` for the build, which runs
before a bundle exists, and `src/protected.ts` for the game — and both the
cipher *and* the list of protected extensions are duplicated.
`tests/protected.test.ts` crosses that boundary for real: Node encrypts,
WebCrypto decrypts. Cipher drift fails as every asset refusing to load at once.
List drift is worse because it is partial — an extension the build encrypts and
the game does not is a 404 in release builds only, with nothing in any log to
say why, which is exactly how the `.glb` prefetches in `src/main.ts` went
unnoticed through twenty-odd releases.

### What this does and does not achieve

**The honest caveat is key distribution, not the cipher.** A packaged game has
to decrypt its own assets on a phone in a tunnel, so the key ships inside the
bundle, and anybody willing to read the JavaScript and drive WebCrypto
themselves can recover it. That is a property of client-side decryption in
general, not of this scheme: the only design without it is one where the assets
never reach the client in usable form, which for a WebGL game does not exist.
**Nothing here makes a build unrippable, and it should not be described as if
it did.**

What it does buy:

- a `.teq` is noise, so nothing is one rename away from being openable;
- the key cannot be recovered from the *files*, only from the bundle, which is
  a far higher bar than reading a header;
- tampering is detected rather than silently loaded;
- the licensed packs are not distributed in "a file format usable by any 3D
  application", which is the specific thing their licence forbids.

And the part that is *not* a caveat: reading this repository, however
carefully, yields the scheme and no art to apply it to.

### Purging the history

Removing the art from the working tree does nothing on its own. `git clone`
reconstructs every commit, so the 67 MB stayed fully available from the fifty
commits behind the tip. `scripts/purge-art-history.sh` rewrites every ref to
strip it, and must be run before the repository is made public:

```sh
./scripts/purge-art-history.sh           # rewrite and verify, push nothing
./scripts/purge-art-history.sh --push    # then force-push branches and tags
```

Two things about it are easy to get wrong and both are silent. **Tags count**:
this repository has ~70 `build-*` tags, and one left pointing at a pre-purge
commit keeps that entire history reachable and buys nothing. And **a normal
clone here is shallow** — rewriting one gets the recent half of history and
leaves the rest, which is why the script mirror-clones.

Run it while the repository is still private. GitHub keeps unreachable objects
after a force-push and serves them to anyone who knows an object SHA; while
the repository is private nobody outside can have learned one, so purging
first closes the window completely. Purging after going public does not, and
takes a support request to finish.

Every existing clone is stale afterwards and must be re-cloned. A `git pull`
onto the old history merges the two and puts the art back.

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

**The code alone is enough.** It is unique to one profile, and the person
typing it has just lost the phone that knew anything else about the account —
so asking for a player id beside it meant somebody holding the slip they were
told to write down still could not get back in. An unsalted lookup digest
beside the salted one is what lets a code find its own account, the same way a
token finds its own. Accounts issued before that index existed still accept an
id as a way in, and heal the first time they are recovered, because recovering
mints a fresh code.

Neither secret is stored as it was issued (`server/secrets.mjs`). The token is
kept as a plain SHA-256 because it is also the lookup key and has 192 bits
behind it; the recovery code keeps its salt for the digest that *proves* it,
because it is short enough for a person to type. The lookup digest beside it is
unsalted, which lets a leaked table be attacked once rather than once per row —
and at sixteen Crockford characters it is eighty bits either way. A database
snapshot that leaks should not hand anybody every account in the game.

The typed code is forgiving about case, hyphens and spaces, and folds the three
letters Crockford's own decoder folds — O to zero, I and L to one. Not Q: an
earlier version folded Q to zero too, and `tests/accounts.test.ts` caught that
every minted code containing a Q could never be typed back in.

The restore field does that folding **as it is typed**: upper-cased, and the hyphens appearing as each group of four fills (`formatCodeField`). A code is written down in one shape and should be typed back in that shape, rather than the player reproducing the punctuation from memory and being told afterwards that they got it wrong.

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
multiplier on a spread radius — into seven traits on a 0–100 scale, plus a
TOTAL POWER that is just those added up.

**The bar is marked out of 100 and stops at 99, and 99 is reachable.** It used
to stop at 95 on the reasoning that a reachable top stops saying anything the
moment somebody gets there. The trouble was that the top was not merely hard to
reach, it was unreachable: across four characters and seven abilities exactly
one combination ever touched it, because levelling did not move `power` or
`serve` at all and the rest gained too little to cross their spans. A ceiling
nobody can approach is not tension — it is a bar that stops moving while the
player keeps playing.

So every ability now reaches the top on every character, at `MAX_LEVEL` (12,
about fifty-five matches). What the roster ladder decides is **how long that
takes**: FRANCE saturates at level 8, SPAIN at 9, BRAZIL and ENGLAND not until
12. A head start, not a different ceiling. The last point stays unsold, because
a 100 would invite the question of what comes after it. The floor is 40, so no
bar reads zero.

Training is clamped to the top of the bar that reports it (`SPAN` is exported
for exactly this). Without that clamp a character whose card already read 99
went on quietly getting faster for another three levels — SPAIN reached 8.37 m/s
against a 6.6 ceiling — which is power the player can feel, cannot see, and
could not have been told about.

Because a maxed player is 693 total power and the strongest thing on the roster
*starts* at 486, `matchedOpponent` now trains the CPU to the player's own total
as well as picking a character near it. Otherwise the reward for a long career
was that the game stopped resisting.

The span each trait is measured against is **fixed** rather than derived from
the roster. Deriving it meant every number on every card moved whenever a
character was added or retuned — a player who had trained BRAZIL to 71 CONTROL
would open the game after an update to find it said 64, having lost nothing.
Fixed bounds also leave headroom above where every character *starts*, which is
what makes the ladder legible: SPAIN begins near the top of the bar because
SPAIN is near the top of the roster, not because SPAIN defines it.

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

The venue tab shows a **still** of each venue (`assets/venues/*.jpg`) rather
than building the arena to be looked at: a 4.8 MB download to answer "do I
fancy playing there" is the wrong trade for a decision made in two seconds. The
stills are photographs of the real scene, regenerated by
`node scripts/venue-cards.mjs` against a running preview server — re-run it
after touching the venues or the lighting, or the picker keeps advertising a
game that no longer looks like that. On the locked venue, PLAY becomes UNLOCK —
the screen showing what you cannot have is the screen that should sell it.

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
snapshot at 30 Hz; the other sends its controls every step and applies what
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

**The faster device hosts.** The host runs the only match, so its device sets
the pace for both screens — the same two emulators looked fine one way round
and like chaos the other, depending only on which one hosted. Each peer measures
its frame rate before the match and sends it on `setup` (`perf`), and
`chooseAuthority` in `src/net/protocol.ts` gives the match to the faster one:
symmetric by construction, a tie or a missing value keeping the relay's seats.
The relay's seats still decide who mints a rematch's match id, and whose ball
is used.

**A match never drops time it can afford to catch up.** The render loop used to
cap every frame at `MAX_FRAME_DT` (50 ms) and throw the rest away, so a device
drawing fewer than twenty frames a second ran the match itself slower than real
time. The simulation is cheap beside drawing a frame, so a match may now catch
up to `MAX_CATCHUP_SECONDS` per frame; only longer stalls still drop. The
connection stats overlay (a setting) shows frame rate, simulation speed and
dropped time on both screens, which is what tells a slow device from a slow
link.

**One clock: a match's animations are placed on simulation time.** Babylon used
to play every clip on the render loop's own delta while the ball, the positions
and the contact countdowns stepped in simulation ticks. They agreed only while a
device kept up, and every correction in this netcode's history — restating clip
windows, steering clips toward them, hurrying wind-ups — existed because they
did not. A match character's clips are now *placed*: a start tick, a start frame
and a rate, the frame at any tick being arithmetic (`src/animclock.ts`). Groups
are paused and set frame by frame from `Character.update` — a paused group holds
a frame and still blends by weight, which a group at speed zero does not.
Locomotion loops are integrated by game time. The carousel, the viewer and the
volume inspector keep Babylon's clock (`useSimClock`). The host places clips on
its step count; a guest places the host's clips on the host's ticks, so the
frame on its screen is the host's frame whenever the decision arrived.

**A guest draws the host's past, at the host's pace.** Arriving frames join
`PlaybackBuffer` in `src/net/playback.ts`, and the ball, both characters and
every clip are read off its clock. That clock used to be led *ahead* to the
instant the host was playing, which meant guessing — every kick, turn and bounce
not yet reported was drawn wrong and corrected, and it was measured as players
trailing and lurching and balls bending. A guest now draws a measured interval
behind its best-routed frame (`usePlaybackBuffer`): a snapshot interval, the
ninetieth percentile of arrival jitter and a tick, between `PLAYBACK_BUFFER_MIN`
and `_MAX`. Remote characters are interpolated between real frames, and every
decision is in hand before its tick. The clock runs at the host's *rate*, fitted
over five seconds of arrivals (`fitRate`), so a host that cannot keep its match
on real time looks slow rather than chaotic. The guest's own player is still
predicted and instant, and the host judges its presses against the instant it
was showing, a round trip plus the buffer back (`viewTick`).

Leading was tried first, and for a reason: a guest drawn behind the host, with
its own player drawn live, used to have every press after the first touch
judged against a ball a trip later than the one it saw. The rewind (`viewTick`)
is what made drawing behind playable.

**That sum is where the clock should be, not what it is.** It used to be both:
`newestTick + lead + steps since it arrived`, recomputed every step. That is a
clock only while frames arrive on a perfect grid, and a phone's never do — one
lands a step late, the next a step early, and every arrival re-anchored the
sum. Measured under ordinary jitter, the instant on screen went backwards on one
step in fourteen and jumped by as much as nine ticks, and the ball and every
clip were drawn off it: most of what looked like unsteady physics on the guest
was the clock. It now advances one tick a step and is aimed by the
*best-routed* recent frame rather than the newest (`CLOCK_WINDOW_ARRIVALS`),
because a late frame says only that the route was slow. Inside
`CLOCK_DEADBAND_TICKS` it does not lean at all, and beyond it never more than
`CLOCK_MAX_SLEW`. A first version leaned toward every arrival by up to eight
per cent, which is invisible as speed and very visible as timing: the ball runs
on this clock and the animations on the renderer's, so a seventy-tick wind-up
became sixty-five on one and met a ball that had already gone. The lead it is
set by is the one-way trip converted to *simulation* ticks at the host's speed —
`latencyTicks` counts sixtieths of a second, and a match at 1.25 runs
seventy-five ticks in one. It jumps forward when it is too far behind to lean
(`CLOCK_SNAP_TICKS`) but not back: a clock ahead of the sum is almost always one that kept counting while
frames were stuck behind a slow one on the socket, and when they all land at
once the newest of them is still old — the clock was right, and snapping to the
stale sum rewound the whole screen a quarter of a second after every hiccup.
Only a gap no stall explains (`CLOCK_REWIND_TICKS`, a reconnect) is taken back.

**A frame is stamped with the step it arrived in, not the step after it was
read.** The clock measures routes in steps, which assumes steps keep real time,
and on a slow phone they do not. At sixteen frames a second, the snapshots that
arrived during one frame were applied before the four or five steps that frame
then ran, so each looked a few ticks better routed than it was; after a stall
long enough to drop simulation time, dozens of them looked a whole stall better
routed, and the rate fit read the lost time as a fast host. One 700 ms stall ran
a guest's clock twenty ticks into the host's future — every touch arrived after
the screen had passed it and was replayed — and it took fifteen seconds to lean
back. An A20e showed exactly that: a gap of −37 ticks, 42 replays and 44
re-anchors in one match. Now the game loop tells the session what wall time each
step stands for and a snapshot waits for its step (`deliverUpTo`); a frame
better routed than anything recent by more than `CLOCK_SNAP_TICKS` means this
device's steps lost time, so the history before it is dropped rather than fitted
across; and frames landing on one step count once. `a slow guest` in
`tests/playback.test.ts` replays the stall. The host's decisions wait in the
same queue, in order: a snapshot with the ball in a hand ends the flight and
drops every decision queued before it, so an older one applied after a newer
toss would wipe the toss.

**Both phones play at the host's speed.** Gameplay speed is a per-device
setting, and it sets how many simulation ticks a second of wall time holds and
how fast every animation runs. A guest on 1.45 against a host on 1.25 stepped
its playback clock sixteen per cent faster than the frames it was reading. The
snapshot carries the host's `ts`, the guest adopts it for both the simulation
and `scene.animationTimeScale` until the match ends, and a change made in
settings mid-match is saved but only applied after it.

**The host sends decisions, and the guest plays them itself.** Everything
that moves on a guest's screen is either a decision somebody made or the
consequence of one: a limb meets the ball, a body deflects it, a server tosses
it, a clip starts. Between decisions the ball is nothing but `stepBall`, and the
guest has the same code, the same models and the same clips as the host. So a
guest is no longer *shown* the ball and the swings, re-placed thirty times a
second from snapshots; the host sends each decision (protocol 5: `launch` and
`clip`) and the guest flies and animates from them on its own clock
(`src/net/guestball.ts`, `applyGuestClips` in `src/match.ts`).

What crosses is the *outcome* of a decision, never its inputs. A guest that
re-derived a kick from a direction and a power would disagree with the host
within a touch: the clip choice sits on height thresholds, and the launch used
to be read off the striking bone's position, which is wherever that device's
animation happened to be. The earlier authority-handoff design above is what
re-deriving looks like.

**Every kick used to arrive dated wrong.** A kick is
published when the swing starts, for the tick the limb arrives — and
`NetConnection.send` stamped every outgoing message with the tick it left on,
over the tick the message named. So the guest turned the ball a whole wind-up
early, and the next snapshot dragged it back: 106 re-anchors in two minutes of a
real two-client match, and it looked like balls that never touched a limb and
flights that bent. Every test passed, because every fake connection passes a
message through untouched. `send` now keeps a tick the message names. It was
found by running two real clients against the local relay with rendering
switched off, and checking on the host that the ball keeps every launch it
publishes while the guest counts re-anchors — the check to repeat when anything
between `drainNet` and the socket changes. A healthy match re-anchors zero
times.

**A kick is decided when it is committed, not when it lands.** `tryStrike` and
`tryControlTouch` now work out the launch the moment the touch commits, from
where the ball's natural flight and the lunge will put things on the contact
tick (`beginContactLunge` steps the flight exactly as many times as `update`
will before the countdown fires), and the contact countdown counts whole ticks
so that tick is known at commit. The contact fires from that countdown only —
the clip's own contact frame is on the render clock, and a launch that could
come from either would leave on a tick nobody was told. This applies offline
too: the ball now leaves from its planned contact point rather than being
snapped onto the bone. If something knocks the ball off the path the decision
was made for (`SHOT_PATH_TOLERANCE`), the contact is decided again and sent.

The wind-up is the head start. A touch commits between a tenth and four tenths
of a second before its limb arrives, and a trip between two phones is usually
shorter than that, so the decision reaches the guest before its tick and the
guest's ball turns on the same tick as the host's. A decision that arrives after
its tick — a toss, a deflection, a touch with less notice than the trip — is
applied where it belonged and the flight replayed from there, and the
difference to what was on screen fades out over `GUEST_BALL_FADE_SECONDS`
rather than jumping. That is the one part no design can put on time on a real
link: a wind-up shorter than the trip was over before anyone could have been
told.

Every host step a body changed is published, not only the ones that fire a
"body" event. A ball arriving inward bounces and says so; a ball resting or
rolling against a player is pushed back out every substep in silence. The host
compares its step with a collider-free one and publishes when they differ,
flagged `settled` so the guest applies it to the end of that tick as well as
the start of the next.

Snapshots still carry the ball, as a check rather than a source. A snapshot that
disagrees with the flown ball at its own tick by more than
`GUEST_BALL_DIVERGENCE` means a decision went missing, and it becomes one. The
session sends a step's decisions before that step's snapshot, so on an ordered
socket the check can only fire for something genuinely missed; `reanchors` is
counted, and the integration tests hold it at zero. The guest flies the ball
without body colliders: a deflection is a decision the host sends, and a guest
bouncing its own ball off the bodies it draws bounced it off strikers whose
clip had not reached its screen yet — bodies the host exempts.

**Characters ride the velocity the host reports for them**, not a difference of
the positions it reports — and they are *moved* by it, with only the leftover
error corrected over `FOLLOWER_CORRECT_SECONDS`. The correction used to be the
whole of the motion: a fixed fraction of the gap to the timeline per step,
which a player running faster than that fraction covers can never close. The
one on screen settled a full `speed × time` behind the one on the timeline —
measured at 37 cm one tick in ten and 90 at worst — and caught up in a lurch
the moment they stopped or began a touch, which is what a guest saw as players
teleporting.

The wire value is `Character.velocity`, already eased
on the way up and exactly zero the step a run reaches its target; a backward
difference of two 30 Hz positions lags that stop by two ticks and then has the
stale speed multiplied by the lead. That is what sent a joined player sailing
past the end of every run to a drop spot and snapped them back — on the one
movement a reception is made of. The carry is capped at
`MAX_CHAR_CARRY_METRES`, because extrapolating a body is a guess whose error
grows with the square of how far it runs.

**A clip is started once and then simply played.** A `clip` decision says
which clip, from which fraction, at which rate, on which tick, and the lunge
that goes with it. The guest starts it when its clock reaches that tick and lets
its own animation system play it to its own end, exactly as the host does — no
window to hold it to, no steering, no re-seating, no cut-off when a window
closes. A clip cut short on the host is its own decision (`clip: null`). The
lunge is applied locally too, because the half-metre dart that puts a limb on
the ball is far too quick for a 30 Hz position feed to draw.

A clip also carries where the character stood when it began (`at`). The host
moves a player mid-touch by the contact lunge and by nothing else, so for the
whole of a clip that player's place is exactly known, and the guest glides its
player onto it — along the lunge when there is one, otherwise over
`GUEST_SETTLE_SECONDS` — before the limb meets the ball. Without it a player
was kicked from wherever a 30 Hz feed had last carried them: measured twenty
centimetres off for a whole kick after a direction change no frame had reported
yet, with the ball arriving at the host's foot beside it. And a busy player is
held there, not re-read from the timeline, whose carry past the end of a lunge
overshot the spot by up to forty centimetres in a tick.

Every clip is published, not only the touches. `CLIPS` lists the clips with a
contact to time, and it used to be where a clip's length was read — so the
match-win celebrations, which meet no ball and are in no table, were never
sent, and the guest's winner stood still at the final whistle. The animation's
own frame range is the length of anything the table does not know.

A clip decision is made the instant the clip starts. It used to reach a guest
drawing ahead a trip late, and was hurried or started part-way in; drawn from a
buffer, it arrives before its tick and is simply placed.

**Every touch meets its limb.** `reachableContact` decides at commit where the
striking limb will be at the contact tick — the measured offset from the root,
at the spot the lunge will stand the player, so no live skeleton is involved and
both screens compute the same point — and bends the last `CONTACT_BEND_TICKS` of
the flight onto it. The bend is published like the kick itself, and the kick
launches from the limb. A touch with no tick left to bend over leaves from where
the ball is. The old game instead teleported the ball onto the live bone, a
different place on every device.

Measured while doing this, and not yet fixed: across long rallies of both seats
nearly half of all touches commit with the limb a quarter of a metre or more
from the ball — a ball still above the limb it was chosen for, or one already at
the body with a tick of notice. Refusing those took rallies from eleven touches
a point to three, because positioning (`dropSpot` aims at chest height), the
reach tests and the AI were all tuned around the teleport. Until that is
reworked, big gaps show as a visible bend.

**A press is judged against the ball the player was looking at.** The guest
stamps every input frame with the host tick its screen was showing
(`viewTick`), the host keeps half a second of ball positions, and the two
decisions a press turns on — whether the ball was in reach, and which limb the
height band picks — are read at that instant instead of the one the packet
landed on. The contact itself is planned and struck against the live ball: the
rewind decides *whether* and *with what*, never *where*. At rally pace a few
ticks of fall is a whole band, which is why a joined player kept meeting a knee
ball with a foot; the second seat used to be handed a silent 15% of extra reach
to paper over it, which widened the window without aligning it.

The automatic first touch is not a press, and is judged live (`judgeLive`). It
was judged through the same rewind, and asked every step whether the ball the
guest last saw was in reach, the host said yes a round trip and a buffer after
the real ball got there — a third of a second on a phone link, by which time it
had gone past. On two real clients over 95 ms each way with nobody on the
controls, the host's seat received 7 serves of 7 and the guest's 0 of 8; the
guest's player walked toward every serve on the reach assist and never touched
one. The clock that ran into the host's future had been hiding it, by making
the rewind zero.

**A clip that ends lets go of its name.** `finishAction` is the exit almost
every clip takes, and it used to leave `actionClip` set — so
`currentActionClip` went on naming a finished animation until something else
started one. A host publishes that name in every snapshot, so its guest was
told a character was mid-touch long after it had stopped: a clip it could not
play and could not let go of, and a body it would not predict for because the
name said it was busy. The name is now cleared wherever an action ends.

**A guest's clip ends back on its feet.** `stopAction` stops the group without
restoring the locomotion weights `playAction` zeroed on the way in, so a clip
that is stopped rather than allowed to finish leaves nothing driving the
skeleton and the character frozen on the frame it was cut at. Offline that is
rare, because clips almost always run to their own end. On a guest steered by
windows it was the *only* way a clip ever ended — the host's window said when —
which is why a joined player was walked back to the service line still holding
the pose of a kick. Both the guest and `stopSideAction` use `cancelActionToLoco`
now, and a stop decision goes through it too.

**A rematch ignores the finished match's last frames.** Both peers restart the
moment it is agreed, for responsiveness, so whichever resets first spends a
trip receiving snapshots that still say "over". Applying them puts the old
score back on the board and blows the final whistle a second time, which is the
result screen reappearing over a rally that has already started. Frames are
dropped until the host sends a phase that is not "over", bounded at two seconds
so a rematch the other end never began still comes back to life.

**The prediction runs the host's motion model, not a bare stick.** The host
bends the guest's push onto the contact point and leashes it to the reception
zone, both aimed at `anchor`, and roots the player entirely while a kick is
being lined up. A prediction that skipped all three did not drift by noise
`reconcile` could absorb — it regenerated the whole of the assist every step,
so the correction chased a gap it could never close. The anchor and its eta
ride on the snapshot so both ends integrate the same equation.

**Both players see each other's kit, and each other's name.** The `setup`
message carries the three marks that belong to the player rather than to the
character — the name across the shoulders, the number, the crest — and
`kitForCharacter` supplies the colours from the roster at each end. So there is
nothing a peer can send that would paint somebody else's shirt a colour their
character does not own, and `readKit` applies the same length caps the settings
screen does, because the other end is not a text field. The scoreboard then
shows the name off the shirt where there is one, falling back to the name the
relay verified. A kit nobody else can see is a kit worth nothing, and online is
the only place there is anybody else to see it.

**A serve is decided at the toss.** The toss and the strike used to be
callbacks on the serve clip's own frames, which run on the render loop, so the
tick a serve left on depended on how that device's frames fell. They are counts
of simulation steps from the start of the clip now (`serveCountdown`), so the
strike's tick is known at the toss — and the aim stops following the stick at
the toss, so the serve itself is known there too and is sent a quarter of a
second before it leaves (`serveVelocity`). That last part is a rule change,
offline as well: the aim was live until contact, and the quarter-second the ball
is in the air was the only part of it that could not be sent in time.

**An arrow hangs over whoever is about to serve.** Two players on two phones
cannot see the other pick the ball up, and which end the next serve comes from
was readable only off the scoreboard, which is the wrong place to be looking in
the second before a ball is struck at you. It is read from `serveOwner` and the
phase, both of which a guest already holds in its own frame, so it needs
nothing on the wire and says the same thing on both screens.

**A match pays both players, and pays whoever asked first.** A result settles
only when both sides have reported it, and both report the instant the match
ends — so whichever request arrives first is told to wait, and it is a coin
toss which player that is. The server now keeps each side's outcome when it
settles, and the waiting client comes back for it (`SETTLE_RETRIES`), which is
the difference between a winner being paid and a winner watching their opponent
get paid. The other half of the same bug was the guest reporting no points at
all: it counts none itself, and a win with no points behind it is a result the
server refuses as impossible, so neither side was paid. The tally rides the
snapshot now.

**A serve nobody plays does not stall the match.** Against another person the
server has `SERVE_CLOCK_SECONDS` to play the ball, and the last
`SERVE_CLOCK_COUNTDOWN` of them are counted down on screen; run it out and the
point goes to the receiver. Only in a two-human match: the CPU serves on its
own beat and a solo player pausing to think is not stalling anybody. The
countdown rides the snapshot (`serveClock`) rather than being re-derived, so
the server knows they are being hurried and the receiver can see the point was
earned by the clock rather than conjured.

**The host reads each seat through the scheme that seat is actually playing.**
Portrait and landscape are two schemes, not two skins: upright, the axes carry
a swipe whose length is carry and whose pace is power, and a tap on the court
is either somewhere to stand or the next touch being asked for. The guest
reports which it is on every input frame (`portrait`), and `portraitFor(side)`
in `src/match.ts` is what every rule asks — reading a guest's swipe as a stick
aimed their every kick somewhere nobody asked for, and left their serve looking
for a tap count that scheme never sends.

**Each screen coaches its own seat.** The serve prompt and the first set-up
tips were shown by the host whenever `versus` was on — which an online host
always is — so the host was told how to aim a serve the guest was making, and
the guest, which runs no rules, was told nothing. `hintsFor` now coaches the
other seat only when both players share one screen, and a guest gives the same
two lines to itself from the phase and possession its snapshots carry.

A tap needs an answer only the host has, so the snapshot carries the two rules
facts it turns on: `strikeable` and `touches`. Without them a follower's
`touchImminent` can only ever say no, and every tap becomes a walk. With them
the tap resolves on the guest into a carry vector that travels as an ordinary
`pop` with the aim on the axes — the same shape a second local controller
produces — flagged `tapAim` so the host knows those axes are a placement rather
than a direction to run.

```bash
npm run relay        # PORT=8787, health check on /healthz
```

**A dropped socket is not a lost match.** A handover from Wi-Fi to cellular, a
lift, a tunnel, a notification that backgrounds the tab — a phone's socket dies
for a few seconds constantly, and before this each one cost the game. The relay
needs no part in the fix: a closed socket frees its seat while the room lives
on for the opponent, so rejoining by the same code lands back in the same room
against the same person. `NetConnection` retries six times over about twenty
seconds (`RECONNECT_BACKOFF_MS`), long enough to outlast a handover and well
short of somebody who has actually gone.

The room code is kept rather than re-derived because in a quick match the
player never knew it — the relay minted it and named it in the `joined` frame.
`close()` flags the leave as deliberate, so a player who quits is never chased.
And `OnlineSession` holds the forfeit clock while a reconnect is in flight:
silence on a socket that is *our own* problem says nothing about the opponent,
and awarding ourselves a walkover because our phone changed network would hand
the match to the player who actually left.

The connect timeout is deliberately generous (45 s). A container host that
scales to zero takes the better part of a minute to answer the first
connection, and a ten-second deadline turned "your first online game of the
day" into "online play is broken".

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

**Real money buys two things: the arena, once, and coins. There are no
subscriptions.** Everything else in the game — characters, balls, levels,
supplies — is bought with coins and trophies, and both are earned by playing.
A game that rents out its content has to keep being paid to stay the same game.

**Nothing is granted on the client's word.** A device used to add the coins
and the unlock itself and tell the server afterwards, which is not a purchase
record but a request, and one anybody could make without buying anything. The
chain runs the other way now: Play takes the money, RevenueCat verifies it
against Play, RevenueCat calls `/api/revenuecat`, and the server reads what the
product grants out of `src/catalogue.ts` — a table shared with the client
through `src/rules.ts` so both agree, and which the client cannot edit.

The webhook proves itself with a shared secret in its Authorization header
(`REVENUECAT_WEBHOOK_SECRET`, set beside the webhook in the dashboard and
passed by `server/deploy.sh`, which refuses to deploy without it). Applying is
idempotent by event id, because RevenueCat retries anything it did not get an
answer to and coins credited twice are coins nobody paid for. Anything that
cannot succeed but is not our fault — an unknown player, an event type that
grants nothing — answers 200, since retrying the impossible forever helps
nobody.

The buying device then polls its own career until the grant shows up. That is
the cost of moving the decision off the device: the store answers the phone
immediately and the webhook reaches the server a beat later, so there is a
short wait where there used to be an instant lie.

**One purchase path, for everything.** The arena was briefly the exception: it
was sold through a RevenueCat paywall, a screen designed in their dashboard
rather than in the app. That bought copy you could edit without shipping a
build, at the price of a second purchase system to keep alive, a second look
for the player to make sense of, and a failure mode nobody could see — with no
paywall configured the button did nothing at all and said nothing about why. It
goes through `purchaseAsset` now, like every character, ball and venue, and
`@revenuecat/purchases-capacitor-ui` came out with it.

`src/purchases.ts` is the only module that imports the SDK, so there is one
answer to "does this player own the arena" rather than one per call site. The
entitlement identifier is still the one the dashboard was configured with, on
purpose: renaming it would strip the arena from everybody who already bought
it. A legacy subscription still carrying somebody's entitlement keeps working
until it lapses, and RevenueCat drops it out of `entitlements.active` itself.

Coins have a second source that needs no store at all: **trophies**.
`tradeTrophies` in `src/progress.ts` sells them at `COINS_PER_TROPHY`, on the
same screen as the packs. It is a real decision rather than a discount —
trophies are rank, rank is the coin bonus on every match, so cashing in trades
tomorrow's earning rate for something to spend tonight. `best` is untouched, so
trading down never takes back a character already unlocked.

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

The print is **one flat, opaque colour in the game's own Exo 2** — no halo, no
drop shadow, no gradient — because that is how the reference kits
(the supplied national-kit models the in-game characters were compressed
from) print theirs, and the costume of outlines the first version wore is
exactly what made it read as a sticker laid over the shirt. The one thing flat
ink cannot survive is being the same tone as the cloth, and the player picks
the colour: so the cloth under each mark is *measured* off the canvas, and a
thin keyline in the opposite tone appears only when the two genuinely sink
together.

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

**Do not judge that service by `/healthz`.** On some home and carrier networks
the path is intercepted and answers a Google-branded 404 while the service is
fine — it has twice looked dead from this network while serving real players.
`curl https://…/api/leaderboard` is the honest liveness check (verified
2026-08-16). The old Render relay (`teqopen-relay.onrender.com`) still answers
as well, but against an empty file store: pointing a build at it splits the
leaderboard, so it is not a fallback.

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
