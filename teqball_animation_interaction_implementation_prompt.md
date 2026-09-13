# Updated Implementation Prompt — Deterministic Animation-Based Teqball Interaction & Reachability System

## Goal

I am developing a 3D Teqball game in Babylon.js. The primary objective is **high visual quality and extremely convincing synchronization between the ball and the player's body**, while still preserving meaningful gameplay based on ball placement, speed, reachability, and rally rules.

The game uses a relatively limited library of custom mocap animations. I therefore want to build the ball interaction system around the animations that actually exist rather than attempting to simulate every physically possible body position.

The core principle is:

> **The animations define where and when a player can potentially interact with the ball. The ball trajectory is computed from the opponent's strike so that, when a valid interaction is selected, the ball naturally arrives at that interaction volume at the correct animation contact frame.**

However, the existence of an interaction volume **does not mean the defender is guaranteed to reach it**.

A shot can still win the point if the ball travels to a location that no available animation/contact volume can be reached by the defending player in time.

---

## 1. Existing animation metadata

The animations are custom mocap animations, and I already have important metadata for them.

For each relevant animation, I know:

- animation name;
- animation duration;
- exact frame/time at which ball/body contact occurs;
- contact frame;
- relevant body part;
- pose of the body at the contact frame.

The contact frame is critical.

For example:

- left-foot reception has its own contact frame;
- right-foot reception has another;
- different knee receptions can occur at different heights;
- different foot techniques have different contact positions;
- chest control has its own contact frame;
- headers have their own contact frame;
- volleys, smashes, acrobatic actions, etc. can each have different contact geometry.

Do **not** assume there are only four interaction heights.

Each animation can define its own interaction region.

---

## 2. Generate interaction volumes from the actual contact pose

For each animation:

1. Sample the animation at its exact contact frame.
2. Determine the relevant body part's position and orientation at that frame.
3. Generate a simplified 3D interaction volume around the actual contact region.
4. Store that geometry in animation-specific metadata.

This must be based on the **actual pose at the contact frame**, not simply on the body's position during idle or on the default skeleton configuration.

For example, if the knee is unusually high at the contact frame, the knee interaction volume must reflect that exact height.

The system should therefore derive:

- contact position;
- contact orientation;
- width;
- height;
- depth;
- local-space transform.

---

## 3. Interaction volumes are candidate interaction zones

These are **not traditional collision meshes**.

They are simple procedural volumes representing where a particular animation can plausibly interact with the ball.

Possible representations include:

- thin rectangular prisms;
- slightly thicker boxes;
- capsules;
- spheres;
- other simple primitives when appropriate.

Examples:

- foot interaction volume;
- knee interaction volume;
- chest interaction volume;
- head interaction volume.

But again, there can be many more than four.

Each animation can have its own volume.

---

## 4. The interaction space is discrete but visually continuous

The system intentionally does not allow arbitrary continuous ball/body contact positions.

Instead, the animation library defines a collection of valid interaction regions.

For example:

```text
LeftFootReception_01
LeftFootReception_02
RightFootReception_01
RightFootReception_02

LeftKneeReception_01
RightKneeReception_01

ChestReception_01
ChestReception_02

HeadReception_01

Volley_01
Volley_02

AcrobaticReception_01
...
```

Each animation has its own contact volume.

This produces a **discrete 3D interaction space**, but because there can be many overlapping and relatively large volumes, the player should perceive the result as continuous.

The player should never notice that the underlying system uses discrete interaction regions.

---

## 5. Interaction volumes must have depth

The volumes must exist in full 3D space.

They must account for:

- lateral position;
- height;
- depth.

This is important because incoming balls can have curved trajectories.

A high-lofted ball may cross the same horizontal height more than once.

Therefore, do NOT select an interaction merely because the ball crosses a particular height.

The complete 3D trajectory must be evaluated against the candidate interaction volumes.

---

## 6. Precompute and store the interaction geometry

Because the court is flat, the fundamental vertical position of an animation's contact point does not change depending on where the player is on the court.

Therefore, interaction geometry should be generated once from the animation's contact pose and stored as animation metadata.

At runtime, transform the local-space interaction volume according to the player's:

- position;
- orientation;
- potentially scale if necessary.

The system should not continuously rediscover the contact height.

The contact geometry is deterministic.

---

## 7. Ball representation

Represent the ball for calculations as a simple mathematical sphere with a configurable radius.

