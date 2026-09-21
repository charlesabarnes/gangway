import contract from '../../testing/fixtures/contract.json';
import {
  LOG_STREAMS, PERMISSIONS, PREVIEW_STATES, STREAM_EVENT_TYPES,
  type ApiToken, type LoginResponse, type Preview, type PreviewEvent, type PreviewList, type Scope, type SessionInfo, type Visibility,
} from './api.types';

/**
 * The UI's half of the wire contract. The server's test suite asserts that its REAL output
 * matches `contract.json`; this asserts that file satisfies the types written here. The
 * assignments below are the test -- they fail at COMPILE time, which `ng test` runs.
 */
describe('the /v1 wire contract', () => {
  it('the fixture satisfies the hand-written types', () => {
    const preview: Preview = contract.preview as Preview;
    const list: PreviewList = contract.previewList as PreviewList;
    const event: PreviewEvent = contract.previewEvent as PreviewEvent;
    const anonymous: SessionInfo = contract.sessionAnonymous as SessionInfo;
    const user: SessionInfo = contract.sessionUser as SessionInfo;
    const login: LoginResponse = contract.login as LoginResponse;
    const token: ApiToken = contract.token as ApiToken;

    // Every key the server sends is one the type knows, and the other way round.
    const keys = (o: object) => Object.keys(o).sort();
    const PREVIEW_KEYS: (keyof Preview)[] = ['id', 'project', 'hostId', 'kind', 'state', 'source', 'visibility', 'ttlExpiresAt', 'lastSeenAt', 'error', 'createdAt', 'updatedAt', 'destroyedAt', 'urls'];
    const TOKEN_KEYS: (keyof ApiToken)[] = ['id', 'name', 'prefix', 'scopes', 'userId', 'appName', 'expiresAt', 'lastUsedAt', 'revokedAt', 'createdAt'];
    expect(keys(preview)).toEqual([...PREVIEW_KEYS].sort());
    expect(keys(token)).toEqual([...TOKEN_KEYS].sort());
    expect(keys(list)).toEqual(['previews', 'seq']);
    expect(keys(login)).toEqual(['permissions', 'user']);
    expect(event.type).toBe('preview.state');
    expect(anonymous.authenticated).toBe(false);
    expect(user.authenticated && user.user?.role.id).toBe('admin');
  });

  it('every string union the UI switches on lists exactly what the server sends', () => {
    const visibilities: Visibility[] = ['public', 'unlisted', 'private'];
    const scopes: Scope[] = ['read', 'deploy', 'admin'];
    expect([...PREVIEW_STATES]).toEqual(contract.previewStates);
    expect([...LOG_STREAMS]).toEqual(contract.logStreams);
    expect([...STREAM_EVENT_TYPES]).toEqual(contract.streamEventTypes);
    expect(visibilities).toEqual(contract.visibilities);
    expect(scopes).toEqual(contract.scopes);
  });

  it('the permission ids the UI gates on are exactly the server catalogue', () => {
    expect([...PERMISSIONS].sort()).toEqual([...contract.permissions].sort());
  });
});
