// A loopback stand-in for the Higgsfield REST API, written from its public documentation (https://docs.higgsfield.ai):
//   POST /estimate/<model path>            -> {"credits":"1.500","usd":"0.094"}
//   POST /<model path>                     -> {"status":"queued","request_id","status_url","cancel_url"}   (Idempotency-Key honoured; same key + other body = 422)
//   GET  /requests/<id>/status             -> queued | in_progress | completed(video.url) | failed | nsfw | canceled
//   POST /requests/<id>/cancel             -> 202 while queued, 400 afterwards
//   POST /files/generate-upload-url        -> {"public_url","upload_url","upload_headers"}  and PUT /upload/<id>
//   Authorization: Key <id>:<secret>       -> 401 {"detail":"Invalid credentials"} otherwise
// It records every call so a test can prove what NAgex sent (and, as importantly, what it did NOT send).
// A pass against it proves NAgex's side of the contract; it is not evidence that the real service answers this way today.
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { makeMp4 } from './_mp4_fixture.js';

export interface FakeHiggsfieldOptions {
  keyId?: string;
  keySecret?: string;
  usd?: number;
  credits?: number;
  /** polls answered "in_progress" before the final state */
  inProgressPolls?: number;
  /** polls answered "queued" first */
  queuedPolls?: number;
  finalState?: 'completed' | 'failed' | 'nsfw';
  failureText?: string;
  mp4?: Buffer;
  /** answer submit with this HTTP status instead of accepting (once per entry, in order) */
  submitFailures?: number[];
  /** a status_url pointing somewhere else: NAgex must not follow it */
  evilStatusUrl?: boolean;
  /** serve something that is not an MP4 at the video address */
  mediaBody?: Buffer;
  mediaContentType?: string;
}

interface Job {
  id: string;
  bodyJson: string;
  path: string;
  polls: number;
  cancelled: boolean;
}

export interface FakeHiggsfield {
  baseUrl: string;
  keyId: string;
  keySecret: string;
  opts: FakeHiggsfieldOptions;
  submits: Array<{ path: string; body: any; idempotencyKey?: string; authorization?: string }>;
  estimates: Array<{ path: string; body: any }>;
  statusPolls: number;
  cancels: number;
  uploads: Array<{ contentType?: string; bytes: number; authorization?: string }>;
  uploadSlots: number;
  evilHits: number;
  jobCount(): number;
  close(): Promise<void>;
}

