import {
  block,
  front,
  md,
  num,
  slides,
  str,
  type ArtifactTemplate,
  type TemplateOption,
} from "./kit.ts";

const DEVICE: TemplateOption = {
  key: "device",
  label: "Device",
  kind: "choice",
  default: "phone",
  choices: [
    { value: "phone", label: "Phone" },
    { value: "desktop", label: "Desktop" },
  ],
};

const ITEMS = [
  ["Harbour Kitchen", "Seafood · 0.4 mi", "19:30"],
  ["Olive & Ash", "Mediterranean · 0.7 mi", "20:00"],
  ["Noodle Bar Kin", "Ramen · 1.1 mi", "19:15"],
  ["The Glasshouse", "Seasonal · 1.6 mi", "21:00"],
  ["Little Tagine", "Moroccan · 1.9 mi", "18:45"],
  ["Pier Nine", "Grill · 2.2 mi", "20:30"],
  ["Saffron Room", "Indian · 2.4 mi", "19:45"],
  ["Casa Verde", "Mexican · 2.8 mi", "21:15"],
] as const;

const listDetail: ArtifactTemplate = {
  id: "prototype/list-detail",
  kind: "prototype",
  name: "List and detail",
  description: "Browse a list, open an item, act on it, see a confirmation.",
  title: "Book a table",
  subtitle: "Pick a place, choose a time, confirm",
  options: [
    { key: "items", label: "List items", kind: "number", min: 3, max: 8, default: 4 },
    DEVICE,
  ],
  build(s) {
    const list = ITEMS.slice(0, num(s, "items"))
      .map(([t, meta, time]) => `- [**${t}** · ${meta} :flag[${time}]{tone=ok}](#detail)`)
      .join("\n");
    const screens = slides(
      `{#home title="${s.title}"}\n${s.subtitle || "Choose one to see more."}\n\n${list}`,
      `{#detail title="${ITEMS[0][0]}" back=home}\nDay-boat fish, cooked over charcoal. **Tables free at 19:30 and 21:15.**\n\n:flag[Open now]{tone=ok} :flag[Busy]{tone=warn}\n\n:button[Book a table]{go=form}`,
      '{#form title="Your booking" back=detail}\n:input[Name]{name=name placeholder="Who is it for?"}\n\n:select[Time]{name=time options="19:30,21:15"}\n\n:toggle[Text me a reminder]{name=remind on}\n\n:button[Confirm]{go=done}',
      `{#done title="Booked"}\n${block("callout", { tone: "ok", title: "See you at {{time}}" }, "We sent the details to your phone.")}\n\n:button[Back to the list]{go=home ghost}`,
    );
    return {
      markdown: md(front(s, "prototype", { device: str(s, "device"), start: "home" }), screens),
    };
  },
};

const STEPS = [
  { title: "Your details", field: ':input[Full name]{name=name placeholder="Ada Lovelace"}' },
  { title: "Your team", field: ':input[Team name]{name=team placeholder="Platform"}' },
  {
    title: "Invite people",
    field: ':input[Email addresses]{name=invites placeholder="a@example.com, b@example.com"}',
  },
  {
    title: "Your first project",
    field: ':input[Project name]{name=project placeholder="Website"}',
  },
  { title: "Notifications", field: ":toggle[Email me a weekly summary]{name=weekly on}" },
];

const onboarding: ArtifactTemplate = {
  id: "prototype/onboarding",
  kind: "prototype",
  name: "Onboarding flow",
  description: "A step-by-step sign-up: a welcome, one screen per step with progress, a finish.",
  title: "Welcome aboard",
  subtitle: "Set up your account in a minute",
  options: [{ key: "steps", label: "Steps", kind: "number", min: 2, max: 5, default: 3 }, DEVICE],
  build(s) {
    const steps = STEPS.slice(0, num(s, "steps"));
    const id = (i: number) => (i < steps.length ? `step-${i + 1}` : "finish");
    const screens = slides(
      `{#welcome}\n# ${s.title}\n${s.subtitle || "It takes about a minute."}\n\n:button[Get started]{go=step-1}`,
      ...steps.map(
        (st, i) =>
          `{#${id(i)} title="Step ${i + 1} of ${steps.length}" back=${i === 0 ? "welcome" : id(i - 1)}}\n## ${st.title}\n${st.field}\n\n:button[${i === steps.length - 1 ? "Finish" : "Continue"}]{go=${id(i + 1)}}`,
      ),
      `{#finish title="Done"}\n${block("callout", { tone: "ok", title: "You're all set, {{name}}" }, "Your workspace is ready.")}\n\n:button[Start over]{go=welcome ghost}`,
    );
    return {
      markdown: md(front(s, "prototype", { device: str(s, "device"), start: "welcome" }), screens),
    };
  },
};

const GROUPS = [
  {
    title: "Profile",
    fields: [
      ':input[Display name]{name=display value="Ada"}',
      ":input[Email]{name=email type=email}",
    ],
  },
  {
    title: "Notifications",
    fields: [":toggle[Email updates]{name=emails on}", ":toggle[Push notifications]{name=push}"],
  },
  {
    title: "Privacy",
    fields: [
      ":toggle[Show my profile publicly]{name=public}",
      ':select[Who can message me]{name=messages options="Everyone,People I follow,No one"}',
    ],
  },
  {
    title: "Appearance",
    fields: [
      ':select[Theme]{name=theme options="System,Light,Dark"}',
      ":toggle[Compact lists]{name=compact}",
    ],
  },
];

const settings: ArtifactTemplate = {
  id: "prototype/settings",
  kind: "prototype",
  name: "Settings",
  description: "A settings area: a menu of groups, each opening a screen of fields and switches.",
  title: "Settings",
  subtitle: "",
  options: [{ key: "groups", label: "Groups", kind: "number", min: 1, max: 4, default: 3 }, DEVICE],
  build(s) {
    const groups = GROUPS.slice(0, num(s, "groups"));
    const id = (t: string) => t.toLowerCase();
    const screens = slides(
      `{#menu title="${s.title}"}\n${groups.map((g) => `- [**${g.title}** · ${g.fields.length} settings](#${id(g.title)})`).join("\n")}`,
      ...groups.map(
        (g) =>
          `{#${id(g.title)} title="${g.title}" back=menu}\n${g.fields.join("\n\n")}\n\n:button[Save]{go=menu}`,
      ),
    );
    return {
      markdown: md(front(s, "prototype", { device: str(s, "device"), start: "menu" }), screens),
    };
  },
};

export const PROTOTYPE_TEMPLATES = [listDetail, onboarding, settings];
