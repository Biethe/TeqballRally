/**
 * A crowd that moves.
 *
 * The spectators are thin instances, which cannot be skinned — a thin instance
 * is a matrix, and it shares one geometry and one skeleton-less mesh with every
 * other copy. So the animation is in the transforms: everyone breathes on the
 * spot during a rally and jumps when a point lands.
 *
 * That constraint turns out to suit the material. The figures are already
 * posed mid-cheer with their arms up, so a vertical hop reads as celebration
 * without needing a single new pose, and the whole crowd costs three numbers
 * per person per frame.
 *
 * Cost is why this is written against a raw Float32Array rather than Babylon's
 * matrix helpers. A matrix's translation lives at indices 12, 13 and 14 of its
 * sixteen floats, so a bob is one write and a sway is two — recomposing the
 * matrix would be sixteen, plus a quaternion, for a movement nobody can see.
 */

/** Everything about one spectator that does not change frame to frame. */
interface Seat {
  /** Where this person stands when nothing is happening. */
  x: number;
  y: number;
  z: number;
  /** Radians of phase, so a row does not breathe in unison. */
  phase: number;
  /** 0.75-1.25 or so: some people are more animated than others. */
  energy: number;
}

/** One mesh's worth of instances, and the buffer the GPU reads. */
interface Section {
  buffer: Float32Array;
  seats: Seat[];
  /** Called after the buffer is rewritten. */
  flush: () => void;
}

/** How high an idle spectator rocks, in metres. */
const IDLE_LIFT = 0.035;
/** How high a celebrating one jumps. */
const JUMP_LIFT = 0.42;
/** Seconds a celebration runs before settling back. */
const CELEBRATION_SECONDS = 2.2;
/** Bounces packed into a celebration. */
const JUMP_BOUNCES = 2.6;

export class Crowd {
  private sections: Section[] = [];
  private clock = 0;
  /** Seconds left of a celebration, or 0. */
  private celebrating = 0;
  /**
   * 0 while nothing is happening, 1 mid-rally. Ramps rather than switches, so
   * the crowd settles after a point instead of stopping dead.
   */
  private interest = 0;
  private wanted = 0;
  /** True once everyone has been written back to their exact seat. */
  private settled = true;

  /**
   * Adopt a placed crowd. `buffer` is the mesh's live thin-instance matrix
   * data, which this then owns: the seats are read out of it once and it is
   * rewritten in place from then on.
   */
  add(buffer: Float32Array, flush: () => void): void {
    const count = Math.floor(buffer.length / 16);
    const seats: Seat[] = [];
    for (let i = 0; i < count; i++) {
      const x = buffer[i * 16 + 12];
      const y = buffer[i * 16 + 13];
      const z = buffer[i * 16 + 14];
      // Phase from the position, so it is stable across runs and identical on
      // both peers of an online match.
      const hash = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      const frac = hash - Math.floor(hash);
      seats.push({ x, y, z, phase: frac * Math.PI * 2, energy: 0.75 + frac * 0.5 });
    }
    this.sections.push({ buffer, seats, flush });
  }

  /** True once there is anybody to animate. */
  get ready(): boolean {
    return this.sections.length > 0;
  }

  /** A rally is on: lift the crowd out of its resting state. */
  setEngaged(engaged: boolean): void {
    this.wanted = engaged ? 1 : 0;
  }

  /** A point has been won by somebody. Everybody up. */
  celebrate(): void {
    this.celebrating = CELEBRATION_SECONDS;
  }

  /**
   * Advance and rewrite the instance buffers.
   *
   * Skipped entirely when the crowd is at rest and nothing is celebrating —
   * an idle menu should not be paying for a stadium.
   */
  update(dt: number): void {
    if (this.sections.length === 0) return;
    this.clock += dt;
    if (this.celebrating > 0) this.celebrating = Math.max(0, this.celebrating - dt);
    // Interest eases toward what the match wants; a celebration pins it high.
    const target = this.celebrating > 0 ? 1 : this.wanted;
    this.interest += (target - this.interest) * Math.min(1, dt * 2.5);
    if (this.interest < 0.002 && this.celebrating === 0) {
      // Settle exactly rather than stopping wherever the last frame left
      // everyone. The residue is a fraction of a millimetre and invisible, but
      // "at rest means back on the mark" is what makes it possible to assert
      // that nothing drifts over a long match.
      if (this.settled) return;
      this.interest = 0;
      for (const section of this.sections) {
        section.seats.forEach((seat, i) => {
          section.buffer[i * 16 + 12] = seat.x;
          section.buffer[i * 16 + 13] = seat.y;
          section.buffer[i * 16 + 14] = seat.z;
        });
        section.flush();
      }
      this.settled = true;
      return;
    }
    this.settled = false;

    // One celebration curve for everyone, evaluated once rather than per seat.
    const celebration = this.celebrating / CELEBRATION_SECONDS;
    const hop =
      celebration > 0
        ? Math.abs(Math.sin(celebration * Math.PI * JUMP_BOUNCES)) * celebration * JUMP_LIFT
        : 0;

    for (const section of this.sections) {
      const { buffer, seats } = section;
      for (let i = 0; i < seats.length; i++) {
        const seat = seats[i];
        const t = this.clock * 2.4 * seat.energy + seat.phase;
        // Idle is a rock rather than a bounce: feet stay down, weight shifts.
        const lift = Math.abs(Math.sin(t)) * IDLE_LIFT * this.interest * seat.energy;
        const sway = Math.sin(t * 0.5) * 0.035 * this.interest * seat.energy;
        const at = i * 16;
        buffer[at + 12] = seat.x + sway;
        buffer[at + 13] = seat.y + lift + hop * seat.energy;
        buffer[at + 14] = seat.z;
      }
      section.flush();
    }
  }
}
