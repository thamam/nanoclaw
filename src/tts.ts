// tts.ts — 11Labs text-to-speech for voice replies
//
// Voice for X: "Adam" (pNInz6obpgDQGcFmaJgB) — deep, professional, distinct from other bots.
// Model: eleven_turbo_v2_5 — lowest latency for real-time replies.
// Output: mp3 buffer, sent as Telegram voice message.

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ?? 'pNInz6obpgDQGcFmaJgB'; // Adam
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_turbo_v2_5';

export async function textToSpeech(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  // Truncate very long texts — voice replies should be concise
  const truncated = text.length > 1000 ? text.slice(0, 1000) + '\u2026' : text;

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: truncated,
        model_id: ELEVENLABS_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!resp.ok) {
    return null;
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}
