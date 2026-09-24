import { Component, ElementRef, computed, effect, inject, input } from '@angular/core';
import {
  Activity,
  AppWindow,
  Bell,
  BookOpen,
  Bot,
  Briefcase,
  Bug,
  Building2,
  Calendar,
  Camera,
  Car,
  ChartColumn,
  ChartLine,
  ChartPie,
  Clock,
  Cloud,
  Code,
  Coffee,
  CreditCard,
  Database,
  Dumbbell,
  FileText,
  Film,
  Flag,
  Flame,
  FlaskConical,
  Footprints,
  Gamepad2,
  GitBranch,
  GitPullRequest,
  Globe,
  GraduationCap,
  Heart,
  House,
  Image,
  Kanban,
  LayoutDashboard,
  Leaf,
  Lightbulb,
  ListChecks,
  Lock,
  Mail,
  Map,
  MapPin,
  Megaphone,
  MessageSquare,
  Monitor,
  Music,
  Newspaper,
  NotebookPen,
  Package,
  Palette,
  Plane,
  Presentation,
  Puzzle,
  Rocket,
  Search,
  Server,
  Settings,
  Shield,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  Table,
  Terminal,
  Trophy,
  User,
  Users,
  Utensils,
  Wallet,
  Zap,
  type IconNode,
} from 'lucide';
import type { SourceKind } from '../core/api.types';
import type {
  PreviewIcon as Icon,
  PreviewIconColor,
  PreviewIconName,
} from '../core/preview-icon.types';

export const ICON_NODES: Record<PreviewIconName, IconNode> = {
  'file-text': FileText,
  'notebook-pen': NotebookPen,
  newspaper: Newspaper,
  'book-open': BookOpen,
  presentation: Presentation,
  megaphone: Megaphone,
  'layout-dashboard': LayoutDashboard,
  'chart-line': ChartLine,
  'chart-column': ChartColumn,
  'chart-pie': ChartPie,
  activity: Activity,
  table: Table,
  'app-window': AppWindow,
  smartphone: Smartphone,
  monitor: Monitor,
  globe: Globe,
  search: Search,
  'list-checks': ListChecks,
  kanban: Kanban,
  calendar: Calendar,
  clock: Clock,
  bell: Bell,
  mail: Mail,
  'message-square': MessageSquare,
  users: Users,
  user: User,
  settings: Settings,
  lock: Lock,
  shield: Shield,
  'shopping-cart': ShoppingCart,
  'credit-card': CreditCard,
  wallet: Wallet,
  briefcase: Briefcase,
  'building-2': Building2,
  house: House,
  map: Map,
  'map-pin': MapPin,
  plane: Plane,
  car: Car,
  database: Database,
  server: Server,
  cloud: Cloud,
  code: Code,
  terminal: Terminal,
  bug: Bug,
  bot: Bot,
  'flask-conical': FlaskConical,
  package: Package,
  puzzle: Puzzle,
  rocket: Rocket,
  zap: Zap,
  flame: Flame,
  sparkles: Sparkles,
  lightbulb: Lightbulb,
  'graduation-cap': GraduationCap,
  palette: Palette,
  image: Image,
  camera: Camera,
  film: Film,
  music: Music,
  'gamepad-2': Gamepad2,
  trophy: Trophy,
  star: Star,
  heart: Heart,
  flag: Flag,
  leaf: Leaf,
  sun: Sun,
  coffee: Coffee,
  utensils: Utensils,
  footprints: Footprints,
  dumbbell: Dumbbell,
};

/** Light-theme inks; dark mode lifts each toward white. Yellow is darkened to read on paper. */
export const ICON_COLORS: Record<PreviewIconColor, string> = {
  navy: '#1d3a66',
  blue: '#215da5',
  teal: '#00857f',
  green: '#3b8a41',
  yellow: '#a8740c',
  red: '#cc3f2f',
  violet: '#7d4dad',
  gray: '#687283',
};

const FALLBACK: Record<SourceKind, IconNode> = {
  pr: GitPullRequest,
  git: GitBranch,
  image: Package,
  tarball: AppWindow,
  agent: Bot,
  manual: AppWindow,
};

const SVG = 'http://www.w3.org/2000/svg';

/** A preview's icon on a tinted tile; without one, a grey icon for where it came from. */
@Component({
  selector: 'app-preview-icon',
  template: '',
  host: {
    class: 'inline-flex shrink-0 items-center justify-center border',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.color]': 'ink()',
    '[style.border-color]': 'edge()',
    '[style.background]': 'tint()',
    '[attr.data-icon]': 'icon()?.name ?? null',
    'aria-hidden': 'true',
  },
})
export class PreviewIconTile {
  readonly icon = input<Icon | null>(null);
  readonly source = input<SourceKind>('tarball');
  readonly size = input(32);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly #base = computed(() => ICON_COLORS[this.icon()?.color ?? 'gray']);
  protected readonly ink = computed(
    () => `light-dark(${this.#base()}, color-mix(in oklch, ${this.#base()} 60%, white))`,
  );
  protected readonly edge = computed(
    () => `color-mix(in oklch, ${this.#base()} 35%, var(--gw-paper))`,
  );
  protected readonly tint = computed(
    () => `color-mix(in oklch, ${this.#base()} 12%, var(--gw-paper))`,
  );

  constructor() {
    effect(() => {
      const icon = this.icon();
      const node = icon ? ICON_NODES[icon.name] : FALLBACK[this.source()];
      this.#host.nativeElement.replaceChildren(draw(node, Math.round(this.size() * 0.56)));
    });
  }
}

function draw(node: IconNode, px: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const attrs = {
    viewBox: '0 0 24 24',
    width: String(px),
    height: String(px),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, a] of node) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}
