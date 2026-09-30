// The docs at gangway.sh/docs. pages.yml builds this into the site's docs/ folder.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

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
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@400;500;600&family=IBM+Plex+Serif:ital,wght@0,400;0,500;1,400;1,500&display=swap",
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
          items: ["use/deploy", "use/agents", "use/pull-requests", "use/sharing", "use/domains"],
        },
        {
          label: "Set up",
          items: ["setup/reverse-proxy", "setup/configuration", "setup/upgrades"],
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
