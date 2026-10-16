// Desktop plan command, version 1 - the WHAT of a Windows desktop action, independent of HOW a device carries it out.
//
//   WHAT  = one canonical action: write a short text into a document of an allowlisted application and save it under a name in an allowlisted folder
//   WHERE = one enrolled device of the signed-in person
//   HOW   = the device's own execution route (UI Automation on the user's desktop); the server never describes UI steps, coordinates or keystrokes
//
// The command carries exactly the fields the person approved. The approval is bound to a hash of this payload (ActionApprovalStore), so a command that differs from what was approved is refused
// before it is queued, and the device refuses anything that is not version 1 of this schema. There is no field for a program path, a shell command, an arbitrary folder or a script, by design.
import crypto from 'node:crypto';

export const DESKTOP_WRITE_SAVE_TOOL_ID = 'device.desktop.document.write_and_save';
export const DESKTOP_PLAN_COMMAND_VERSION = 1;
export const DESKTOP_PLAN_ROUTE = 'WINDOWS_UIA_INTERACTIVE';
export const DESKTOP_PLAN_OPERATION = 'WRITE_TEXT_AND_SAVE';
export const DESKTOP_PLAN_MAX_TEXT_CHARS = 2000;
/** a plan that is not picked up and finished within this long is dead (and never run late) */
export const DESKTOP_PLAN_MAX_TTL_MS = 15 * 60 * 1000;

export type DesktopPlanAppId = 'NOTEPAD';
export type DesktopPlanRootAlias = 'DOCUMENTS';

/** the capability a device advertises (truthfully, only when its executor is present) for each application it can drive */
export const DESKTOP_APP_CAPABILITY: Readonly<Record<DesktopPlanAppId, string>> = Object.freeze({ NOTEPAD: 'desktop:UIA_INTERACTIVE:NOTEPAD' });
const APP_IDS: ReadonlySet<string> = new Set<string>(['NOTEPAD']);
const ROOT_ALIASES: ReadonlySet<string> = new Set<string>(['DOCUMENTS']);

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// A plain document name: letters (incl. Hangul), digits, space, dot, dash, underscore, parentheses; ends in .txt; never a path.
const SAFE_FILE_NAME = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 ._()-]{0,100}\.txt$/;

export interface DesktopWriteAndSaveRequest {
  deviceId: string;
  appId: DesktopPlanAppId;
  text: string;
  rootAlias: DesktopPlanRootAlias;
  fileName: string;
}

export type DesktopPlanValidation = { ok: true } | { ok: false; code: string; message: string };

export function isSafeDesktopFileName(name: unknown): name is string {
  if (typeof name !== 'string' || !SAFE_FILE_NAME.test(name)) return false;
  if (name.includes('..') || /[. ]\.txt$/.test(name) || RESERVED_WINDOWS_NAMES.test(name)) return false;
  return true;
}

export function validateDesktopWriteAndSave(request: Partial<DesktopWriteAndSaveRequest>): DesktopPlanValidation {
  if (typeof request.deviceId !== 'string' || !request.deviceId.trim()) return { ok: false, code: 'DESKTOP_PLAN_DEVICE_REQUIRED', message: 'A device is required.' };
  if (typeof request.appId !== 'string' || !APP_IDS.has(request.appId)) return { ok: false, code: 'DESKTOP_APP_NOT_ALLOWED', message: 'This application is not one NAgex may control.' };
  if (typeof request.rootAlias !== 'string' || !ROOT_ALIASES.has(request.rootAlias)) return { ok: false, code: 'DESKTOP_FOLDER_NOT_ALLOWED', message: 'This folder is not one NAgex may write to.' };
  if (!isSafeDesktopFileName(request.fileName)) return { ok: false, code: 'DESKTOP_FILE_NAME_INVALID', message: 'The file name must be a plain name ending in .txt (no folders).' };
  const text = request.text;
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, code: 'DESKTOP_TEXT_REQUIRED', message: 'The text to write is required.' };
  if (text.length > DESKTOP_PLAN_MAX_TEXT_CHARS) return { ok: false, code: 'DESKTOP_TEXT_TOO_LONG', message: `At most ${DESKTOP_PLAN_MAX_TEXT_CHARS} characters can be written.` };
  // Version 1 writes one line: line endings are rewritten by the application, so an exact read-back would no longer prove anything.
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, code: 'DESKTOP_TEXT_NOT_SINGLE_LINE', message: 'Version 1 writes a single line of text (no line breaks or control characters).' };
  if (text !== text.trim()) return { ok: false, code: 'DESKTOP_TEXT_EDGE_WHITESPACE', message: 'The text must not start or end with a space.' };
  return { ok: true };
}

