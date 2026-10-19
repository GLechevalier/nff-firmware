import {
  Briefcase,
  ChartColumn,
  Code,
  Cpu,
  History,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Mail,
  MessageSquare,
  Server,
  Users,
  type LucideIcon,
} from 'lucide-react';

// Single source of truth for "which icon represents this tab group" — shared
// by Sidebar.tsx (the nav rail) and BrainGraph.tsx (a tab-master node reuses
// the exact same icon), so the two can never drift apart.
export const TAB_GROUP_ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  chat: MessageSquare,
  todo: ListChecks,
  users: Users,
  usage: ChartColumn,
  ops: Server,
  dev: Code,
  history: History,
  // nff-app's rail ids (src/nav.tsx) — its brain tab masters look these up too.
  devices: Cpu,
  // The two Store apps without a rail (nav.tsx BRAIN_TABS) — brain masters only.
  admin: Briefcase,
  finance: Landmark,
  emails: Mail,
};
