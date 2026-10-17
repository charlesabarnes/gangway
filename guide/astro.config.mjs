// The docs at gangway.sh/docs. pages.yml builds this into the site's docs/ folder.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@400;500;600&family=IBM+Plex+Serif:ital,wght@0,400;0,500;1,400;1,500&display=swap";

export default defineConfig({
  site: "https://gangway.sh",
  base: "/docs",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "gangway",
      description: "Self-hosted preview URLs for pull requests, agents and people.",
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/charlesabarnes/gangway" },
      ],
      editLink: { baseUrl: "https://github.com/charlesabarnes/gangway/edit/master/guide/" },
      customCss: ["./src/styles/theme.css"],
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
        },
        // Fonts load without blocking the first paint; display=swap shows the fallback meanwhile.
        {
          tag: "link",
          attrs: { rel: "stylesheet", href: FONTS, media: "print", onload: "this.media='all'" },
        },
        { tag: "noscript", content: `<link rel="stylesheet" href="${FONTS}" />` },
        // Starlight sets a large twitter:card but no image; share gangway.sh's.
        {
          tag: "meta",
          attrs: { property: "og:image", content: "https://gangway.sh/assets/og.png" },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content:
              "gangway, open source under Apache 2.0: full-stack artifacts on your domain, beside a list of decks, dashboards and tools and their states.",
          },
        },
        // gangway.sh keeps its theme choice as gw-theme; start the docs on the same one.
        {
          tag: "script",
          content:
            'try{var t=localStorage.getItem("gw-theme");if((t==="light"||t==="dark")&&!localStorage.getItem("starlight-theme"))localStorage.setItem("starlight-theme",t)}catch(e){}',
        },
        // The same cookieless page count as gangway.sh (waitlist/ has the Worker).
        {
          tag: "script",
          content:
            'if(location.hostname==="gangway.sh"&&navigator.sendBeacon)navigator.sendBeacon("https://gangway-waitlist.charles-2cc.workers.dev/hit",location.pathname)',
        },
      ],
      sidebar: [
        { label: "Start here", items: ["", "quickstart"] },
        {
          label: "Install",
          items: [
            "install/linux",
            "install/unraid",
            "install/vm",
            "install/laptop",
            "install/modes",
          ],
        },
        {
          label: "Use it",
          items: [
            "use/deploy",
            "use/agents",
            "use/chatgpt",
            "use/mcp-clients",
            "use/pull-requests",
            "use/branch-deploys",
            "use/sharing",
            "use/domains",
          ],
        },
        {
          label: "Set up",
          items: ["setup/reverse-proxy", "setup/configuration", "setup/sso", "setup/upgrades"],
        },
        {
          label: "Alternatives",
          items: [
            "alternatives/self-hosted-llms",
            "alternatives/chatgpt-sites",
            "alternatives/claude-artifacts",
          ],
        },
        {
          label: "Reference",
          items: [
            "reference/gangway-yml",
            "reference/security",
            "reference/limits",
            "reference/troubleshooting",
          ],
        },
      ],
    }),
  ],
});
