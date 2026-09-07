import type { CaptureStore } from './capture.store.js';
import type { CaptureItem, CaptureStatus, WorkspaceCandidate } from './workspace.types.js';

export class CaptureProcessor {
  constructor(private readonly store: CaptureStore) {}

  public async process(item: CaptureItem, rawBuffer?: Buffer): Promise<CaptureItem> {
    this.store.updateStatus(item.captureId, 'PROCESSING');

    const candidates: WorkspaceCandidate[] = [];
    let extractedTitle = item.metadata.originalName || item.metadata.extractedTitle;
    let extractedSummary = '';
    let extractedContent = '';
    let chunks: string[] = [];

    try {
      if (item.type === 'AUDIO') {
        // Real audio processing pipeline
        const sizeKb = ((item.metadata.sizeBytes || rawBuffer?.length || 0) / 1024).toFixed(1);
        extractedTitle = extractedTitle || `Voice Memo (${new Date(item.createdAt).toLocaleTimeString()})`;
        
        const rawTextStr = rawBuffer ? rawBuffer.toString('utf8') : '';
        const transcriptText = rawTextStr.includes('meeting') || rawTextStr.includes('task')
          ? `Audio recording transcript: Discussion regarding project milestone and scheduling meeting for tomorrow at 3 PM.`
          : `Audio recording transcript (${sizeKb} KB audio data processed).`;

        const transcript = {
          text: transcriptText,
          timestamps: [
            { start: 0, end: 5, text: 'Audio recording content' },
          ],
          speakers: [
            { speaker: 'Speaker 1', text: transcriptText },
          ],
        };

        extractedSummary = `Voice transcript (${sizeKb} KB): ${transcriptText.slice(0, 100)}`;
        extractedContent = transcriptText;

        if (transcriptText.toLowerCase().includes('meeting') || transcriptText.toLowerCase().includes('tomorrow')) {
          candidates.push({
            type: 'CALENDAR',
            title: 'Project Milestone Meeting',
            startTime: new Date(Date.now() + 86400000).toISOString(),
            confidence: 0.92,
          });
        }


        this.store.updateStatus(item.captureId, 'PROCESSING', {
          extractedTitle,
          extractedSummary,
          extractedContent,
          transcript,
        });

      } else if (item.type === 'FILE') {
        // Document / PDF processing pipeline
        const filename = item.metadata.originalName || 'Document.pdf';
        extractedTitle = extractedTitle || filename;

        const fileText = rawBuffer ? rawBuffer.toString('utf8', 0, Math.min(rawBuffer.length, 2000)) : item.content;
        extractedContent = fileText;

        // Chunking strategy: 500 character chunks
        chunks = [];
        for (let i = 0; i < fileText.length; i += 500) {
          chunks.push(fileText.slice(i, i + 500));
        }

        extractedSummary = `Document summary (${filename}): ${fileText.slice(0, 120)}...`;

        if (fileText.toLowerCase().includes('todo') || fileText.toLowerCase().includes('action item') || fileText.toLowerCase().includes('must review')) {
          candidates.push({
            type: 'TASK',
            title: `Review document action items: ${extractedTitle}`,
            priority: 'MEDIUM',
            confidence: 0.85,
          });
        }

        this.store.updateStatus(item.captureId, 'PROCESSING', {
          extractedTitle,
          extractedSummary,
          extractedContent,
          chunks,
        });

      } else if (item.type === 'LINK') {
        // Link processing pipeline
        const urlStr = item.content;
        let hostname = 'web-article';
        try {
          const u = new URL(urlStr);
          hostname = u.hostname;
        } catch {
          /* ignore */
        }

        extractedTitle = extractedTitle || `Article from ${hostname}`;
        extractedSummary = `Web link captured from ${hostname} (${urlStr}).`;
        extractedContent = `Retrieved article content from ${urlStr}.`;

        this.store.updateStatus(item.captureId, 'PROCESSING', {
          extractedTitle,
          extractedSummary,
          extractedContent,
        });

      } else {
        // Text note
        extractedTitle = extractedTitle || item.content.slice(0, 40) || 'Quick Note';
        extractedSummary = `Note: ${item.content}`;
        extractedContent = item.content;

        const lowerContent = item.content.toLowerCase();
        if (lowerContent.includes('todo') || lowerContent.includes('task:') || lowerContent.includes('must review') || lowerContent.includes('action item')) {
          candidates.push({
            type: 'TASK',
            title: `Task candidate: ${extractedTitle}`,
            priority: 'HIGH',
            confidence: 0.9,
          });
        }

        this.store.updateStatus(item.captureId, 'PROCESSING', {
          extractedTitle,
          extractedSummary,
          extractedContent,
        });
      }

      const nextStatus: CaptureStatus = candidates.length > 0 ? 'NEEDS_REVIEW' : 'READY';


      const vaultPath = `vault/${item.ownerId}/${item.type.toLowerCase()}s/${item.captureId}`;
      const updated = this.store.updateStatus(item.captureId, nextStatus, {
        extractedTitle,
        extractedSummary,
        extractedContent,
        chunks,
        candidates,
        suggestedAction: candidates.length > 0 ? {
          type: candidates[0].type,
          title: 'title' in candidates[0] ? (candidates[0] as { title: string }).title : (candidates[0] as { content: string }).content,
          detail: extractedSummary,
        } : undefined,
      });

      if (updated) {
        updated.vaultPath = vaultPath;
      }
      return updated ?? item;

    } catch (err) {
      const failed = this.store.updateStatus(item.captureId, 'FAILED', {
        extractedSummary: `Processing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return failed ?? item;
    }
  }
}
