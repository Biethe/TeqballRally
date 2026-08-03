const MUSIC_LOOPS = [
  "/audio/music/music_loop_1.mp3",
  "/audio/music/music_loop_2.mp3",
  "/audio/music/music_loop_3.wav",
] as const;

/** Tiny HTMLAudio wrapper: overlapping SFX plus rotating seamless menu music. */
export class AudioManager {
  private kick = new Audio("/audio/sfx/kick.wav");
  private applause = new Audio("/audio/sfx/crowd_applause.wav");
  private music: HTMLAudioElement | null = null;
  private nextMusicIndex = 0;
  private unlocked = false;

  constructor() {
    this.applause.volume = 0.7;
    this.kick.volume = 0.9;
  }

  /** Browsers block audio until a user gesture; call this from the first one. */
  unlock(): void {
    this.unlocked = true;
  }

  playKick(): void {
    if (!this.unlocked) return;
    const k = this.kick.cloneNode() as HTMLAudioElement;
    k.volume = this.kick.volume;
    void k.play().catch(() => {});
  }

  playApplause(): void {
    if (!this.unlocked) return;
    this.applause.currentTime = 0;
    void this.applause.play().catch(() => {});
  }

  startMusic(): void {
    if (!this.unlocked) return;
    if (!this.music) {
      const track = new Audio(MUSIC_LOOPS[this.nextMusicIndex]);
      track.loop = true;
      track.volume = 0.45;
      track.preload = "auto";
      this.music = track;
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
