import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { pcmDurationSeconds, pcmLevel, pcmToWav } from './wav.js';

const log = logger('speech');

export interface Transcription {
  text: string;
  provider: string;
  durationSeconds: number;
  /** Language the provider believed it heard, when it reports one. */
  language?: string;
}

export class SpeechUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechUnavailableError';
  }
}

/** Captures shorter than this are almost always an accidental tap. */
const MIN_DURATION_SECONDS = 0.35;
/** RMS floor below which the buffer is silence. */
const MIN_LEVEL = 0.004;

async function transcribeGoogle(pcm: Buffer, sampleRate: number): Promise<Transcription> {
  const cfg = loadConfig();
  if (!cfg.googleSpeechApiKey) {
    throw new SpeechUnavailableError('STT_PROVIDER=google but GOOGLE_SPEECH_API_KEY is not set.');
  }

  const res = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(cfg.googleSpeechApiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: sampleRate,
          audioChannelCount: 1,
          languageCode: 'en-US',
          // The wearer may switch languages mid-day; let Google pick.
          alternativeLanguageCodes: ['ru-RU', 'de-DE', 'es-ES', 'fr-FR'],
          enableAutomaticPunctuation: true,
          model: 'latest_short',
        },
        audio: { content: pcm.toString('base64') },
      }),
    },
  );

  if (!res.ok) {
    throw new SpeechUnavailableError(
      `Google Speech-to-Text returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    results?: Array<{ alternatives?: Array<{ transcript?: string }>; languageCode?: string }>;
  };

  const text = (data.results ?? [])
    .map((r) => r.alternatives?.[0]?.transcript ?? '')
    .join(' ')
    .trim();

  return {
    text,
    provider: 'google',
    durationSeconds: pcmDurationSeconds(pcm, sampleRate),
    language: data.results?.[0]?.languageCode,
  };
}

async function transcribeOpenAI(pcm: Buffer, sampleRate: number): Promise<Transcription> {
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) {
    throw new SpeechUnavailableError('STT_PROVIDER=openai but OPENAI_API_KEY is not set.');
  }

  const form = new FormData();
  form.append('model', cfg.openaiSttModel);
  form.append('response_format', 'json');
  form.append(
    'file',
    new Blob([new Uint8Array(pcmToWav(pcm, { sampleRate }))], { type: 'audio/wav' }),
    'speech.wav',
  );

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.openaiApiKey}` },
    body: form,
  });

  if (!res.ok) {
    throw new SpeechUnavailableError(
      `Transcription endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as { text?: string; language?: string };
  return {
    text: (data.text ?? '').trim(),
    provider: 'openai',
    durationSeconds: pcmDurationSeconds(pcm, sampleRate),
    language: data.language,
  };
}

/**
 * Turns a push-to-talk capture into text.
 *
 * The provider is pluggable because the glasses hand us plain PCM and every
 * deployment has a different opinion about where audio is allowed to go.
 */
export async function transcribe(pcm: Buffer, sampleRate = 16_000): Promise<Transcription> {
  const cfg = loadConfig();

  const duration = pcmDurationSeconds(pcm, sampleRate);
  if (duration < MIN_DURATION_SECONDS) {
    throw new SpeechUnavailableError('That was too short to hear. Hold the touchpad while you speak.');
  }

  const level = pcmLevel(pcm);
  if (level < MIN_LEVEL) {
    throw new SpeechUnavailableError('I only picked up silence.');
  }

  log.debug(`transcribing ${duration.toFixed(1)}s (rms ${level.toFixed(4)}) via ${cfg.sttProvider}`);

  switch (cfg.sttProvider) {
    case 'google':
      return transcribeGoogle(pcm, sampleRate);
    case 'openai':
      return transcribeOpenAI(pcm, sampleRate);
    default:
      throw new SpeechUnavailableError(
        'Voice input is not configured on this server. Set STT_PROVIDER to google or openai.',
      );
  }
}

export function speechEnabled(): boolean {
  return loadConfig().sttProvider !== 'none';
}
