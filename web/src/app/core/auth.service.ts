import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LoginResponse, Permission, SessionInfo, SessionUser } from './api.types';

/**
 * Who is using the UI, and what they may do. The session itself is an httpOnly cookie this
 * code can never read; what it knows comes from `GET /v1/auth/session`, which is always 200.
 *
 * The UI gates on PERMISSIONS, never on a role name: which role holds what is the
 * operator's to change, and the server re-resolves it on every request. So `can()` is
 * advice about what to SHOW -- the server still refuses what is not allowed -- and
 * `refresh()` exists because the answer can change under an open tab.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly #http = inject(HttpClient);

  /** null until the first answer arrives. */
  readonly #info = signal<SessionInfo | null>(null);
  #loading: Promise<void> | null = null;

  readonly loaded = computed(() => this.#info() !== null);
  readonly authenticated = computed(() => this.#info()?.authenticated === true);
  readonly setupRequired = computed(() => this.#info()?.setupRequired === true);
  readonly user = computed<SessionUser | null>(() => {
    const i = this.#info();
    return i?.authenticated ? (i.user ?? null) : null;
  });
  readonly permissions = computed<ReadonlySet<Permission>>(() => {
    const i = this.#info();
    return new Set(i?.authenticated ? i.permissions : []);
  });
  /** The session endpoint itself could not be reached: not "logged out", just unknown. */
  readonly unreachable = signal(false);

  can(permission: Permission): boolean {
    return this.permissions().has(permission);
  }

  /** Asked once, however many guards and components want it at the same moment. */
  ensureLoaded(): Promise<void> {
    if (this.loaded()) return Promise.resolve();
    return (this.#loading ??= this.refresh().finally(() => {
      this.#loading = null;
    }));
  }

  async refresh(): Promise<void> {
    try {
      this.#info.set(await firstValueFrom(this.#http.get<SessionInfo>('/v1/auth/session')));
      this.unreachable.set(false);
    } catch {
      // Treat as anonymous so the router has somewhere to go; the login page says why.
      this.#info.set({ authenticated: false, setupRequired: false });
      this.unreachable.set(true);
    }
  }

  async login(email: string, password: string): Promise<void> {
    this.#signedIn(
      await firstValueFrom(this.#http.post<LoginResponse>('/v1/auth/login', { email, password })),
    );
  }

  async setup(token: string, email: string, password: string): Promise<void> {
    this.#signedIn(
      await firstValueFrom(
        this.#http.post<LoginResponse>('/v1/auth/setup', { token, email, password }),
      ),
    );
  }

  async logout(): Promise<void> {
    // Whatever the server says, this tab is done with the session.
    try {
      await firstValueFrom(this.#http.post('/v1/auth/logout', null));
    } finally {
      this.clear();
    }
  }

  /** The server said 401: the cookie is gone or expired. */
  clear(): void {
    this.#info.set({ authenticated: false, setupRequired: false });
  }

  #signedIn(r: LoginResponse): void {
    this.#info.set({
      authenticated: true,
      setupRequired: false,
      user: r.user,
      permissions: r.permissions,
    });
    this.unreachable.set(false);
  }
}