export function desktopTextSha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The exact fields the person approves. The approval record keeps a hash of this object; the command that is queued must hash to the same value. */
export function desktopWriteAndSaveApprovalPayload(request: DesktopWriteAndSaveRequest): Record<string, unknown> {
  return {
    actionType: DESKTOP_WRITE_SAVE_TOOL_ID,
    operation: DESKTOP_PLAN_OPERATION,
    deviceId: request.deviceId,
    appId: request.appId,
    route: DESKTOP_PLAN_ROUTE,
    interactive: true,
    text: request.text,
    textSha256: desktopTextSha256(request.text),
    rootAlias: request.rootAlias,
    fileName: request.fileName,
    overwrite: false,
  };
}

export interface DesktopWriteAndSavePlanV1 {
  commandVersion: typeof DESKTOP_PLAN_COMMAND_VERSION;
  planId: string;
  executionId: string;
  operation: typeof DESKTOP_PLAN_OPERATION;
  appId: DesktopPlanAppId;
  route: typeof DESKTOP_PLAN_ROUTE;
  text: string;
  textSha256: string;
  rootAlias: DesktopPlanRootAlias;
  fileName: string;
  overwrite: false;
  approvalRef: string;
  deviceId: string;
  principalId: string;
  tenantId: string;
  expiresAt: string;
}

/** The structural check a device makes of a delivered command before it does anything: right version, right shape, text matching its own hash. */
export function parseDesktopWriteAndSavePlan(data: Record<string, unknown>): { ok: true; plan: DesktopWriteAndSavePlanV1 } | { ok: false; code: string } {
  if (data.commandVersion !== DESKTOP_PLAN_COMMAND_VERSION) return { ok: false, code: 'COMMAND_VERSION_UNSUPPORTED' };
  const str = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '');
  if (data.operation !== DESKTOP_PLAN_OPERATION || data.route !== DESKTOP_PLAN_ROUTE || data.overwrite !== false) return { ok: false, code: 'COMMAND_SHAPE_INVALID' };
  const request = { deviceId: str('deviceId'), appId: str('appId') as DesktopPlanAppId, text: str('text'), rootAlias: str('rootAlias') as DesktopPlanRootAlias, fileName: str('fileName') };
  const valid = validateDesktopWriteAndSave(request);
  if (!valid.ok) return { ok: false, code: valid.code };
  if (desktopTextSha256(request.text) !== str('textSha256')) return { ok: false, code: 'COMMAND_TEXT_HASH_MISMATCH' };
  const planId = str('planId');
  const executionId = str('executionId');
  const approvalRef = str('approvalRef');
  const principalId = str('principalId');
  const tenantId = str('tenantId');
  const expiresAt = str('expiresAt');
  if (!planId || !executionId || !approvalRef || !principalId || !tenantId || !Number.isFinite(Date.parse(expiresAt))) return { ok: false, code: 'COMMAND_SHAPE_INVALID' };
  return {
    ok: true,
    plan: {
      commandVersion: DESKTOP_PLAN_COMMAND_VERSION, planId, executionId, operation: DESKTOP_PLAN_OPERATION, appId: request.appId, route: DESKTOP_PLAN_ROUTE,
      text: request.text, textSha256: str('textSha256'), rootAlias: request.rootAlias, fileName: request.fileName, overwrite: false,
      approvalRef, deviceId: request.deviceId, principalId, tenantId, expiresAt,
    },
  };
}
