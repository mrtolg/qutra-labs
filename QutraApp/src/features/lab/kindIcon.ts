import {
  Activity,
  FileSearch,
  Fingerprint,
  Globe,
  Network,
  Shield,
  type LucideIcon,
} from "lucide-react";
import type { Engagement, EngagementKind } from "@/domain/lab";

/** One icon per kind of investigation, the same on Home, the list and the
    investigation's own header. */
export const KIND_ICON: Record<EngagementKind, LucideIcon> = {
  file: FileSearch,
  web: Globe,
  host: Network,
  pcap: Activity,
  forensics: Fingerprint,
};

/** An investigation made before kinds existed shows the plain shield. */
export const kindIcon = (e: Pick<Engagement, "kind">): LucideIcon =>
  e.kind ? KIND_ICON[e.kind] : Shield;
