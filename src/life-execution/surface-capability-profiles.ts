import type { ExecutionSurface, ExecutionSurfaceCapabilityProfile } from './life-execution.types.js';

export function buildExecutionSurfaceCapabilityProfile(surface: ExecutionSurface): ExecutionSurfaceCapabilityProfile {
  switch (surface) {
    case 'MOBILE':
    case 'ANDROID':
    case 'IOS':
      return {
        surface: 'MOBILE',
        deviceType: 'MOBILE',
        capabilities: [
          'VOICE_INPUT',
          'TEXT_INPUT',
          'SCREEN_OUTPUT',
          'COMPACT_OVERLAY',
          'BROWSER_AUTOMATION',
          'INSTALLED_APP_CONTROL',
          'DEEP_LINK',
          'LOCAL_AUTH',
          'BIOMETRIC_AUTH',
          'PAYMENT_CONFIRMATION',
          'NOTIFICATION',
          'AUDIO_OUTPUT',
          'CAMERA',
          'MICROPHONE',
          'CROSS_DEVICE_HANDOFF',
        ],
        sharedDevice: false,
        authorityState: ['DEVICE_PRESENT', 'USER_IDENTIFIED', 'USER_AUTHORIZED'],
      };
    case 'DESKTOP_APP':
    case 'DESKTOP':
      return {
        surface: 'DESKTOP_APP',
        deviceType: 'DESKTOP_APP',
        capabilities: [
          'VOICE_INPUT',
          'TEXT_INPUT',
          'SCREEN_OUTPUT',
          'BROWSER_AUTOMATION',
          'FILE_ACCESS',
          'LOCAL_AUTH',
          'NOTIFICATION',
          'AUDIO_OUTPUT',
          'MICROPHONE',
          'CROSS_DEVICE_HANDOFF',
        ],
        sharedDevice: false,
        authorityState: ['DEVICE_PRESENT', 'USER_IDENTIFIED', 'USER_AUTHORIZED'],
      };
    case 'DESKTOP_BROWSER':
    case 'WEB':
    case 'BROWSER':
      return {
        surface: 'DESKTOP_BROWSER',
        deviceType: 'DESKTOP_BROWSER',
        capabilities: [
          'TEXT_INPUT',
          'SCREEN_OUTPUT',
          'BROWSER_AUTOMATION',
          'NOTIFICATION',
          'AUDIO_OUTPUT',
          'MICROPHONE',
          'CROSS_DEVICE_HANDOFF',
        ],
        sharedDevice: false,
        authorityState: ['DEVICE_PRESENT', 'USER_IDENTIFIED', 'USER_AUTHORIZED'],
      };
    case 'SMART_TV':
      return {
        surface: 'SMART_TV',
        deviceType: 'SMART_TV',
        capabilities: [
          'VOICE_INPUT',
          'REMOTE_CONTROL_INPUT',
          'SCREEN_OUTPUT',
          'AUDIO_OUTPUT',
          'MICROPHONE',
          'CROSS_DEVICE_HANDOFF',
        ],
        sharedDevice: true,
        authorityState: ['DEVICE_PRESENT'],
        smartTvAuthorityBoundary: {
          userProfileResolution: 'REQUIRED',
          voiceIdentity: 'REQUIRED',
          mobileConfirmation: 'REQUIRED',
          privateDataDisplayPolicy: 'REDACT',
          paymentHandoff: 'REQUIRED',
        },
      };
    case 'TABLET':
      return {
        ...buildExecutionSurfaceCapabilityProfile('MOBILE'),
        surface: 'TABLET',
        deviceType: 'TABLET',
      };
    case 'WEARABLE':
    case 'CAR':
    case 'OTHER':
    default:
      return {
        surface,
        deviceType: surface === 'WEARABLE' || surface === 'CAR' ? surface : 'OTHER',
        capabilities: ['VOICE_INPUT', 'SCREEN_OUTPUT', 'AUDIO_OUTPUT', 'CROSS_DEVICE_HANDOFF'],
        sharedDevice: surface === 'CAR',
        authorityState: ['DEVICE_PRESENT'],
      };
  }
}
