import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface GroupMessage {
  sender: string;
  content: string;
  timestamp: string;
}

let groqApiKey: string | null = null;

function getGroqKey(): string | null {
  if (groqApiKey) return groqApiKey;
  const env = readEnvFile(['GROQ_API_KEY']);
  groqApiKey = env.GROQ_API_KEY || process.env.GROQ_API_KEY || null;
  return groqApiKey;
}

/**
 * LLM-based classification gate for group chats.
 * Uses Groq (llama-3.1-8b-instant) for fast, cheap YES/NO classification.
 * Returns 'error' on any failure so callers can distinguish
 * classifier outage from a genuine NO and log/degrade accordingly.
 */
export type TriggerDecision = 'yes' | 'no' | 'error';

export async function shouldRespondToGroup(
  messages: GroupMessage[],
  assistantName: string,
): Promise<TriggerDecision> {
  const recent = messages.slice(-10);
  if (recent.length === 0) return 'no';

  const userContent = recent.map((m) => `${m.sender}: ${m.content}`).join('\n');

  const apiKey = getGroqKey();
  if (!apiKey) {
    logger.error(
      'smart-trigger: GROQ_API_KEY not found in .env or environment',
    );
    return 'error';
  }

  try {
    const resp = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          max_tokens: 8,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                `You are ${assistantName}, an AI assistant in a group chat. ` +
                'Decide if you should respond to the recent messages. ' +
                'Respond YES if: (1) you are being addressed directly or indirectly, ' +
                '(2) someone is asking a question you can answer, or ' +
                '(3) you genuinely have something valuable to contribute. ' +
                "Respond NO if the conversation doesn't involve you and you have " +
                "nothing meaningful to add. Reply with ONLY 'YES' or 'NO'.",
            },
            { role: 'user', content: userContent },
          ],
        }),
      },
    );

    if (!resp.ok) {
      const errorBody = await resp.text();
      throw new Error(
        `Groq API ${resp.status}: ${errorBody.substring(0, 200)}`,
      );
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    const decision: TriggerDecision = text.toUpperCase().startsWith('YES')
      ? 'yes'
      : 'no';

    logger.info(
      { response: text, decision, messageCount: recent.length },
      'smart-trigger: classification result',
    );

    return decision;
  } catch (err) {
    logger.error({ err }, 'smart-trigger: classification failed');
    return 'error';
  }
}
