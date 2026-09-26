import {
  block,
  choice,
  flag,
  front,
  md,
  num,
  slides,
  str,
  type ArtifactTemplate,
  type TemplateOption,
  type TemplateSettings,
} from "./kit.ts";

const DEVICE = (def: "phone" | "desktop"): TemplateOption =>
  choice("device", "Device", def, [
    ["phone", "Phone"],
    ["desktop", "Desktop"],
  ]);

const LOOK: TemplateOption = choice("look", "Look", "app", [
  ["app", "Finished app"],
  ["wireframe", "Wireframe"],
  ["chart", "gangway style"],
]);

const head = (s: TemplateSettings, start: string) =>
  front(s, "prototype", { device: str(s, "device"), look: str(s, "look"), start });

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
    DEVICE("phone"),
    LOOK,
  ],
  build(s) {
    const list = ITEMS.slice(0, num(s, "items"))
      .map(([t, meta, time]) => `- [**${t}** · ${meta} :flag[${time}]{tone=ok}](#detail)`)
      .join("\n");
    const screens = slides(
      `{#home title="${s.title}"}\n:image[Tonight near you]{ratio=16:9}\n\n## Free tables tonight\n${s.subtitle || "Choose one to see more."}\n\n${list}`,
      `{#detail title="${ITEMS[0][0]}" back=home}\n:image[${ITEMS[0][0]}, the dining room]{ratio=4:3}\n\n## ${ITEMS[0][0]}\nDay-boat fish, cooked over charcoal. **Tables free at 19:30 and 21:15.**\n\n:flag[Open now]{tone=ok} :flag[Busy]{tone=warn}\n\n${block("facts", {}, "Cuisine: Seafood\nPrice: ££\nWalk: 8 min")}\n\n:button[Book a table]{go=form}`,
      `{#form title="Your booking" back=detail}\n:steps[Time,Details,Done]{at=2}\n\n:input[Name]{name=name placeholder="Who is it for?"}\n\n:select[Time]{name=time options="19:30,21:15"}\n\n:select[Guests]{name=guests options="2,3,4,5,6"}\n\n:toggle[Text me a reminder]{name=remind on}\n\n:button[Confirm]{go=done}`,
      `{#done title="Booked"}\n:steps[Time,Details,Done]{at=3}\n\n${block("callout", { tone: "ok", title: "See you at {{time}}, {{name}}" }, "A table for {{guests}} at Harbour Kitchen. We sent the details to your phone.")}\n\n:button[Back to the list]{go=home ghost}`,
    );
    return { markdown: md(head(s, "home"), screens) };
  },
};

const STEPS = [
  {
    short: "You",
    title: "Your details",
    field: ':input[Full name]{name=name placeholder="Ada Lovelace"}',
  },
  {
    short: "Team",
    title: "Your team",
    field: ':input[Team name]{name=team placeholder="Platform"}',
  },
  {
    short: "Invite",
    title: "Invite people",
    field: ':input[Email addresses]{name=invites placeholder="a@example.com, b@example.com"}',
  },
  {
    short: "Project",
    title: "Your first project",
    field: ':input[Project name]{name=project placeholder="Website"}',
  },
  {
    short: "Alerts",
    title: "Notifications",
    field: ":toggle[Email me a weekly summary]{name=weekly on}",
  },
];

