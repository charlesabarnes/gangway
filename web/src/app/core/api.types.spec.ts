import contract from '../../testing/fixtures/contract.json';
import {
  LOG_STREAMS, PERMISSIONS, PREVIEW_STATES, SCOPE_PERMISSIONS, STREAM_EVENT_TYPES,
  CLEARANCES, FORK_POLICIES, PR_TRIGGERS, RUNTIME_IDS, TRIGGERS, type Template,
  type PreviewSource, type PreviewSourceFiles, type RedeployAccepted, type RedeployDone, type Runtime, type RuntimeList, type AppPlan, type SourceFile, type StreamEvent,
  type ApiToken, type GitHubStatus, type LoginResponse, type Preview, type PreviewEvent, type PreviewList, type Project, type Scope, type SessionInfo, type Visibility,
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
    const github: GitHubStatus = contract.githubStatus as GitHubStatus;
    const repo: Project = contract.project as Project;

    // Every key the server sends is one the type knows, and the other way round.
    const keys = (o: object) => Object.keys(o).sort();
    const PREVIEW_KEYS: (keyof Preview)[] = ['id', 'project', 'hostId', 'kind', 'state', 'source', 'visibility', 'ttlExpiresAt', 'idleAfterMs', 'secretLevel', 'templateId', 'projectId', 'lastSeenAt', 'error', 'createdAt', 'updatedAt', 'destroyedAt', 'urls'];
    const TOKEN_KEYS: (keyof ApiToken)[] = ['id', 'name', 'prefix', 'scopes', 'userId', 'appName', 'expiresAt', 'lastUsedAt', 'revokedAt', 'createdAt'];
    expect(keys(preview)).toEqual([...PREVIEW_KEYS].sort());
    expect(keys(token)).toEqual([...TOKEN_KEYS].sort());
    const REPO_KEYS: (keyof Project)[] = ['id', 'name', 'forge', 'fullName', 'installationId', 'prTrigger', 'slug', 'enabled', 'disabledReason', 'templateId', 'visibility', 'ttl', 'forks', 'drafts', 'prClearance', 'forkClearance', 'createdAt', 'updatedAt'];
    const GITHUB_KEYS: (keyof GitHubStatus)[] = ['configured', 'appId', 'appSlug', 'appUrl', 'installUrl', 'webhookUrl', 'missing', 'managedByConfig'];
    expect(keys(repo)).toEqual([...REPO_KEYS].sort());
    expect(contract.prTriggers).toEqual([...PR_TRIGGERS]);
    const template: Template = contract.template as Template;
    const TEMPLATE_KEYS: (keyof Template)[] = ['id', 'name', 'description', 'builtin', 'visibility', 'ttl', 'idleAfter', 'clearance', 'hostId', 'createdAt', 'updatedAt'];
    expect(keys(template)).toEqual([...TEMPLATE_KEYS].sort());
    expect(contract.triggers).toEqual([...TRIGGERS]);
    expect(keys(github)).toEqual([...GITHUB_KEYS].sort());
    expect(keys(list)).toEqual(['previews', 'seq']);
    expect(keys(login)).toEqual(['permissions', 'user']);
    expect(event.type).toBe('preview.state');
    expect(anonymous.authenticated).toBe(false);
    expect(user.authenticated && user.user?.role.id).toBe('admin');
  });

  it('runtimes, a kept source and a redeploy (ADR-0015)', () => {
    const keys = (o: object) => Object.keys(o).sort();
    const list: RuntimeList = contract.runtimeList as RuntimeList;
    const RUNTIME_KEYS: (keyof Runtime)[] = ['id', 'name', 'language', 'description', 'image', 'port', 'starter', 'versions'];
    expect(keys(list)).toEqual(['detection', 'planFiles', 'runtimes']);
    expect(keys(list.runtimes[0]!)).toEqual([...RUNTIME_KEYS].sort());
    expect(keys(list.detection[0]!)).toEqual(['markers', 'runtime']);
    // ADR-0016: the plan, as the New screen reads it.
    const plan: AppPlan = contract.appPlan as AppPlan;
    const PLAN_KEYS: (keyof AppPlan)[] = ['kind', 'runtime', 'version', 'image', 'root', 'install', 'build', 'start', 'release', 'serve', 'docroot', 'entry', 'port', 'health', 'env', 'stack', 'configFile', 'reasons', 'issues'];
    expect(keys(plan)).toEqual([...PLAN_KEYS].sort());
    expect(keys(plan.reasons[0]!)).toEqual(['found', 'level', 'then']);
    expect([...RUNTIME_IDS]).toEqual(contract.runtimeIds);

    const source: PreviewSourceFiles = contract.previewSource as PreviewSourceFiles;
    const FILE_KEYS: (keyof SourceFile)[] = ['path', 'size', 'text'];
    expect(keys(source)).toEqual(['files', 'runtime', 'truncated']);
    expect(keys(source.files[0]!)).toEqual([...FILE_KEYS].sort());

    const accepted: RedeployAccepted = contract.redeployAccepted;
    const done: RedeployDone = contract.redeployDone as RedeployDone;
    expect(keys(accepted)).toEqual(['buildId']);
    expect(keys(done)).toEqual(['buildId', 'error', 'outcome']);

    const { seq: _seq, ...wire } = contract.redeployEvent;
    const event: StreamEvent = { ...wire, previewId: 'x' } as StreamEvent;
    expect(event.type).toBe('preview.redeploy');
    expect(keys(contract.redeployEvent)).toEqual(['at', 'buildId', 'by', 'phase', 'seq', 'type']);

    const tarball: PreviewSource = contract.tarballSource as PreviewSource;
    expect(tarball.kind === 'tarball' && tarball.runtime).toBe('bun');
  });

  it('every string union the UI switches on lists exactly what the server sends', () => {
    const visibilities: Visibility[] = ['public', 'unlisted', 'private'];
    const scopes: Scope[] = ['read', 'deploy', 'admin'];
    expect([...PREVIEW_STATES]).toEqual(contract.previewStates);
    expect([...LOG_STREAMS]).toEqual(contract.logStreams);
    expect([...STREAM_EVENT_TYPES]).toEqual(contract.streamEventTypes);
    expect(visibilities).toEqual(contract.visibilities);
    expect(scopes).toEqual(contract.scopes);
    expect([...FORK_POLICIES]).toEqual(contract.forkPolicies);
    expect([...CLEARANCES]).toEqual(contract.clearances);
  });

  it('what each token scope grants matches the server, scope by scope', () => {
    const sorted = (o: Record<string, readonly string[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted(SCOPE_PERMISSIONS)).toEqual(sorted(contract.scopePermissions));
  });

  it('the permission ids the UI gates on are exactly the server catalogue', () => {
    expect([...PERMISSIONS].sort()).toEqual([...contract.permissions].sort());
  });
});
