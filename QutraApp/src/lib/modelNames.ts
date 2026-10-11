/* Readable names for the cloud models' ids ("claude-opus-5-5" becomes
   "Claude Opus 5.5"). Only ids whose shape is known are rewritten; any
   other id, a local model's included, is returned as it is, so a name is
   never invented. The raw id stays available to show beside or under it. */

const CLAUDE_FAMILY = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:-latest)?$/;
const CLAUDE_OLD = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?(?:-latest)?$/;
const GPT = /^gpt-(\d+(?:\.\d+)?)(o?)(?:-(mini|nano|turbo|pro))?(?:-\d{4}-\d{2}-\d{2})?$/;
const O_SERIES = /^(o\d+)(?:-(mini|pro))?(?:-\d{4}-\d{2}-\d{2})?$/;

const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** The readable name for a cloud model id, or null when the id's shape is not known. */
export function friendlyModelName(id: string): string | null {
  const modern = CLAUDE_FAMILY.exec(id);
  if (modern) {
    const [, family, major, minor] = modern;
    return `Claude ${cap(family!)} ${minor ? `${major}.${minor}` : major}`;
  }
  const old = CLAUDE_OLD.exec(id);
  if (old) {
    const [, major, minor, family] = old;
    return `Claude ${minor ? `${major}.${minor}` : major} ${cap(family!)}`;
  }
  const gpt = GPT.exec(id);
  if (gpt) {
    const [, version, omni, tier] = gpt;
    return `GPT-${version}${omni}${tier ? ` ${cap(tier)}` : ""}`;
  }
  const o = O_SERIES.exec(id);
  if (o) return o[2] ? `${o[1]}-${o[2]}` : o[1]!;
  return null;
}

/** What a model list shows for a model: the name the service gave it when it
    gave a real one, else the readable form of its id, else the id. */
export function modelDisplayName(id: string, serviceName?: string | null): string {
  if (serviceName && serviceName.trim() && serviceName !== id) return serviceName.trim();
  return friendlyModelName(id) ?? id;
}