const onboarding: ArtifactTemplate = {
  id: "prototype/onboarding",
  kind: "prototype",
  name: "Onboarding flow",
  description: "A step-by-step sign-up: a welcome, one screen per step with progress, a finish.",
  title: "Welcome aboard",
  subtitle: "Set up your account in a minute",
  options: [
    { key: "steps", label: "Steps", kind: "number", min: 2, max: 5, default: 3 },
    DEVICE("phone"),
    LOOK,
  ],
  build(s) {
    const steps = STEPS.slice(0, num(s, "steps"));
    const id = (i: number) => (i < steps.length ? `step-${i + 1}` : "finish");
    const bar = (at: number) => `:steps[${steps.map((st) => st.short).join(",")}]{at=${at}}`;
    const screens = slides(
      `{#welcome}\n:image[Welcome]{ratio=4:3}\n\n# ${s.title}\n${s.subtitle || "It takes about a minute."}\n\n:button[Get started]{go=step-1}`,
      ...steps.map(
        (st, i) =>
          `{#${id(i)} title="Step ${i + 1} of ${steps.length}" back=${i === 0 ? "welcome" : id(i - 1)}}\n${bar(i + 1)}\n\n## ${st.title}\n${st.field}\n\n:button[${i === steps.length - 1 ? "Finish" : "Continue"}]{go=${id(i + 1)}}`,
      ),
      `{#finish title="Done"}\n${block("callout", { tone: "ok", title: "You're all set, {{name}}" }, "Your workspace is ready.")}\n\n:button[Start over]{go=welcome ghost}`,
    );
    return { markdown: md(head(s, "welcome"), screens) };
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
  options: [
    { key: "groups", label: "Groups", kind: "number", min: 1, max: 4, default: 3 },
    DEVICE("phone"),
    LOOK,
  ],
  build(s) {
    const groups = GROUPS.slice(0, num(s, "groups"));
    const id = (t: string) => t.toLowerCase();
    const screens = slides(
      `{#menu title="${s.title}"}\n${block("card", {}, "**Ada Lovelace**\n\nada@example.com · Team plan")}\n\n${groups.map((g) => `- [**${g.title}** · ${g.fields.length} settings](#${id(g.title)})`).join("\n")}`,
      ...groups.map(
        (g) =>
          `{#${id(g.title)} title="${g.title}" back=menu}\n${g.fields.join("\n\n")}\n\n:button[Save]{go=menu}`,
      ),
    );
    return { markdown: md(head(s, "menu"), screens) };
  },
};

const checkout: ArtifactTemplate = {
  id: "prototype/checkout",
  kind: "prototype",
  name: "Checkout",
  description:
    "Pick a room, pay beside a price summary, see the booking: a desktop checkout with progress and design notes.",
  title: "Harbour Hotel",
  subtitle: "Two nights by the sea",
  options: [
    { key: "notes", label: "Design notes", kind: "boolean", default: true },
    DEVICE("desktop"),
    LOOK,
  ],
  build(s) {
    const note = (text: string) => flag(s, "notes") && block("note", {}, text);
    const bar = (at: number) => `:steps[Room,Details & pay,Done]{at=${at}}`;
    const summary = [
      ":image[Sea-view double]{ratio=16:9}",
      "### Sea-view double",
      "Fri 4 Oct to Sun 6 Oct · 2 guests",
      block(
        "facts",
        { total: true },
        "2 nights × £148: £296\nBreakfast for 2: £36\nCity tax: £8\nTotal: £340",
      ),
    ].join("\n\n");
    const screens = slides(
      `{#room title="${s.title}"}\n${bar(1)}\n\n${block(
        "columns",
        {},
        [
          ":image[Sea-view double, the room]{ratio=16:10}",
          "## Sea-view double",
          `${s.subtitle || "Two nights by the sea"}. A king bed, a balcony over the harbour and breakfast on the terrace.`,
          ":flag[Free cancellation]{tone=ok} :flag[2 left]{tone=warn}",
          block("facts", {}, "Bed: King\nSize: 28 m²\nView: Harbour"),
          "+++",
          block(
            "card",
            {},
            "**£148** a night\n\n" +
              block("facts", {}, "Check in: Fri 4 Oct\nCheck out: Sun 6 Oct\nGuests: 2") +
              "\n\n:button[Reserve]{go=details}",
            4,
          ),
          note("Price per night up front. Total only on the next step?"),
        ]
          .filter(Boolean)
          .join("\n\n"),
        5,
      )}`,
      `{#details title="Details & pay" back=room}\n${bar(2)}\n\n${block(
        "columns",
        {},
        [
          "## Almost there",
          "No charge until you arrive. Free cancellation until 1 Oct.",
          ':input[Full name]{name=name placeholder="Ada Lovelace"}',
          ':input[Email]{name=email type=email placeholder="ada@example.com"}',
          ':select[Pay with]{name=pay options="Card,Pay at hotel,Wallet"}',
          ':input[Card number]{name=card placeholder="1234 5678 9012 3456"}',
          ":toggle[Late check-in, after 10 pm]{name=late}",
          note('"No charge until you arrive" won every test. Keep it up top.'),
          "+++",
          block("card", {}, `${summary}\n\n:button[Confirm booking]{go=done}`, 4),
          note("One button here, no upsell."),
        ]
          .filter(Boolean)
          .join("\n\n"),
        5,
      )}`,
      `{#done title="Booked"}\n${bar(3)}\n\n${block(
        "columns",
        {},
        [
          block(
            "callout",
            { tone: "ok", title: "You're booked, {{name}}" },
            "We sent the confirmation to {{email}}. Paying by: {{pay}}.",
          ),
          ":button[Back to the hotel]{go=room ghost}",
          "+++",
          block("card", {}, summary, 4),
        ].join("\n\n"),
        5,
      )}`,
    );
    return { markdown: md(head(s, "room"), screens) };
  },
};

const TRIPS = [
  ["Lisbon", "3 to 7 Oct · 2 travellers", "In 8 days"],
  ["Copenhagen", "14 to 16 Nov · Work", "In 7 weeks"],
  ["Kyoto", "2 to 12 Apr · 2 travellers", "Next year"],
] as const;

const mobileApp: ArtifactTemplate = {
  id: "prototype/app",
  kind: "prototype",
  name: "Mobile app",
  description:
    "A phone app with a tab bar: a home feed, a list, a detail screen with an action, a profile.",
  title: "Wander",
  subtitle: "Your trips, in one place",
  options: [
    { key: "trips", label: "Trips", kind: "number", min: 1, max: 3, default: 3 },
    DEVICE("phone"),
    LOOK,
  ],
  build(s) {
    const tabs = ':tabs[Home,Trips,Profile]{go="home,trips,profile"}';
    const trips = TRIPS.slice(0, num(s, "trips"));
    const list = trips
      .map(([t, when, soon]) => `- [**${t}** · ${when} :flag[${soon}]{tone=ok}](#trip)`)
      .join("\n");
    const screens = slides(
      `{#home}\n# Good morning, Ada\n${s.subtitle || "Your trips, in one place"}\n\n:image[${trips[0]![0]} in October]{ratio=16:10}\n\n## Coming up\n${list}\n\n${tabs}`,
      `{#trips title="Trips"}\n${list}\n\n:button[Plan a new trip]{go=home ghost}\n\n${tabs}`,
      `{#trip title="${trips[0]![0]}" back=home}\n:image[${trips[0]![0]}, the old town]{ratio=4:3}\n\n## ${trips[0]![0]}\n${trips[0]![1]}\n\n${block("facts", {}, "Flight: TP 1363 · 07:40\nHotel: Casa do Rio · 4 nights\nWeather: 24° and sunny")}\n\n:button[Check in for the flight]{go=checked}`,
      `{#checked title="Checked in" back=trip}\n${block("callout", { tone: "ok", title: "You're checked in" }, "Seat 14A. Boarding closes at 07:10, gate shown 40 minutes before.")}\n\n:button[Back to the trip]{go=trip ghost}\n\n${tabs}`,
      `{#profile title="Profile"}\n${block("card", {}, "**Ada Lovelace**\n\n12 trips · member since 2021")}\n\n:toggle[Flight alerts]{name=alerts on}\n\n:toggle[Share my trips with Sam]{name=share}\n\n:select[Currency]{name=currency options="GBP,EUR,USD"}\n\n${tabs}`,
    );
    return { markdown: md(head(s, "home"), screens) };
  },
};

export const PROTOTYPE_TEMPLATES = [mobileApp, checkout, listDetail, onboarding, settings];
