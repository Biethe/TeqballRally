import { assetUrl, PROTECTED } from "./protected";

const MUSIC_LOOPS = [
  "/audio/music/music_loop_1.mp3",
  "/audio/music/music_loop_2.mp3",
  "/audio/music/music_loop_3.mp3",
  "/audio/music/music_loop_4.mp3",
] as const;

const KICK = "/audio/sfx/kick.wav";
const APPLAUSE = "/audio/sfx/crowd_applause.wav";

/**
 * Point an audio element at an asset, plainly or through decryption.
 *
 * A plain build assigns the path and returns, which is what an `<audio>`
 * wants: it streams the file and can start on the first bytes. A protected
 * build has to fetch and decrypt the whole thing before there is anything to
 * play, so the assignment happens later and `whenReady` is where anything that
 * depends on it goes.
 *
 * Keeping the plain path synchronous is not tidiness. Browsers allow
 * `play()` inside a user gesture, and a `.then` has already left that stack.
 */
function attach(el: HTMLAudioElement, path: string, whenReady?: () => void): void {
  if (!PROTECTED) {
    el.src = path;
    whenReady?.();
    return;
  }
  void assetUrl(path)
    .then((url) => {
      el.src = url;
      whenReady?.();
    })
    .catch(() => undefined);
}

/** Tiny HTMLAudio wrapper: overlapping SFX plus rotating seamless menu music. */
export class AudioManager {
  private kick = new Audio();
  private applause = new Audio();
  private music: HTMLAudioElement | null = null;
  private nextMusicIndex = 0;
  private unlocked = false;
  /** Player preferences. Muting music stops the loop; muting sound skips SFX. */
  private musicOn = true;
  private soundOn = true;

  constructor() {
    this.applause.volume = 0.7;
    this.kick.volume = 0.9;
    // Started here rather than at first use: in a protected build these have
    // to be fetched and decrypted whole, and the first kick of a rally is not
    // the moment to discover that.
    attach(this.kick, KICK);
    attach(this.applause, APPLAUSE);
  }

  /** Browsers block audio until a user gesture; call this from the first one. */
  unlock(): void {
    this.unlocked = true;
  }

  /** Silence or restore the menu loop, keeping whatever is playing in step. */
  setMusicEnabled(on: boolean): void {
    this.musicOn = on;
    if (!on) this.stopMusic();
  }

  setSoundEnabled(on: boolean): void {
    this.soundOn = on;
  }

  playKick(): void {
    // `src` is empty until the decrypted blob lands. Skipping a kick in that
    // window is right: the alternative is queueing sounds for a rally that has
    // moved on by the time they arrive.
    if (!this.unlocked || !this.soundOn || !this.kick.src) return;
    const k = this.kick.cloneNode() as HTMLAudioElement;
    k.volume = this.kick.volume;
    void k.play().catch(() => {});
  }

  playApplause(): void {
    if (!this.unlocked || !this.soundOn || !this.applause.src) return;
    this.applause.currentTime = 0;
    void this.applause.play().catch(() => {});
  }

  startMusic(): void {
    if (!this.unlocked || !this.musicOn) return;
    if (!this.music) {
      const track = new Audio();
      track.loop = true;
      track.volume = 0.45;
      track.preload = "auto";
      this.music = track;
      // Play from the callback rather than falling through: in a protected
      // build the element has no source yet, and `play()` on an empty element
      // rejects. `stopMusic` can also have run while the decrypt was in
      // flight, which is what the identity check catches — without it a
      // stopped loop starts itself a moment after being stopped.
      attach(track, MUSIC_LOOPS[this.nextMusicIndex], () => {
        if (this.music !== track || !this.musicOn || !this.unlocked) return;
        void track.play().catch(() => {});
      });
      return;
    }
    const track = this.music;
    if (!track.paused) return;
    void track.play().catch(() => {});
  }

  stopMusic(): void {
    if (!this.music) return;
    this.music.pause();
    this.music.currentTime = 0;
    this.music = null;
    this.nextMusicIndex = (this.nextMusicIndex + 1) % MUSIC_LOOPS.length;
  }
}
