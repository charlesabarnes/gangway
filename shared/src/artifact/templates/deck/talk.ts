import {
  block,
  flag,
  front,
  lookOption,
  md,
  num,
  slides,
  str,
  type ArtifactTemplate,
} from "../kit.ts";

export const talk: ArtifactTemplate = {
  id: "deck/talk",
  kind: "deck",
  name: "Talk",
  description:
    "Teach one idea in sections: an agenda, a statement, a diagram, an example, a quote, what to take away.",
  title: "How a request finds your container",
  subtitle: "Hostnames, a routing table and one proxy",
  options: [
    lookOption("sidebar"),
    { key: "sections", label: "Sections", kind: "number", min: 1, max: 3, default: 3 },
    { key: "agenda", label: "Agenda slide", kind: "boolean", default: true },
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
    const sections: [string, string][] = [
      [
        "Names",
        `{layout=statement}\n## Every preview is a hostname; **the hostname is the whole address**.${notes("Nothing else in the URL matters to routing.")}\n\n---\n\n{layout=compare}\n## Two ways to find a preview\n${block("columns", {}, "### By path\n- example.com/pr-42/\n- Every app must know its prefix\n- Cookies leak between previews\n+++\n### By hostname\n- pr-42.example.com\n- Apps run as they would in production\n- Each preview is its own origin")}`,
      ],
      [
        "The table",
        `## One lookup, then one hop\n${flow}${notes("The table lives in memory; the database is only read at boot.")}`,
      ],
      [
        "The proxy",
        `## Streaming both ways\n${
          flag(s, "code")
            ? "```ts\nconst entry = table.lookup(host);\nif (!entry) return unknownPage(host);\nreturn upstream.fetch(req, entry);\n```"
            : "- The request body streams in\n- The response streams out\n- Nothing is buffered"
        }${notes("Three lines carry almost all traffic.")}`,
      ],
    ];
    const used = sections.slice(0, num(s, "sections"));
    const takeaways = block(
      "grid",
      { columns: 3 },
      [
        ["A hostname", "Each preview is its own origin, so apps run as they do in production."],
        ["A lookup", "Routing is one read from a table in memory, never the database."],
        ["A stream", "The proxy passes bodies through as they come; it never waits."],
      ]
        .map(([t, d]) => block("card", { title: t! }, d!))
        .join("\n"),
      4,
    );
    const deck = slides(
      `# ${s.title}\n${s.subtitle}`,
      flag(s, "agenda") &&
        `{layout=agenda}\n## In this talk\n${used.map(([n], i) => `${i + 1}. ${n}`).join("\n")}\n${used.length + 1}. What to take away`,
      ...used.map(([name, body]) => `{layout=section}\n## ${name}\n\n---\n\n${body}`),
      "{layout=quote}\n> Make the common case a lookup, and the rare case a page that says why.\n>\n> — A design note",
      `{layout=section}\n## What to take away\n\n---\n\n{layout=cards}\n## Three things to remember\n${takeaways}`,
      `{layout=end}\n# Thank you\nSlides and notes: the team wiki.`,
    );
    return {
      markdown: md(
        front(s, "deck", { look: str(s, "look"), footer: "Engineering onboarding" }),
        deck,
      ),
    };
  },
};
