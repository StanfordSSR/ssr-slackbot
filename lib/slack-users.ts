import { lookupSlackUserIdByEmail } from "@/lib/slack";
import {
  getProfilesForSlackSync,
  getTeamRosterMembersForSlackSync,
  updateProfileSlackUserId,
  updateTeamRosterMemberSlackUserId,
} from "@/lib/supabase";

export async function syncProfileSlackUsers() {
  let matchedProfiles = 0;
  let matchedRosterMembers = 0;
  let failed = 0;
  let alreadyLinkedProfiles = 0;
  let alreadyLinkedRosterMembers = 0;

  const profiles = await getProfilesForSlackSync();
  const rosterMembers = await getTeamRosterMembersForSlackSync();
  const slackUserIdByEmail = new Map<string, string>();

  for (const entry of profiles) {
    const email = entry.email?.trim().toLowerCase();
    if (!email) continue;

    if (entry.slack_user_id) {
      alreadyLinkedProfiles += 1;
      slackUserIdByEmail.set(email, entry.slack_user_id);
      continue;
    }

    try {
      const slackUserId = slackUserIdByEmail.get(email) ?? await lookupSlackUserIdByEmail(email);
      slackUserIdByEmail.set(email, slackUserId);
      await updateProfileSlackUserId({ profileId: entry.id, slackUserId });
      matchedProfiles += 1;
    } catch {
      failed += 1;
    }
  }

  for (const entry of rosterMembers) {
    const email = entry.stanford_email?.trim().toLowerCase();
    if (!email) continue;

    if (entry.slack_user_id) {
      alreadyLinkedRosterMembers += 1;
      slackUserIdByEmail.set(email, entry.slack_user_id);
      continue;
    }

    try {
      const slackUserId = slackUserIdByEmail.get(email) ?? await lookupSlackUserIdByEmail(email);
      slackUserIdByEmail.set(email, slackUserId);
      await updateTeamRosterMemberSlackUserId({ rosterMemberId: entry.id, slackUserId });
      matchedRosterMembers += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    matched: matchedProfiles + matchedRosterMembers,
    matchedProfiles,
    matchedRosterMembers,
    alreadyLinked: alreadyLinkedProfiles + alreadyLinkedRosterMembers,
    alreadyLinkedProfiles,
    alreadyLinkedRosterMembers,
    failed,
    totalProfiles: profiles.length,
    totalRosterMembers: rosterMembers.length,
  };
}
