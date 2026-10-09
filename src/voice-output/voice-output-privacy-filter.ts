export interface VoiceOutputPrivacyFilterResult {
  spokenPayload: string;
  rawContextSentToTts: false;
  redactions: string[];
}

export class VoiceOutputPrivacyFilter {
  public filter(input: { spokenText: string; hiddenContext?: unknown; allowCloudTts: boolean }): VoiceOutputPrivacyFilterResult {
    let spokenPayload = input.spokenText;
    const redactions: string[] = [];

    spokenPayload = spokenPayload.replace(/\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, (match) => {
      redactions.push('PHONE_NUMBER');
      return `\uC804\uD654\uBC88\uD638 \uB05D\uC790\uB9AC ${match.replace(/\D/g, '').slice(-4)}`;
    });

    spokenPayload = spokenPayload.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => {
      redactions.push('EMAIL');
      return '\uC774\uBA54\uC77C \uC8FC\uC18C';
    });

    void input.hiddenContext;
    return { spokenPayload, rawContextSentToTts: false, redactions };
  }
}
