import { HttpClient } from '@angular/common/http';
import { Component, Injector, afterNextRender, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Capabilities } from '../../core/api.types';
import { ClipboardService } from '../../ui/clipboard';

export const PLUGIN_REPO = 'charlesabarnes/gangway';

export type AgentClient = 'claude' | 'codex' | 'cursor' | 'vscode' | 'other';
type Step = { note: string; code?: string };
type Recipe = { label: string; steps: Step[]; link?: { href: string; text: string } };

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * Auto mode's trusted-infrastructure note for this server, for ~/.claude/settings.json. Without
 * the server's preview domains, previews are assumed to sit beside the MCP host.
 */
export function autoModeSettings(url: string, previewDomains: readonly string[] = []): string {
  const host = new URL(url).host;
  const previews = previewDomains.length
    ? previewDomains.map((d) => `*.${d}`).join(', ')
    : `*.${host.replace(/^mcp\./, '')}`;
  return JSON.stringify(
    {
      autoMode: {
        environment: [
          '$defaults',
          `Trusted internal domains: ${host}, ${previews}`,
          `gangway (${host}) is my own self-hosted deploy server; sending repo contents, hostnames and infrastructure details to it is deploying, not exfiltration`,
        ],
      },
    },
    null,
    2,
  );
}

function claudeRecipe(url: string, previewDomains: readonly string[]): Recipe {
  return {
    label: 'Claude Code',
    steps: [
      {
        note: 'The plugin brings the MCP server and the /gangway:generate-artifact skill:',
        code: `claude plugin marketplace add ${PLUGIN_REPO} && claude plugin install gangway@gangway --config mcp_url=${url}`,
      },
      {
        note: 'Or the MCP server alone:',
        code: `claude mcp add --transport http gangway ${url}`,
      },
      {
        note: 'Then, in Claude Code, run /mcp and sign in to gangway. This page asks you to approve it.',
      },
      {
        note: 'Suggested: Claude Code has its own artifacts, and when they are on it usually picks them over gangway. To make gangway the default, turn them off in ~/.claude/settings.json:',
        code: '"enableArtifact": false',
      },
      {
        note: 'Or keep them and add a line to ~/.claude/CLAUDE.md:',
        code: '- For any chart, diagram, document, deck or board, use gangway, not Claude artifacts or a local HTML file, unless I ask for those.',
      },
      {
        note: "Auto mode: Claude Code's safety check does not know this server is yours, so it can block a deploy that carries hostnames or other details from a repo as exfiltration. Tell it in ~/.claude/settings.json (it reads this from user settings only):",
        code: autoModeSettings(url, previewDomains),
      },
    ],
  };
}

