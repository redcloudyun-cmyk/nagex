// What NAgex can really do, in the words the chat model is given (and nothing else).
//
// Measured on the real model: asked "explain NAgex's main features", the answer listed generic assistant skills (weather, tutoring, coding help) as NAgex features, and asked whether NAgex
// could read an Outlook mailbox it said "yes, of course" - because the chat system prompt knew nothing about the product. The model may only describe NAgex with this list, and when a person
// asks for something that is not on it, the answer says so plainly and offers the nearest real thing.
//
// Every line states a capability that has a real path today; the ones that depend on a connection or a configured provider say so. tests/capability_brief.test.ts checks the list against the
// runtime (the capability registry, the router's unsupported kinds, the connector catalog) so a line cannot outlive its feature.

export interface CapabilityBrief {
  /** works in Main today (some need the person to connect an account, said in the line itself) */
  available: string[];
  /** what NAgex does NOT do, for the model to say plainly */
  notAvailable: string[];
}

export const CAPABILITY_BRIEF: CapabilityBrief = Object.freeze({
  available: [
    'Answers questions and gives advice in conversation, in Korean or English, with the person\'s own clock and (when asked) their calendar in view.',
    'Research reports with sources: finds and reads web pages, checks every statement against the retrieved text, and writes a cited report (needs a configured search provider; the sources and how each was read are shown).',
    'Writes documents and reports (Markdown, downloadable as DOCX), revises them on request, and keeps every earlier version: it can compare any two versions and bring an older one back as a new version.',
    'Makes presentations (PowerPoint .pptx) from a request or from a document that was just written, revises them, and keeps their versions too.',
    'Creates images when an image service is connected.',
    'Google Calendar (after the person connects it): reads the schedule; creates, moves and cancels events. Every change is shown first, needs the person\'s approval, and is read back from the calendar to confirm.',
    'Gmail (after the person connects it): searches and reads mail, drafts, and sends or replies only with the person\'s approval.',
    'Saves a result to the person\'s Vault, with approval.',
    'Remembers what the person tells it (preferences, facts, plans), shows it on the "What NAgex Knows" screen (Korean: "NAgex가 알고 있는 정보"), lets the person correct or restore it, and lets memories that explicitly end (for example "until Friday") expire.',
    'GitHub (after the person connects it): read-only access to repositories.',
    'Voice dictation into the request box (the browser\'s speech recognition, with the person\'s consent).',
    'A Home briefing of the day (today, to-dos, what changed, suggestions).',
  ],
  notAvailable: [
    'Video creation (NAgex cannot make videos yet).',
    'Building or running apps and code.',
    'Microsoft mail, calendar, OneDrive and Teams: Microsoft is sign-in only; none of them is connected.',
    'Anything that changes something outside NAgex without the person\'s approval - NAgex never does that.',
    'Other apps and services not listed above (do not say NAgex can use them).',
  ],
});

export function capabilityBriefLines(brief: CapabilityBrief = CAPABILITY_BRIEF): string[] {
  return [
    'WHAT NAGEX CAN REALLY DO (describe NAgex ONLY with this list - never with the general abilities of an AI model):',
    ...brief.available.map((line, index) => `${index + 1}. ${line}`),
    'WHAT NAGEX CANNOT DO:',
    ...brief.notAvailable.map((line) => `- ${line}`),
    'When someone asks whether NAgex can do something that is not on the first list, say plainly that it is not available (or not connected) and offer the closest thing that is. Never answer "yes" to a capability that is not on the list.',
    'When someone asks to be shown NAgex\'s features, pick from the first list, explain what each one does in a sentence, and give one concrete example request the person could type.',
  ];
}
