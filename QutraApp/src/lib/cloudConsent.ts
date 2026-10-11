import type { Engagement } from "@/domain/lab";
import { getDb } from "@/lib/db/database";

/* The allowance for an investigation's summary to go to a cloud connection
   (spec D9, §7.5). It is given once per
   investigation on the consent card, for one connection (provider and
   host), and can be revoked from the investigation's header or Settings.
   Both are durable writes: a revoke that did not reach the disk would come
   back after a restart, so a failure rejects and the caller says so. Giving
   or revoking it does not touch `updatedAt`, which says when the
   investigation itself was last worked on. */

export interface CloudConnection {
  /** `anthropic` or an OpenAI-compatible preset. */
  provider: string;
  /** The host requests go to. */
  host: string;
}

/** The same provider and host; a connection with no host is never the same
    as anything, so an allowance cannot be given or matched without one. */
export const sameConnection = (a: CloudConnection, b: CloudConnection): boolean =>
  a.host !== "" && a.provider === b.provider && a.host === b.host;

/** Whether the investigation allows its summary to go to this connection. */
export function consentMatches(engagement: Engagement, connection: CloudConnection): boolean {
  const consent = engagement.cloudConsent;
  return Boolean(consent && sameConnection(consent, connection));
}

export async function grantCloudConsent(
  engagementId: string,
  connection: CloudConnection,
  now = Date.now(),
): Promise<void> {
  if (connection.host === "") throw new Error("a cloud allowance needs a host");
  await getDb()
    .collection("engagements")
    .updateDurable(engagementId, (engagement) => ({
      ...engagement,
      cloudConsent: { provider: connection.provider, host: connection.host, grantedAt: now },
    }));
}

export async function revokeCloudConsent(engagementId: string): Promise<void> {
  await getDb()
    .collection("engagements")
    .updateDurable(engagementId, (engagement) => {
      if (!engagement.cloudConsent) return undefined;
      const { cloudConsent: _revoked, ...rest } = engagement;
      return rest;
    });
}
