import type { VoiceIntentTone } from './prosody-planner.js';

export interface BrandVoiceSample {
  id: string;
  visualText: string;
  spokenDraft: string;
  tone: VoiceIntentTone;
}

export const BRAND_VOICE_LIVE_SAMPLES: BrandVoiceSample[] = [
  {
    id: 'sample_1_greeting',
    visualText: 'NAgex greeting',
    spokenDraft: '\uC548\uB155\uD558\uC138\uC694. NAgex\uC785\uB2C8\uB2E4. \uD544\uC694\uD55C \uC77C\uC744 \uB9D0\uC500\uD574 \uC8FC\uC138\uC694.',
    tone: 'ACKNOWLEDGEMENT',
  },
  {
    id: 'sample_2_reservation_ready',
    visualText: 'Reservation slot: tomorrow 19:00, 4 people',
    spokenDraft: '\uB0B4\uC77C \uC800\uB141 7\uC2DC\uC5D0 4\uBA85\uC73C\uB85C \uC608\uC57D\uD560 \uC218 \uC788\uC5B4\uC694.',
    tone: 'INFORMATION',
  },
  {
    id: 'sample_3_korail',
    visualText: 'KTX-\uC0B0\uCC9C 315 / \uC218\uC11C 09:00 / \uBD80\uC0B0 11:11',
    spokenDraft: '09:00\uC5D0 \uC218\uC11C\uC5ED\uC5D0\uC11C \uCD9C\uBC1C\uD558\uB294 KTX-\uC0B0\uCC9C 315\uD3B8\uC785\uB2C8\uB2E4.',
    tone: 'INFORMATION',
  },
  {
    id: 'sample_4_call_approval',
    visualText: 'Call approval: \uC870\uBBFC\uD615',
    spokenDraft: '\uC870\uBBFC\uD615\uB2D8\uAED8 \uC804\uD654\uB97C \uAC78\uAE4C\uC694?',
    tone: 'APPROVAL_REQUEST',
  },
  {
    id: 'sample_5_naver_reservation',
    visualText: 'NAVER reservation search',
    spokenDraft: 'NAVER \uC608\uC57D\uC5D0\uC11C \uBA87 \uACF3\uC744 \uCC3E\uC544\uBD24\uC5B4\uC694. 7\uC2DC\uC5D0 \uAC00\uB2A5\uD55C \uACF3\uBD80\uD130 \uD655\uC778\uD574 \uBCFC\uAC8C\uC694.',
    tone: 'INFORMATION',
  },
  {
    id: 'sample_6_mixed_calendar',
    visualText: 'Google Calendar + Microsoft Outlook',
    spokenDraft: 'Google Calendar \uC77C\uC815\uACFC Microsoft Outlook \uC77C\uC815\uC744 \uD568\uAED8 \uD655\uC778\uD588\uC5B4\uC694.',
    tone: 'INFORMATION',
  },
  {
    id: 'sample_7_hotels_price',
    visualText: 'Hotels.com price KRW 128,000',
    spokenDraft: 'Hotels.com\uC5D0\uC11C \uD655\uC778\uD55C \uAC00\uACA9\uC740 KRW 128,000\uC785\uB2C8\uB2E4.',
    tone: 'INFORMATION',
  },
  {
    id: 'sample_8_warning',
    visualText: 'Reservation terms changed before payment',
    spokenDraft: '\uC608\uC57D \uC870\uAC74\uC774 \uBC14\uB00C\uC5C8\uC5B4\uC694. \uACB0\uC81C\uD558\uAE30 \uC804\uC5D0 \uB2E4\uC2DC \uD655\uC778\uD574 \uC8FC\uC138\uC694.',
    tone: 'WARNING',
  },
];
