/** Wraps raw PCM in a 44-byte canonical WAV header. */
export function pcmToWav(
  pcm: Buffer,
  { sampleRate = 16_000, channels = 1, bitsPerSample = 16 } = {},
): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Seconds of audio in a PCM16 mono buffer. */
export function pcmDurationSeconds(pcm: Buffer, sampleRate = 16_000): number {
  return pcm.length / 2 / sampleRate;
}

/**
 * Root-mean-square amplitude, 0..1. Used to reject a push-to-talk capture that
 * is just room noise before spending a transcription call on it.
 */
export function pcmLevel(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32_768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}
