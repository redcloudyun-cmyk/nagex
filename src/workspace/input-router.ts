export type InputIntent =
  | 'ASK'
  | 'COMMAND'
  | 'CAPTURE'
  | 'UPLOAD'
  | 'LINK_CAPTURE'
  | 'AUDIO_CAPTURE';

export interface InputClassificationResult {
  primaryIntent: InputIntent;
  confidence: number;
  reason: string;
  normalizedPayload: {
    rawInput: string;
    url?: string;
    mimeType?: string;
    cleanText?: string;
  };
}

export class InputRouter {
  public classify(input: {
    text?: string;
    hasFile?: boolean;
    hasAudio?: boolean;
    mimeType?: string;
  }): InputClassificationResult {
    return InputRouter.classify(input);
  }

  public static classify(input: {
    text?: string;
    hasFile?: boolean;
    hasAudio?: boolean;
    mimeType?: string;
  }): InputClassificationResult {

    const rawText = (input.text || '').trim();

    // 1. Audio Capture Primary Path
    if (input.hasAudio || (input.mimeType && input.mimeType.startsWith('audio/'))) {
      return {
        primaryIntent: 'AUDIO_CAPTURE',
        confidence: 0.98,
        reason: 'Input contains real audio payload or audio MIME type',
        normalizedPayload: { rawInput: rawText, mimeType: input.mimeType || 'audio/webm' },
      };
    }

    // 2. Binary File Upload Primary Path
    if (input.hasFile) {
      return {
        primaryIntent: 'UPLOAD',
        confidence: 0.98,
        reason: 'Input contains file payload',
        normalizedPayload: { rawInput: rawText, mimeType: input.mimeType || 'application/octet-stream' },
      };
    }

    // 3. Link Capture Primary Path
    const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      const url = urlMatch[0];
      // If the text is ONLY a URL or "save link https://...", classify as LINK_CAPTURE
      if (rawText.length === url.length || rawText.toLowerCase().startsWith('save') || rawText.toLowerCase().startsWith('link')) {
        return {
          primaryIntent: 'LINK_CAPTURE',
          confidence: 0.95,
          reason: 'Input is a standalone URL or explicit link capture request',
          normalizedPayload: { rawInput: rawText, url },
        };
      }
    }

    const lower = rawText.toLowerCase();

    // 4. Capture Primary Path (explicit save / note / idea / remember)
    if (
      lower.startsWith('remember') ||
      lower.startsWith('note') ||
      lower.startsWith('idea:') ||
      lower.startsWith('save note') ||
      lower.startsWith('keep note')
    ) {
      return {
        primaryIntent: 'CAPTURE',
        confidence: 0.9,
        reason: 'Input contains explicit capture/note keyword prefix',
        normalizedPayload: { rawInput: rawText, cleanText: rawText.replace(/^(remember|note|idea:|save note|keep note)\s*/i, '') },
      };
    }

    // 5. Command Primary Path (imperative actions)
    if (
      lower.startsWith('schedule') ||
      lower.startsWith('create') ||
      lower.startsWith('delete') ||
      lower.startsWith('send email') ||
      lower.startsWith('book') ||
      lower.startsWith('cancel') ||
      lower.startsWith('run')
    ) {
      return {
        primaryIntent: 'COMMAND',
        confidence: 0.88,
        reason: 'Input starts with action imperative keyword',
        normalizedPayload: { rawInput: rawText },
      };
    }

    // 6. Ask Primary Path (conversational query)
    if (
      rawText.endsWith('?') ||
      lower.startsWith('what') ||
      lower.startsWith('who') ||
      lower.startsWith('why') ||
      lower.startsWith('how') ||
      lower.startsWith('where') ||
      lower.startsWith('explain') ||
      lower.startsWith('tell me')
    ) {
      return {
        primaryIntent: 'ASK',
        confidence: 0.92,
        reason: 'Input is a conversational query or question',
        normalizedPayload: { rawInput: rawText },
      };
    }

    // Default fallback: Default to ASK for general natural language queries
    return {
      primaryIntent: 'ASK',
      confidence: 0.75,
      reason: 'General natural language prompt defaulted to ASK query',
      normalizedPayload: { rawInput: rawText },
    };
  }
}
