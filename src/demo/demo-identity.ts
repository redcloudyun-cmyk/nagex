// The fixed synthetic demo persona. Server-defined constants: a client can
// never choose a different demo tenant/principal. Used by the demo seed
// (create-nagex-application) and by the explicit demo allow-list in
// src/http/route-access.ts — never as an authentication fallback.
export const DEMO_TENANT_ID = 'ten_demo_hackathon';
export const DEMO_OWNER_ID = 'usr_demo_alex';
