// Zero-asset Web Audio synthesizer for realistic phenolic billiard ball clicks,
// leather cue-tip strikes, K-66 cushion thuds, and pocket drop rattles.

const STORAGE_SOUND_MUTED_KEY = 'pool8_sound_muted_v1';

export class BilliardSoundEngine {
  private ctx: AudioContext | null = null;
  private muted: boolean = false;
  private lastBallClackAt = 0;
  private lastCushionThudAt = 0;

  constructor() {
    try {
      this.muted = localStorage.getItem(STORAGE_SOUND_MUTED_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      if (muted) {
        localStorage.setItem(STORAGE_SOUND_MUTED_KEY, '1');
      } else {
        localStorage.removeItem(STORAGE_SOUND_MUTED_KEY);
      }
    } catch {
      // Ignore storage errors
    }
    if (!muted) {
      this.unlock();
    }
  }

  public toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public unlock(): void {
    if (this.muted) return;
    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  private getReadyContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      this.unlock();
    }
    if (!this.ctx || this.ctx.state !== 'running') return null;
    return this.ctx;
  }

  /**
   * Leather cue tip striking phenolic cue ball (power 0..1)
   */
  public playCueStrike(power: number): void {
    const ctx = this.getReadyContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const gainVal = Math.min(0.65, 0.14 + power * 0.5);

    // Short leather thwack body
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(210 + power * 130, now);
    osc.frequency.exponentialRampToValueAtTime(68, now + 0.045);

    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.052);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.055);

    // Crisp phenolic transient click
    const clickOsc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    clickOsc.type = 'sine';
    clickOsc.frequency.setValueAtTime(1950 + power * 600, now);
    clickOsc.frequency.exponentialRampToValueAtTime(680, now + 0.014);

    clickGain.gain.setValueAtTime(gainVal * 0.55, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.016);

    clickOsc.connect(clickGain);
    clickGain.connect(ctx.destination);
    clickOsc.start(now);
    clickOsc.stop(now + 0.018);
  }

  /**
   * Crisp phenolic resin ball-to-ball impact (impactSpeed in inches/sec, 0..310)
   */
  public playBallCollision(impactSpeed: number): void {
    const ctx = this.getReadyContext();
    if (!ctx) return;

    const perfNow = performance.now();
    if (perfNow - this.lastBallClackAt < 14) return;
    this.lastBallClackAt = perfNow;

    const norm = Math.min(1, Math.max(0.04, impactSpeed / 190));
    const vol = Math.pow(norm, 0.78) * 0.58;
    if (vol < 0.015) return;

    const now = ctx.currentTime;
    const pitchJitter = 0.96 + Math.random() * 0.08;

    // Primary phenolic resonant mode (~2.4 kHz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime((2380 + norm * 420) * pitchJitter, now);
    osc1.frequency.exponentialRampToValueAtTime(1450 * pitchJitter, now + 0.018);

    gain1.gain.setValueAtTime(vol, now);
    gain1.gain.exponentialRampToValueAtTime(0.0008, now + 0.022);

    // Secondary shell harmonic (~4.3 kHz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime((4250 + norm * 500) * pitchJitter, now);
    gain2.gain.setValueAtTime(vol * 0.42, now);
    gain2.gain.exponentialRampToValueAtTime(0.0008, now + 0.011);

    // Low knock body (~420 Hz)
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = 'triangle';
    osc3.frequency.setValueAtTime(460 * pitchJitter, now);
    osc3.frequency.exponentialRampToValueAtTime(170, now + 0.015);
    gain3.gain.setValueAtTime(vol * 0.35, now);
    gain3.gain.exponentialRampToValueAtTime(0.0008, now + 0.016);

    osc1.connect(gain1);
    osc2.connect(gain2);
    osc3.connect(gain3);
    gain1.connect(ctx.destination);
    gain2.connect(ctx.destination);
    gain3.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc3.start(now);
    osc1.stop(now + 0.025);
    osc2.stop(now + 0.013);
    osc3.stop(now + 0.018);
  }

  /**
   * Muffled rubber K-66 cushion rail rebound
   */
  public playCushionBounce(impactSpeed: number): void {
    const ctx = this.getReadyContext();
    if (!ctx) return;

    const perfNow = performance.now();
    if (perfNow - this.lastCushionThudAt < 24) return;
    this.lastCushionThudAt = perfNow;

    const norm = Math.min(1, Math.max(0.05, impactSpeed / 160));
    const vol = Math.pow(norm, 0.85) * 0.34;
    if (vol < 0.015) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(135 + norm * 65, now);
    osc.frequency.exponentialRampToValueAtTime(46, now + 0.055);

    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.065);
  }

  /**
   * Ball rattling off pocket liner and thudding into the leather pocket basket
   */
  public playPocketDrop(entrySpeed: number): void {
    const ctx = this.getReadyContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const fast = Math.min(1, entrySpeed / 140);

    // 1. Liner rim rattle (if fast, hits back of leather/plastic pocket throat first)
    const rimDelay = 0.02;
    const rimOsc = ctx.createOscillator();
    const rimGain = ctx.createGain();
    rimOsc.type = 'triangle';
    rimOsc.frequency.setValueAtTime(310 + fast * 160, now + rimDelay);
    rimOsc.frequency.exponentialRampToValueAtTime(115, now + rimDelay + 0.045);
    rimGain.gain.setValueAtTime(0.18 + fast * 0.22, now + rimDelay);
    rimGain.gain.exponentialRampToValueAtTime(0.001, now + rimDelay + 0.05);
    rimOsc.connect(rimGain);
    rimGain.connect(ctx.destination);
    rimOsc.start(now + rimDelay);
    rimOsc.stop(now + rimDelay + 0.055);

    // 2. Basket bottom drop thud (~140ms later as ball lands in pocket well)
    const dropDelay = 0.12 + (1 - fast) * 0.05;
    const dropOsc = ctx.createOscillator();
    const dropGain = ctx.createGain();
    dropOsc.type = 'sine';
    dropOsc.frequency.setValueAtTime(165, now + dropDelay);
    dropOsc.frequency.exponentialRampToValueAtTime(58, now + dropDelay + 0.075);
    dropGain.gain.setValueAtTime(0.28, now + dropDelay);
    dropGain.gain.exponentialRampToValueAtTime(0.001, now + dropDelay + 0.08);
    dropOsc.connect(dropGain);
    dropGain.connect(ctx.destination);
    dropOsc.start(now + dropDelay);
    dropOsc.stop(now + dropDelay + 0.085);
  }
}
