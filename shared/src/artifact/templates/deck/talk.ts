import { flag, front, md, num, slides, type ArtifactTemplate } from "../kit.ts";

export const talk: ArtifactTemplate = {
  id: "deck/talk",
  kind: "deck",
  name: "Talk",
  description:
    "Teach one idea in sections: a statement, a diagram, an example, a quote, what to take away.",
  title: "How a request finds your container",
  subtitle: "Hostnames, a routing table and one proxy",
  options: [
    { key: "sections", label: "Sections", kind: "number", min: 1, max: 3, default: 3 },
    { key: "code", label: "Code example", kind: "boolean", default: true },
    { key: "notes", label: "Speaker notes", kind: "boolean", default: true },
  ],
  build(s) {
    const notes = (n: string) => (flag(s, "notes") ? `\n\nNotes: ${n}` : "");
    const flow = [
      '```flow title="One request" direction=LR',
      "flowchart LR",
      "  browser([Browser]) --> proxy[Proxy]",
      "  proxy --> table{Hostname known?}",
      "  table -->|yes| app([Container])",
      "  table -->|no| missing[404 page]",
      "  class missing muted",
      "```",
    ].join("\n");
    const sections = [
      `{layout=section}\n## Names\n\n---\n\n{layout=statement}\n## Every preview is a hostname; the hostname is the whole address.${notes("Nothing else in the URL matters to routing.")}`,
      `{layout=section}\n## The table\n\n---\n\n## One lookup, then one hop\n${flow}${notes("The table lives in memory; the database is only read at boot.")}`,
      `{layout=section}\n## The proxy\n\n---\n\n## Streaming both ways\n${
        flag(s, "code")
          ? "```ts\nconst entry = table.lookup(host);\nif (!entry) return unknownPage(host);\nreturn upstream.fetch(req, entry);\n```"
          : "- The request body streams in\n- The response streams out\n- Nothing is buffered"
      }${notes("Three lines carry almost all traffic.")}`,
    ].slice(0, num(s, "sections"));
    const deck = slides(
      `# ${s.title}\n${s.subtitle}`,
      ...sections,
      "{layout=quote}\n> Make the common case a lookup, and the rare case a page that says why.\n>\n> — A design note",
      `## Take away\n- A preview is a **hostname**\n- Routing is one **in-memory lookup**\n- The proxy **streams**; it never waits for a whole body`,
      `{layout=end}\n# Thank you\nSlides and notes: the team wiki.`,
    );
    return { markdown: md(front(s, "deck", { footer: "Engineering onboarding" }), deck) };
  },
};
