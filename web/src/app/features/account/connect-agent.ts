import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Capabilities } from '../../core/api.types';

/** Where the Claude Code and Codex plugins are published: a marketplace in gangway's own repository. */
export const PLUGIN_REPO = 'charlesabarnes/gangway';

export type AgentClient = 'claude' | 'codex' | 'cursor' | 'vscode' | 'other';
type Step = { note: string; code?: string };
type Recipe = { label: string; steps: Step[]; link?: { href: string; text: string } };

/** Base64 of UTF-8, as Cursor's install link wants its config. */
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * ADR-0022: how to point each agent at THIS server, with its MCP URL filled in. Every recipe
 * ends in the same place -- the agent's own OAuth sign-in, which lands on /connect -- and
 * the workflow comes with the server (its instructions and `generate-artifact` prompt), so a
 * plugin is a convenience, not a requirement.
 */
export function recipes(url: string): Record<AgentClient, Recipe> {
  return {
    claude: {
      label: 'Claude Code',
      steps: [
        { note: 'The plugin brings the MCP server and the /gangway:generate-artifact skill:', code: `claude plugin marketplace add ${PLUGIN_REPO} && claude plugin install gangway@gangway --config mcp_url=${url}` },
        { note: 'Or the MCP server alone:', code: `claude mcp add --transport http gangway ${url}` },
        { note: 'Then, in Claude Code, run /mcp and sign in to gangway. This page asks you to approve it.' },
      ],
    },
    codex: {
      label: 'Codex',
      steps: [
        { note: 'Add the server. Codex opens this site to sign in; approve it here:', code: `codex mcp add gangway --url ${url}` },
        { note: 'If the sign-in did not start (or later expired):', code: 'codex mcp login gangway' },
        { note: 'Optional, the generate-artifact skill:', code: `codex plugin marketplace add ${PLUGIN_REPO} --sparse .agents --sparse plugin && codex plugin add gangway@gangway` },
      ],
    },
    cursor: {
      label: 'Cursor',
      link: { href: `cursor://anysphere.cursor-deeplink/mcp/install?name=gangway&config=${encodeURIComponent(b64(JSON.stringify({ url })))}`, text: 'Add to Cursor' },
      steps: [
        { note: 'Or add it to ~/.cursor/mcp.json:', code: JSON.stringify({ mcpServers: { gangway: { url } } }, null, 2) },
        { note: 'Cursor opens this site to sign in. If it cannot, use an API token (above, deploy scope) as a header: "headers": { "Authorization": "Bearer gw_…" }.' },
      ],
    },
    vscode: {
      label: 'VS Code',
      link: { href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'gangway', type: 'http', url }))}`, text: 'Add to VS Code' },
      steps: [
        { note: 'Or add it to .vscode/mcp.json:', code: JSON.stringify({ servers: { gangway: { type: 'http', url } } }, null, 2) },
        { note: 'VS Code opens this site to sign in; approve it here.' },
      ],
    },
    other: {
      label: 'Other',
      steps: [
        { note: 'Any MCP client that speaks Streamable HTTP:', code: url },
        { note: 'Sign-in is OAuth 2.1 with PKCE, for clients that register with a Client ID Metadata Document (no dynamic registration). A client that cannot: send an API token from above as "Authorization: Bearer gw_…".' },
        { note: 'The server explains its own workflow on connect, and offers a generate-artifact prompt.' },
      ],
    },
  };
}

const TABS: AgentClient[] = ['claude', 'codex', 'cursor', 'vscode', 'other'];

@Component({
  selector: 'app-connect-agent',
  template: `
    @if (caps(); as c) {
      <h2 class="mt-10 text-base font-semibold">Connect an agent</h2>
      @if (!c.surfaces.mcp) {
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400" data-testid="mcp-off">MCP is switched off on this server. An admin can turn it on in Settings → Surfaces.</p>
      } @else {
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Let an AI agent deploy here as you. It can do no more than your role allows, and you approve it on this site.</p>
        <div class="mt-3 flex flex-wrap gap-1 border-b border-neutral-200 text-sm dark:border-neutral-800" role="tablist">
          @for (t of tabs; track t) {
            <button type="button" role="tab" [attr.aria-selected]="tab() === t" (click)="tab.set(t)" [attr.data-testid]="'agent-' + t"
              class="-mb-px border-b-2 px-3 py-2" [class]="tab() === t ? 'border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100' : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'">{{ all()![t].label }}</button>
          }
        </div>
        @if (shown(); as r) {
          <div class="mt-4 space-y-4 text-sm" data-testid="agent-recipe">
            @if (r.link) {
              <a [href]="r.link.href" class="inline-flex rounded-md bg-accent px-3.5 py-2 font-medium text-white hover:brightness-110" data-testid="agent-link">{{ r.link.text }}</a>
            }
            @for (s of r.steps; track $index) {
              <div>
                <p class="text-neutral-700 dark:text-neutral-300">{{ s.note }}</p>
                @if (s.code) {
                  <div class="relative mt-1.5">
                    <pre class="whitespace-pre-wrap break-all rounded-md bg-neutral-100 p-3 pr-16 font-mono text-xs dark:bg-neutral-900" data-testid="agent-code">{{ s.code }}</pre>
                    <button type="button" (click)="copy(s.code, $index)" class="absolute right-2 top-2 rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-600 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400" data-testid="agent-copy">{{ copied() === $index ? 'Copied' : 'Copy' }}</button>
                  </div>
                }
              </div>
            }
          </div>
        }
      }
    }
  `,
})
export class ConnectAgent {
  readonly #http = inject(HttpClient);
  protected readonly tabs = TABS;
  protected readonly caps = signal<Capabilities | null>(null);
  protected readonly tab = signal<AgentClient>('claude');
  protected readonly copied = signal<number | null>(null);
  /** The MCP URL with a trailing slash: the form every client's config stores it in. */
  protected readonly all = computed(() => { const c = this.caps(); return c ? recipes(c.mcpUrl.replace(/\/?$/, '/')) : null; });
  protected readonly shown = computed(() => this.all()?.[this.tab()] ?? null);

  constructor() {
    firstValueFrom(this.#http.get<Capabilities>('/v1/capabilities')).then((c) => this.caps.set(c), () => this.caps.set(null));
  }

  protected async copy(text: string, i: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(i);
      setTimeout(() => { if (this.copied() === i) this.copied.set(null); }, 1500);
    } catch { /* no clipboard: the text is selectable */ }
  }
}
