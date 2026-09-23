import { Component } from '@angular/core';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { Capabilities } from '../../core/api.types';
import { ConnectAgent, PLUGIN_REPO, recipes } from './connect-agent';

@Component({ imports: [ConnectAgent], template: '<app-connect-agent />' })
class Host {}

const MCP = 'https://mcp.preview.example.com';

async function open(
  caps: Capabilities = {
    ...(contract.capabilities as Capabilities),
    surfaces: { ui: true, mcp: true },
    mcpUrl: MCP,
  },
) {
  const r = await render(Host);
  r.http.expectOne('/v1/capabilities').flush(caps);
  await r.settle();
  return r;
}

describe('ConnectAgent', () => {
  it("fills THIS server's MCP URL into every client's recipe, Claude Code first", async () => {
    const r = await open();
    const codes = () =>
      Array.from(r.el.querySelectorAll('[data-testid="agent-code"]')).map(
        (e) => e.textContent ?? '',
      );
    expect(codes()[0]).toBe(
      `claude plugin marketplace add ${PLUGIN_REPO} && claude plugin install gangway@gangway --config mcp_url=${MCP}/`,
    );
    (r.byTestId('agent-codex') as HTMLButtonElement).click();
    await r.settle();
    expect(codes()[0]).toBe(`codex mcp add gangway --url ${MCP}/`);
    (r.byTestId('agent-vscode') as HTMLButtonElement).click();
    await r.settle();
    const link = r.byTestId('agent-link') as HTMLAnchorElement;
    expect(
      JSON.parse(decodeURIComponent(link.getAttribute('href')!.replace('vscode:mcp/install?', ''))),
    ).toEqual({ name: 'gangway', type: 'http', url: `${MCP}/` });
  });

  it("Cursor's install link carries the config as base64 JSON", () => {
    const href = recipes(`${MCP}/`).cursor.link!.href;
    const config = new URL(href).searchParams.get('config')!;
    expect(JSON.parse(atob(config))).toEqual({ url: `${MCP}/` });
  });

  it('says so, and offers nothing to copy, when MCP is switched off', async () => {
    const r = await open({ surfaces: { ui: true, mcp: false }, mcpUrl: MCP });
    expect(r.byTestId('mcp-off')).not.toBeNull();
    expect(r.byTestId('agent-recipe')).toBeNull();
  });
});