export async function fakeHiggsfield(options: FakeHiggsfieldOptions = {}): Promise<FakeHiggsfield> {
  const opts: FakeHiggsfieldOptions = { keyId: 'hf_test_id', keySecret: 'hf_test_secret', usd: 0.2, credits: 3.2, inProgressPolls: 1, queuedPolls: 0, finalState: 'completed', ...options };
  const mp4 = opts.mp4 ?? makeMp4();
  const jobs = new Map<string, Job>();
  const byKey = new Map<string, Job>();
  // a test may queue more scripted failures later through fake.opts.submitFailures
  const submitFailures = (opts.submitFailures = [...(opts.submitFailures ?? [])]);
  const fake: FakeHiggsfield = {
    baseUrl: '', keyId: opts.keyId!, keySecret: opts.keySecret!, opts,
    submits: [], estimates: [], statusPolls: 0, cancels: 0, uploads: [], uploadSlots: 0, evilHits: 0,
    jobCount: () => jobs.size,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      const base = fake.baseUrl;

      // the presigned upload and the public media address carry no credentials, like the real ones
      if (req.method === 'PUT' && path.startsWith('/upload/')) {
        fake.uploads.push({ contentType: String(req.headers['content-type'] || ''), bytes: raw.length, authorization: req.headers.authorization as string | undefined });
        res.writeHead(200); res.end(); return;
      }
      if (req.method === 'GET' && path === '/media/video.mp4') {
        const body = opts.mediaBody ?? mp4;
        res.writeHead(200, { 'Content-Type': opts.mediaContentType ?? 'video/mp4', 'Content-Length': body.length });
        res.end(body); return;
      }
      if (req.method === 'GET' && path === '/evil/status') { fake.evilHits += 1; json(res, 200, { status: 'completed' }); return; }

      if (req.headers.authorization !== `Key ${fake.keyId}:${fake.keySecret}`) { json(res, 401, { detail: 'Invalid credentials' }); return; }
      let body: any = null;
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* not json */ }

      if (req.method === 'POST' && path.startsWith('/estimate/')) {
        fake.estimates.push({ path: path.slice('/estimate/'.length), body });
        json(res, 200, { credits: String(opts.credits!.toFixed(3)), usd: String(opts.usd!.toFixed(3)) }); return;
      }
      if (req.method === 'POST' && path === '/files/generate-upload-url') {
        fake.uploadSlots += 1;
        const id = crypto.randomBytes(6).toString('hex');
        json(res, 200, { public_url: `${base}/public/${id}.png`, upload_url: `${base}/upload/${id}`, upload_headers: { 'Content-Type': body?.content_type || 'image/png', 'x-amz-acl': 'public-read' } }); return;
      }
      const statusMatch = /^\/requests\/([^/]+)\/status$/.exec(path);
      if (req.method === 'GET' && statusMatch) {
        fake.statusPolls += 1;
        const job = jobs.get(statusMatch[1]);
        if (!job) { json(res, 404, { detail: 'Request not found' }); return; }
        job.polls += 1;
        if (job.cancelled) { json(res, 200, { status: 'canceled', request_id: job.id }); return; }
        if (job.polls <= (opts.queuedPolls ?? 0)) { json(res, 200, { status: 'queued', request_id: job.id }); return; }
        if (job.polls <= (opts.queuedPolls ?? 0) + (opts.inProgressPolls ?? 0)) { json(res, 200, { status: 'in_progress', request_id: job.id }); return; }
        if (opts.finalState === 'failed') { json(res, 200, { status: 'failed', request_id: job.id, error: opts.failureText ?? 'generation failed' }); return; }
        if (opts.finalState === 'nsfw') { json(res, 200, { status: 'nsfw', request_id: job.id }); return; }
        json(res, 200, { status: 'completed', request_id: job.id, video: { url: `${base}/media/video.mp4` } }); return;
      }
      const cancelMatch = /^\/requests\/([^/]+)\/cancel$/.exec(path);
      if (req.method === 'POST' && cancelMatch) {
        const job = jobs.get(cancelMatch[1]);
        if (!job) { json(res, 404, { detail: 'Request not found' }); return; }
        fake.cancels += 1;
        const queued = job.polls <= (opts.queuedPolls ?? 0);
        if (!queued) { json(res, 400, { detail: 'Request already started' }); return; }
        job.cancelled = true; res.writeHead(202); res.end(); return;
      }
      if (req.method === 'POST') {
        const modelPath = path.replace(/^\//, '');
        fake.submits.push({ path: modelPath, body, idempotencyKey: req.headers['idempotency-key'] as string | undefined, authorization: req.headers.authorization as string | undefined });
        const failure = submitFailures.shift();
        if (failure) { json(res, failure, { detail: `scripted ${failure}` }); return; }
        const key = String(req.headers['idempotency-key'] || '');
        const bodyJson = JSON.stringify(body);
        if (key && byKey.has(key)) {
          const prior = byKey.get(key)!;
          if (prior.bodyJson !== bodyJson) { json(res, 422, { detail: 'idempotency key reused with different parameters' }); return; }
          json(res, 200, { status: 'queued', request_id: prior.id, status_url: `${base}/requests/${prior.id}/status`, cancel_url: `${base}/requests/${prior.id}/cancel` }); return;
        }
        const job: Job = { id: crypto.randomUUID(), bodyJson, path: modelPath, polls: 0, cancelled: false };
        jobs.set(job.id, job);
        if (key) byKey.set(key, job);
        json(res, 200, {
          status: 'queued', request_id: job.id,
          status_url: opts.evilStatusUrl ? 'http://203.0.113.9/evil/status' : `${base}/requests/${job.id}/status`,
          cancel_url: `${base}/requests/${job.id}/cancel`,
        }); return;
      }
      json(res, 404, { detail: 'Not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