export function recipes(
  url: string,
  previewDomains: readonly string[] = [],
): Record<AgentClient, Recipe> {
  return {
    claude: claudeRecipe(url, previewDomains),
    codex: {
      label: 'Codex',
      steps: [
        {
          note: 'Add the server. Codex opens this site to sign in; approve it here:',
          code: `codex mcp add gangway --url ${url}`,
        },
        {
          note: 'If the sign-in did not start (or later expired):',
          code: 'codex mcp login gangway',
        },
        {
          note: 'Optional, the generate-artifact skill:',
          code: `codex plugin marketplace add ${PLUGIN_REPO} --sparse .agents --sparse plugin && codex plugin add gangway@gangway`,
        },
      ],
    },
    cursor: {
      label: 'Cursor',
      link: {
        href: `cursor://anysphere.cursor-deeplink/mcp/install?name=gangway&config=${encodeURIComponent(b64(JSON.stringify({ url })))}`,
        text: 'Add to Cursor',
      },
      steps: [
        {
          note: 'Or add it to ~/.cursor/mcp.json:',
          code: JSON.stringify({ mcpServers: { gangway: { url } } }, null, 2),
        },
        {
          note: 'Cursor opens this site to sign in. If it cannot, use an API token (above, deploy scope) as a header: "headers": { "Authorization": "Bearer gw_…" }.',
        },
      ],
    },
    vscode: {
      label: 'VS Code',
      link: {
        href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'gangway', type: 'http', url }))}`,
        text: 'Add to VS Code',
      },
      steps: [
        {
          note: 'Or add it to .vscode/mcp.json:',
          code: JSON.stringify({ servers: { gangway: { type: 'http', url } } }, null, 2),
        },
        { note: 'VS Code opens this site to sign in; approve it here.' },
      ],
    },
    other: {
      label: 'Other',
      steps: [
        { note: 'Any MCP client that speaks Streamable HTTP:', code: url },
        {
          note: 'Sign-in is OAuth 2.1 with PKCE, for clients that register with a Client ID Metadata Document (no dynamic registration). A client that cannot: send an API token from above as "Authorization: Bearer gw_…".',
        },
        {
          note: 'The server explains its own workflow on connect, and offers a generate-artifact prompt.',
        },
      ],
    },
  };
}

const TABS: AgentClient[] = ['claude', 'codex', 'cursor', 'vscode', 'other'];

@Component({
  selector: 'app-connect-agent',
  host: { class: 'contents' },
  template: `
    @if (caps(); as c) {
      <div class="gw-section scroll-mt-6" id="connect-agent">
        <div class="flex flex-col gap-1">
          <h2 class="gw-h2">Connect an agent</h2>
          @if (c.surfaces.mcp) {
            <p class="gw-section-note">
              Let an AI agent deploy here as you. It can do no more than your role allows, and you
              approve it on this site.
            </p>
          }
        </div>
        <div class="min-w-0">
          @if (!c.surfaces.mcp) {
            <p class="text-sm text-muted" data-testid="mcp-off">
              MCP is switched off on this server. An admin can turn it on in Admin → Server.
            </p>
          } @else {
            <div
              class="flex flex-wrap gap-7 border-b border-ink text-[13px] font-medium tracking-[.12em] uppercase"
              role="tablist"
            >
              @for (t of tabs; track t) {
                <button
                  type="button"
                  role="tab"
                  [attr.aria-selected]="tab() === t"
                  (click)="tab.set(t)"
                  [attr.data-testid]="'agent-' + t"
                  class="py-2.5 focus-visible:outline-2 focus-visible:outline-flag"
                  [class]="
                    tab() === t
                      ? 'shadow-[inset_0_-3px_0_var(--gw-flag)]'
                      : 'text-muted hover:text-ink'
                  "
                >
                  {{ all()![t].label }}
                </button>
              }
            </div>
            @if (shown(); as r) {
              <div class="mt-4 flex flex-col gap-4 text-sm" data-testid="agent-recipe">
                @if (r.link) {
                  <a
                    [href]="r.link.href"
                    class="self-start rounded-[2px] bg-primary px-4 py-2.5 text-[13px] font-semibold tracking-[.1em] text-primary-fg uppercase hover:brightness-110"
                    data-testid="agent-link"
                    >{{ r.link.text }}</a
                  >
                }
                @for (s of r.steps; track $index) {
                  <div>
                    <p class="text-muted">{{ s.note }}</p>
                    @if (s.code) {
                      <div class="relative mt-1.5">
                        <pre
                          class="bg-log px-3 py-2.5 pr-16 font-mono text-xs leading-normal break-all whitespace-pre-wrap text-log-fg"
                          data-testid="agent-code"
                          >{{ s.code }}</pre>
                        <button
                          type="button"
                          (click)="copy(s.code, $index)"
                          class="absolute top-2 right-2 text-[11px] font-semibold tracking-[.14em] text-log-fg/70 uppercase hover:text-log-fg"
                          data-testid="agent-copy"
                        >
                          {{ copied() === $index ? 'Copied' : 'Copy' }}
                        </button>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          }
        </div>
      </div>
    }
  `,
})
export class ConnectAgent {
  readonly #http = inject(HttpClient);
  readonly #clipboard = inject(ClipboardService);
  protected readonly tabs = TABS;
  protected readonly caps = signal<Capabilities | null>(null);
  protected readonly tab = signal<AgentClient>('claude');
  protected readonly copied = signal<number | null>(null);
  protected readonly all = computed(() => {
    const c = this.caps();
    return c ? recipes(c.mcpUrl.replace(/\/?$/, '/'), c.previewDomains) : null;
  });
  protected readonly shown = computed(() => this.all()?.[this.tab()] ?? null);

  readonly #route = inject(ActivatedRoute, { optional: true });
  readonly #injector = inject(Injector);

  constructor() {
    firstValueFrom(this.#http.get<Capabilities>('/v1/capabilities')).then(
      (c) => {
        this.caps.set(c);
        // Admin → Surfaces links here once MCP is on; the section only exists after this load.
        if (this.#route?.snapshot.fragment === 'connect-agent')
          afterNextRender(
            () => document.getElementById('connect-agent')?.scrollIntoView({ block: 'start' }),
            { injector: this.#injector },
          );
      },
      () => this.caps.set(null),
    );
  }

  protected async copy(text: string, i: number): Promise<void> {
    if (!(await this.#clipboard.write(text))) return;
    this.copied.set(i);
    setTimeout(() => {
      if (this.copied() === i) this.copied.set(null);
    }, 1500);
  }
}