The visible ball can continue using the existing visual mesh.

The mathematical sphere should be used for:

- trajectory calculations;
- interaction tests;
- contact calculations;
- collision refinement.

---

## 8. The crucial gameplay concept: potential interaction vs actual reachability

This is one of the most important requirements.

The interaction volumes represent **potential locations where the player could make a valid touch**.

They do NOT mean:

> "The defender can always reach this volume."

Instead, the system must distinguish between:

### Potential interaction

The incoming trajectory can reach a valid animation interaction volume.

### Reachable interaction

The defending player can physically/procedurally reach that interaction volume **within the available time** using the player's movement capabilities and available animations.

Only a reachable interaction can result in a successful reception.

---

## 9. The opponent must still be able to win points

This is a rally-based Teqball game.

The opponent must be able to win a point by placing the ball somewhere the defender cannot reach.

The animation-driven system must NOT turn every shot into an automatic successful reception.

For example:

### Soft, accessible shot

The opponent makes a relatively soft shot toward the defender.

The trajectory intersects a reachable foot interaction volume.

Result:

- defender reaches it;
- correct animation plays;
- ball and body synchronize;
- player gets control of the ball;
- rally continues.

### Fast shot

The opponent performs a very powerful shot.

The trajectory may pass through the general spatial region where the defender *could* theoretically interact with the ball.

However, the ball arrives there too quickly.

The defender cannot move into the required position before the animation contact time.

Result:

- there is no reachable interaction;
- the defender cannot make the touch;
- the shot wins the point.

### Well-placed shot

The opponent sends the ball far enough laterally or otherwise places it outside the defender's reachable interaction regions.

Even if there are theoretically valid animations somewhere in space, the defender cannot reach them in time.

Result:

- no valid reachable interaction;
- point for the opponent.

This is essential to preserve gameplay.

---

## 10. Reachability must be part of candidate selection

When evaluating an interaction animation, the system must consider more than whether the trajectory intersects the volume.

For every candidate, evaluate:

- where the interaction volume is relative to the player;
- when the ball will arrive there;
- how much time the defender has;
- how far the defender needs to move;
- player movement speed;
- player acceleration/deceleration where appropriate;
- player orientation;
- whether the required movement is possible;
- whether the animation can realistically be initiated in time;
- whether the candidate contact is within the animation's valid contact window.

Conceptually:

```text
Can the ball reach this interaction volume?
        AND
Can the player reach this interaction volume in time?
        AND
Can the appropriate animation be initiated and synchronized?
```

Only if all conditions are satisfied is the candidate considered a valid reception.

---

## 11. The opponent's shot parameters remain meaningful

The opponent's action must determine meaningful trajectory characteristics.

For example:

- soft shot;
- medium shot;
- hard shot;
- smash;
- high loft;
- low trajectory;
- left/right placement;
- deep placement;
- short placement.

These parameters should influence:

- ball velocity;
- trajectory;
- arrival time;
- landing position;
- available reaction time;
- reachable interaction candidates.

The defender should not simply receive everything because the animation system can theoretically find a volume.

---

## 12. Compute the entire trajectory from the original strike

When the opponent strikes the ball, begin the trajectory computation from the original strike.

Do NOT:

```text
Normal ball trajectory
        ↓
Ball gets near defender
        ↓
Find interaction volume
        ↓
Pull/snap ball toward volume
```

Instead:

```text
Opponent strike
        ↓
Determine ball trajectory
        ↓
Evaluate candidate interaction volumes
        ↓
Evaluate defender reachability
        ↓
Select best reachable interaction
        ↓
Ensure trajectory naturally satisfies that interaction
        ↓
Play corresponding animation
        ↓
Ball naturally reaches contact volume
```

There must be no visible last-second correction.

---

## 13. No snapping or magnetic attraction

Never implement an attraction system where the ball is pulled toward the player's body.

There must be:

- no snapping;
- no teleportation;
- no magnetic attraction;
- no sudden trajectory correction;
- no artificial movement toward the contact volume.

The ball should appear to have followed a coherent trajectory from the opponent's original strike.

---

## 14. Multiple possible interaction candidates

A single incoming ball can potentially be handled by many animations.

For example:

```text
Foot A
Foot B
Foot C
Right Knee
Left Knee
Chest A
Chest B
Head
Volley A
Volley B
...
```

The system should evaluate all appropriate candidates.

