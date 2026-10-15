// Local audit harness (NOT part of the repo): runs the certified build in-process with isolated temp stores, creates throwaway signed-in accounts, keeps listening.
const path = require('path');
const R = 'F:/nxprod/dist';
const srv = require(R + '/src/server_web.js');
const { testPeerServerOptions } = require(R + '/tests/_s2e_peer.js');
const { hashPassword } = require(R + '/src/identity/identity.crypto.js');
const mk = (email) => { const { identity } = srv.identityStore.createAccount(email, hashPassword('Audit-Pass-1!')); srv.identityStore.transitionState(identity.userId, 'ACTIVE'); const s = srv.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN'); return { cookie: `nagex_session=${s.sessionId}`, userId: identity.userId, tenantId: `ten_${identity.userId}` }; };
const a = mk('audit_a@example.invalid'); const b = mk('audit_b@example.invalid');
const instance = srv.createServerInstance(testPeerServerOptions());
instance.listen(8191, '127.0.0.1', () => { console.log(JSON.stringify({ ready: true, port: 8191, a, b, dataRoot: process.env.NAGEX_TEST_DATA_ROOT })); });
setInterval(() => { srv.taskScheduler.tick().catch((e) => console.error('tick failed', e && e.message)); }, 5000);

