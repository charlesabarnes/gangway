import { block, choice, flag, frames, front, md, num, str, type ArtifactTemplate } from "../kit.ts";

const NAV = ["Trips", "Search", "Bookings", "Account"];

/** The app's sidebar, with the page you are on in bold. */
const side = (at: string) => {
  const nav = NAV.map((n) => (n === at ? `- **${n}**` : `- ${n}`)).join("\n");
  return block("side", {}, `Skyway\n\n${nav}\n\nAda Lovelace · Explorer plan`);
};

/** A screen: the sidebar, a bar with the page title and its actions, then the page. */
const app = (at: string, title: string, actions: string, page: string) => {
  const bar = block("bar", {}, `## ${title}\n${actions}`);
  return block("app", {}, `${side(at)}\n\n${bar}\n\n${page}`, 6);
};

const card = (inner: string) => block("card", {}, inner, 4);
const columns = (left: string, right: string, wide = false) =>
  block("columns", wide ? { wide: true } : {}, `${left}\n\n+++\n\n${right}`, 5);

const SCREENS = [
  {
    id: "search",
    title: "Search",
    url: "skyway.app/search",
    to: ["results", "Search flights"],
    body: app(
      "Search",
      "Where next, Ada?",
      ":button[Saved trips]{ghost}",
      [
        card(
          [
            ":tabs[Return,One way,Multi-city]{at=1}",
            ':input[From]{value="London (LHR)"}\n:input[To]{value="Lisbon (LIS)"}\n:input[Depart]{value="Fri 3 Oct"}\n:input[Return]{value="Tue 7 Oct"}\n:select[Travellers]{options="1 adult,2 adults,2 adults · 1 child"}',
            ":toggle[Nonstop only]{on} :toggle[Flexible dates, ±3 days]{}\n:button[Search flights]{}",
          ].join("\n\n"),
        ),
        "### Recent searches",
        "| Route | Dates | Travellers | Lowest fare |\n|---|---|---|---:|\n| London → Lisbon | 3 – 7 Oct | 1 adult | £118 |\n| London → Porto | 17 – 20 Oct | 2 adults | £204 |\n| Manchester → Madrid | 8 – 15 Nov | 1 adult | £96 |",
      ].join("\n\n"),
    ),
  },
  {
    id: "results",
    title: "Results",
    url: "skyway.app/search/lhr-lis/3-oct",
    to: ["seat", "Choose TP 1363"],
    body: app(
      "Search",
      "London → Lisbon",
      ":button[Edit search]{ghost} :button[Price alert]{ghost}",
      [
        ":tabs[Best,Cheapest,Fastest]{at=1}",
        ":toggle[Nonstop only]{on} :toggle[Cabin bag included]{on} :toggle[Morning departures]{}",
        "| Flight | Departs | Arrives | Duration | Stops | Fare |\n|---|---|---|---|---|---:|\n| **TP 1363** · TAP Air Portugal :flag[Best]{tone=ok} | 07:40 | 10:20 | 2h 40m | Nonstop | £118 |\n| **U2 7521** · easyJet :flag[Cheapest]{} | 18:30 | 21:15 | 2h 45m | Nonstop | £89 |\n| **BA 500** · British Airways | 11:05 | 13:50 | 2h 45m | Nonstop | £146 |\n| **FR 8340** · Ryanair | 06:15 | 11:40 | 5h 25m | 1 stop | £72 |",
        "Fares are per adult, one way, and include taxes. 42 flights match; 4 shown.",
      ].join("\n\n"),
    ),
  },
  {
    id: "seat",
    title: "Seat and bags",
    url: "skyway.app/book/tp1363/extras",
    to: ["pay", "Continue to payment"],
    body: app(
      "Bookings",
      "Seat and bags",
      ":steps[Flight,Extras,Pay]{at=2}",
      columns(
        card(
          [
            "### TP 1363 · Fri 3 Oct, 07:40",
            ':select[Seat]{options="14A · Window · £12,14C · Aisle · £12,Any seat · Free"}',
            ":toggle[Cabin bag, 10 kg]{on} :toggle[Checked bag, 23 kg · £18]{on}",
            ":toggle[Priority boarding · £8]{}",
          ].join("\n\n"),
        ),
        card(
          [
            "### Your trip",
            block(
              "facts",
              { total: true },
              "Flight: £118\nSeat 14A: £12\nChecked bag: £18\nTotal: £148",
            ),
            ":button[Continue to payment]{}",
          ].join("\n\n"),
        ),
        true,
      ),
    ),
  },
  {
    id: "pay",
    title: "Pay",
    url: "skyway.app/book/tp1363/pay",
    to: ["done", "Pay £148"],
    body: app(
      "Bookings",
      "Pay",
      ":steps[Flight,Extras,Pay]{at=3}",
      columns(
        card(
          [
            "### Card details",
            ':input[Name on card]{value="Ada Lovelace"}',
            ':input[Card number]{value="4242 4242 4242 4242"}',
            ':input[Expiry]{value="08 / 29"}\n:input[Security code]{placeholder="3 digits"}',
            ":toggle[Save this card for next time]{on}",
          ].join("\n\n"),
        ),
        card(
          [
            "### London → Lisbon",
            "Fri 3 Oct · TP 1363 · 07:40 – 10:20",
            block(
              "facts",
              { total: true },
              "Flight: £118\nSeat 14A: £12\nChecked bag: £18\nTotal: £148",
            ),
            ":button[Pay £148]{}",
          ].join("\n\n"),
        ),
        true,
      ),
    ),
  },
  {
    id: "done",
    title: "Booked",
    url: "skyway.app/trips/SKY-4R7Q",
    to: null,
    body: app(
      "Trips",
      "You're going to Lisbon",
      ":button[Add to calendar]{ghost} :button[View trip]{}",
      [
        block(
          "callout",
          { tone: "ok", title: "Booked. Reference SKY-4R7Q" },
          "We sent the confirmation to ada@example.com. Check-in opens 24 hours before you fly.",
        ),
        columns(
          card(
            `### Outbound\n\n${block("facts", {}, "Flight: TP 1363, TAP Air Portugal\nDeparts: Fri 3 Oct, 07:40, Heathrow T2\nArrives: 10:20, Lisbon T1\nSeat: 14A, window")}`,
          ),
          card(
            `### Paid\n\n${block("facts", { total: true }, "Flight: £118\nSeat 14A: £12\nChecked bag: £18\nTotal: £148")}`,
          ),
          true,
        ),
      ].join("\n\n"),
    ),
  },
] as const;

