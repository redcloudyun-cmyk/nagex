import crypto from 'node:crypto';

export type ResourcePrefix =
  | 'ten'
  | 'usr'
  | 'mbr'
  | 'agt'
  | 'wfl'
  | 'exe'
  | 'tsk'
  | 'knc'
  | 'kns'
  | 'mem'
  | 'plg'
  | 'pli'
  | 'mdl'
  | 'prv'
  | 'pol'
  | 'apr'
  | 'evt'
  | 'art'
  | 'op'
  | 'aud'
  | 'usg'
  | 'led'
  | 'dlg'
  | 'bac'
  | 'sess'
  | 'brw'
  | 'bev'
  | 'cap'
  | 'cand'
  | 'msg'
  | 'cont';

export function generateResourceId(prefix: ResourcePrefix): string {
  const opaqueId = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${opaqueId}`;
}

export function getCurrentISOString(): string {
  return new Date().toISOString();
}