The defender may effectively reason like a human:

> "Can I get my foot there?"

If not:

> "Can I get my knee there?"

If not:

> "Can I get my chest there?"

If the ball is high:

> "Can I get my head there?"

But unlike a human, the game uses deterministic candidate evaluation.

---

## 15. Candidate scoring

Each candidate should receive a deterministic score based on factors such as:

- trajectory/volume intersection;
- contact timing;
- distance from ideal contact position;
- required player displacement;
- required movement time;
- available reaction time;
- animation suitability;
- incoming ball direction;
- incoming ball speed;
- player orientation;
- animation-specific priority.

A candidate that is technically possible but requires impossible movement should be rejected.

A candidate that is physically reachable but leaves too little time to start the animation should also be rejected.

The system should select the best **reachable** candidate.

---

## 16. The player model is not the primary trajectory target

This distinction is important.

The trajectory computation should NOT simply target the current visible character mesh.

Instead, it should reason about:

> **where the player could validly be at the future contact moment, given the available movement and animation system.**

The player mesh is the visual representation.

The interaction volumes are the deterministic spatial targets.

Therefore:

```text
Opponent strike
        ↓
Future trajectory
        ↓
Potential future interaction volumes
        ↓
Player reachability
        ↓
Valid animation/contact
```

This allows the system to remain deterministic while still producing meaningful gameplay.

---

## 17. Movement and interaction are connected

The interaction system must account for the fact that the defender can move toward the future interaction location.

The relevant question is not:

> "Is the ball currently near the player?"

It is:

> "Can the player get to the required interaction region by the time the ball reaches it?"

This is what allows a fast or well-placed shot to beat the defender.

---

## 18. First touch is the most important interaction

The first touch/reception deserves the most sophisticated logic.

Once a valid first touch happens:

- the ball becomes more controlled by the player's interaction system;
- the player can continue the rally;
- subsequent ball interactions can use the same animation-driven approach.

The first-touch system should therefore combine:

1. trajectory;
2. interaction volumes;
3. animation contact timing;
4. player movement;
5. reachability;
6. candidate selection.

---

## 19. Visual validation BEFORE gameplay integration

Before implementing the gameplay system, create a debug visualization mode.

I need to visually verify the generated interaction volumes first.

For every animation, I should be able to:

1. select the animation;
2. play it;
3. pause it;
4. jump to the exact contact frame;
5. see the player;
6. see the relevant body part;
7. see the generated interaction volume;
8. see the mathematical ball sphere;
9. see the expected contact point;
10. see the interaction volume's orientation;
11. optionally see the predicted ball trajectory.

The most important thing is visual proof that the generated volume corresponds to the actual mocap contact position.

---

## 20. Debug visualization

Use clear visual representations such as:

- semi-transparent 3D boxes;
- wireframe outlines;
- ball sphere;
- contact-point marker;
- local axes;
- optional trajectory line;
- contact-frame indicator.

There must be an easy way to inspect:

- one animation;
- one interaction volume;
- all interaction volumes.

The purpose is to visually validate the geometry before it influences gameplay.

---

## 21. Body collision primitives

Separately from the interaction volumes, use simplified procedural collision primitives around the character.

Possible primitives:

- capsules for limbs;
- spheres for joints/head;
- simplified torso volumes.

These are intended to prevent the ball from visually penetrating the body.

The distinction is:

### Interaction volume

"Can this animation receive the ball here?"

### Body collision primitive

"Should the ball be prevented from visually penetrating this part of the body?"

They are separate systems.

---

## 22. Do not use the rendered mesh as the primary collision system

Do not depend on detailed character-mesh collision for this interaction system.

The goal is predictable, stable, visually convincing interaction.

Simplified primitives are preferable because they are:

- deterministic;
- inexpensive;
- easy to debug;
- easy to adjust;
- less susceptible to tiny mesh irregularities.

If necessary, slightly enlarge the body primitives to prevent visible penetration.

Visual correctness is more important than mathematically exact mesh collision.

---

## 23. Deterministic behavior

The system should be deterministic.

Given identical:

- ball state;
- opponent strike;
- player state;
- player position;
- player orientation;
- animation library;

the candidate-selection and reachability results should be reproducible.

Avoid unnecessary randomization in the first-touch system.

Variation should come from the actual shot and the available interaction possibilities.

---

## 24. Implementation stages

Implement this in strict stages.

### Phase 1 — Inspect existing system

