import { AudioInputSource, AudioSpeakerRole, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import type { GlassesBridge } from './bridge';
import { VOICE } from './config';

/**
 * Push-to-talk capture off the G2 four-mic array.
 *
 * PCM frames arrive through `onEvenHubEvent` while the mic is open; we buffer
 * them, then hand one base64 blob to the server. Nothing is kept after the
 * request is built.
 */
export class VoiceRecorder {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private active = false;
  private startedAt = 0;
  private hardStop: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bridge: GlassesBridge,
    private readonly onAutoStop: () => void,
  ) {}

  get isRecording(): boolean {
    return this.active;
  }

  get elapsedSeconds(): number {
    return this.active ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  /** Feed every hub event here; non-audio frames are ignored. */
  accept(event: EvenHubEvent): void {
    if (!this.active) return;

    const audio = event.audioEvent;
    if (!audio?.audioPcm?.length) return;

    // The host classifies frames; drop anything it attributes to someone else
    // so a nearby conversation does not end up in the question.
    if (audio.speakerRole === AudioSpeakerRole.Other) return;

    if (this.bytes + audio.audioPcm.length > VOICE.maxBytes) return;

    this.chunks.push(audio.audioPcm);
    this.bytes += audio.audioPcm.length;
  }

  async start(): Promise<boolean> {
    if (this.active) return true;

    this.chunks = [];
    this.bytes = 0;

    const opened = await this.bridge.run('audioControl(on)', (b) =>
      b.audioControl(true, AudioInputSource.Glasses),
    );
    if (!opened) return false;

    this.active = true;
    this.startedAt = Date.now();

    this.hardStop = setTimeout(() => {
      if (this.active) this.onAutoStop();
    }, VOICE.maxSeconds * 1_000);

    return true;
  }

  /** Closes the mic and returns the capture, or null when there is nothing usable. */
  async stop(): Promise<{ base64: string; sampleRate: number; seconds: number } | null> {
    if (!this.active) return null;

    if (this.hardStop) {
      clearTimeout(this.hardStop);
      this.hardStop = null;
    }

    const seconds = this.elapsedSeconds;
    this.active = false;
    await this.bridge.run('audioControl(off)', (b) => b.audioControl(false));

    if (this.bytes === 0) return null;

    const merged = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.bytes = 0;

    return { base64: toBase64(merged), sampleRate: VOICE.sampleRate, seconds };
  }

  /** Abandons a capture without sending it (background, error, user cancel). */
  async cancel(): Promise<void> {
    if (!this.active) return;
    if (this.hardStop) {
      clearTimeout(this.hardStop);
      this.hardStop = null;
    }
    this.active = false;
    this.chunks = [];
    this.bytes = 0;
    await this.bridge.run('audioControl(off)', (b) => b.audioControl(false)).catch(() => undefined);
  }
}

/** Chunked so a 600 KB buffer does not blow the argument limit of String.fromCharCode. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