const W = 1280;
const H = 800;

export const userFlow: ArtifactTemplate = {
  id: "canvas/flow",
  kind: "canvas",
  name: "User flow",
  description:
    "A product journey as finished desktop screens in browser windows, with an arrow for each step and notes where it matters.",
  title: "Booking a flight",
  subtitle: "From search to a booked seat in five screens",
  options: [
    { key: "screens", label: "Screens", kind: "number", min: 3, max: 5, default: 5 },
    { key: "notes", label: "Design notes", kind: "boolean", default: true },
    choice("layout", "Layout", "grid", [
      ["grid", "A grid"],
      ["row", "One row"],
    ]),
  ],
  build(s) {
    const shown = SCREENS.slice(0, num(s, "screens"));
    const ids = new Set(shown.map((x) => x.id));
    const screens = shown.map((x) => {
      const arrow = x.to && ids.has(x.to[0]) ? `\n-> ${x.to[0]} "${x.to[1]}"` : "";
      return `{#${x.id} title="${x.title}" frame=window url=${x.url} w=${W} h=${H}}\n${x.body}${arrow}`;
    });
    const notes = flag(s, "notes") && [
      `{#note-search title="Note" frame=note w=360}\nThe last search is filled in. **Six of ten** testers searched the same route twice.`,
      `{#note-pay title="Open question" frame=note w=360}\nShow the seat map on the extras screen, or after payment? Test both next sprint.`,
    ];
    return {
      markdown: md(
        front(s, "canvas", {
          layout: str(s, "layout"),
          gap: "200",
          ...(str(s, "layout") === "grid" ? { columns: "3" } : {}),
        }),
        frames(...screens, ...(notes || [])),
      ),
    };
  },
};
