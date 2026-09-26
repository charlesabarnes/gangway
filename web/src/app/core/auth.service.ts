import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LoginResponse, Permission, SessionInfo, SessionUser } from './api.types';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly #http = inject(HttpClient);

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
  readonly unreachable = signal(false);

  can(permission: Permission): boolean {
    return this.permissions().has(permission);
  }

  ensureLoaded(): Promise<void> {
    if (this.loaded()) return Promise.resolve();
    return (this.#loading ??= this.refresh().finally(() => {
      this.#loading = null;
    }));
  }

  async refresh(): Promise<void> {
    try {
      const early = this.#prefetched();
      this.#set(
        (early && (await early.catch(() => null))) ??
          (await firstValueFrom(this.#http.get<SessionInfo>('/v1/auth/session'))),
      );
      this.unreachable.set(false);
    } catch {
      this.#set({ authenticated: false, setupRequired: false });
      this.unreachable.set(true);
    }
  }

  /** The session index.html asked for before the app loaded; used once. */
  #prefetched(): Promise<SessionInfo> | undefined {
    const w = window as { gwSession?: Promise<SessionInfo> };
    const early = w.gwSession;
    delete w.gwSession;
    return early;
  }

  #set(info: SessionInfo): void {
    this.#info.set(info);
    try {
      if (info.authenticated) localStorage.setItem('gw-signed-in', '1');
      else localStorage.removeItem('gw-signed-in');
    } catch {
      // Storage may be off; the header then just waits for the app.
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
    try {
      await firstValueFrom(this.#http.post('/v1/auth/logout', null));
    } finally {
      this.clear();
    }
  }

  clear(): void {
    this.#set({ authenticated: false, setupRequired: false });
  }

  #signedIn(r: LoginResponse): void {
    this.#set({
      authenticated: true,
      setupRequired: false,
      user: r.user,
      permissions: r.permissions,
    });
    this.unreachable.set(false);
  }
}
