import { lookupSlackUserIdByEmail } from "@/lib/slack";
import { getProfilesForSlackSync, updateProfileSlackUserId } from "@/lib/supabase";

export async function syncProfileSlackUsers() {
  let matched = 0;
  let failed = 0;
  let alreadyLinked = 0;

  const profiles = await getProfilesForSlackSync();

  for (const entry of profiles) {
    const email = entry.email?.trim().toLowerCase();
    if (!email) continue;

    if (entry.slack_user_id) {
      alreadyLinked += 1;
      continue;
    }

    try {
      const slackUserId = await lookupSlackUserIdByEmail(email);
      await updateProfileSlackUserId({ profileId: entry.id, slackUserId });
      matched += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    matched,
    alreadyLinked,
    failed,
    totalProfiles: profiles.length,
  };
}