Understand:

- animation architecture;
- animation metadata;
- contact-frame metadata;
- player skeleton;
- coordinate systems;
- ball implementation;
- current movement;
- current collision/interaction logic.

Do not rewrite unrelated systems.

### Phase 2 — Generate interaction metadata

For each animation:

- identify contact frame;
- sample the contact pose;
- identify relevant body part;
- calculate contact position;
- generate interaction volume;
- store local-space transform and dimensions.

### Phase 3 — Visualization only

Implement the debug visualization.

**Do not change gameplay yet.**

I must be able to visually validate the generated volumes.

### Phase 4 — Runtime transformation

Transform the precomputed local interaction volumes according to the player's runtime position/orientation.

### Phase 5 — Reachability system

Implement future-player-position/reachability evaluation.

Determine whether the player can reach each candidate interaction volume before the ball arrives.

### Phase 6 — Candidate selection

Evaluate all valid animation candidates and select the best reachable candidate.

### Phase 7 — Trajectory planning

Integrate the candidate interaction into the complete ball trajectory calculation.

The trajectory must naturally reach the selected interaction without snapping.

### Phase 8 — Animation synchronization

Synchronize the ball arrival with the exact contact frame of the selected animation.

### Phase 9 — Collision refinement

Use the simple ball sphere and body primitives to prevent visual penetration and improve contact quality.

### Phase 10 — Gameplay validation

Test:

- slow balls;
- fast balls;
- smashes;
- high lofts;
- low trajectories;
- short shots;
- deep shots;
- lateral shots;
- shots between interaction regions;
- shots beyond player reach;
- shots where multiple animations are possible.

The system must demonstrate that the defender does **not** automatically receive every ball.

---

## 25. Final intended architecture

The intended system is:

```text
Opponent chooses shot
        ↓
Shot determines initial ball state
(speed / direction / trajectory / placement)
        ↓
Predict complete incoming trajectory
        ↓
Enumerate animation-specific interaction volumes
        ↓
For every candidate:
    ├─ Where is the volume in the future?
    ├─ When does the ball reach it?
    ├─ Can the player move there in time?
    ├─ Can the animation start in time?
    ├─ Is the incoming trajectory suitable?
    └─ Is the contact visually valid?
        ↓
Reject unreachable candidates
        ↓
Score remaining candidates
        ↓
Select best reachable interaction
        ↓
Compute/satisfy the complete trajectory
        ↓
Move defender toward required future position
        ↓
Play selected animation
        ↓
Ball naturally enters interaction volume
        ↓
First touch occurs
        ↓
Player gains control / rally continues
```

If **no candidate is reachable**, the player fails to touch the ball.

That is a valid gameplay outcome and can result in the opponent winning the point.

---

## 26. The most important conceptual rule

The entire system should be built around this distinction:

> **The animation volumes define what is possible. Player movement and shot characteristics determine what is reachable.**

Therefore:

**Possible ≠ reachable.**

And:

**Reachable ≠ guaranteed unless the timing and animation synchronization also work.**

This is what preserves both the visual quality and the competitive gameplay.

---

## 27. Final acceptance criteria

The implementation is successful only if all of the following are true:

- The interaction volumes are generated from the actual animation contact pose.
- Each animation can have its own interaction volume.
- There is no assumption of only four interaction heights.
- Interaction volumes have meaningful 3D depth.
- The ball is represented mathematically as a sphere.
- Interaction volumes can be visually inspected.
- Contact frames can be visually inspected.
- Body collision primitives can be visually inspected.
- The ball trajectory is not snapped toward the player.
- There is no magnetic attraction.
- The trajectory is coherent from the original opponent strike.
- Multiple candidate animations can be evaluated.
- Candidate selection is deterministic.
- Player reachability is part of candidate selection.
- Fast shots can beat the defender.
- Well-placed shots can beat the defender.
- A candidate volume existing somewhere in space does not guarantee a successful reception.
- The defender must actually be able to reach the candidate interaction region in time.
- Successful reception synchronizes naturally with the exact animation contact frame.
- The ball does not visibly penetrate the player.
- The player should not perceive the underlying discrete interaction system.

**Most importantly:**

Before implementing the actual gameplay/trajectory integration, provide the visualization/debugging stage so I can inspect and validate the generated animation-specific interaction volumes.

Do not proceed to the full gameplay implementation until the geometry can be visually verified.
