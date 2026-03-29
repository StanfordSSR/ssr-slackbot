import {
  findSlackChannelIdByReference,
  findSlackUserGroupByHandle,
  getSlackChannelMemberIds,
  getSlackUserGroupMembers,
  listAllSlackUsers,
  lookupSlackUserIdByEmail,
  lookupSlackUserIdByHandle,
  updateSlackUserGroupMembers,
} from "@/lib/slack";

type ResolveResult = {
  userIds: string[];
  notFound: string[];
};

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

export async function resolveEmailsOrMentionsToUserIds(input: string) {
  const tokens = input
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const userIds: string[] = [];
  const notFound: string[] = [];

  for (const token of tokens) {
    const mentionMatch = token.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);
    if (mentionMatch) {
      userIds.push(mentionMatch[1]);
      continue;
    }

    const normalized = token.replace(/,$/, "");
    try {
      if (normalized.includes("@") && !normalized.startsWith("@")) {
        userIds.push(await lookupSlackUserIdByEmail(normalized.toLowerCase()));
      } else {
        userIds.push(await lookupSlackUserIdByHandle(normalized));
      }
    } catch {
      notFound.push(normalized);
    }
  }

  return {
    userIds: unique(userIds),
    notFound: unique(notFound),
  } satisfies ResolveResult;
}

export async function getEligibleChannelMemberIds(channelReference: string) {
  const channelId = await findSlackChannelIdByReference(channelReference);
  if (!channelId) {
    return {
      channelId: null,
      eligibleUserIds: [],
      skippedGuestsOrBots: [],
    };
  }

  const memberIds = unique(await getSlackChannelMemberIds(channelId));
  const users = await listAllSlackUsers();
  const userMap = new Map(users.map((user) => [user.id, user]));

  const eligibleUserIds: string[] = [];
  const skippedGuestsOrBots: string[] = [];

  for (const memberId of memberIds) {
    const user = userMap.get(memberId);
    if (!user) {
      skippedGuestsOrBots.push(memberId);
      continue;
    }

    if (user.deleted || user.is_bot || user.is_restricted || user.is_ultra_restricted) {
      skippedGuestsOrBots.push(memberId);
      continue;
    }

    eligibleUserIds.push(memberId);
  }

  return {
    channelId,
    eligibleUserIds: unique(eligibleUserIds),
    skippedGuestsOrBots: unique(skippedGuestsOrBots),
  };
}

export async function appendUsersToUserGroup(params: { groupHandle: string; userIds: string[] }) {
  const userGroup = await findSlackUserGroupByHandle(params.groupHandle);
  if (!userGroup) {
    throw new Error(`I couldn't find a Slack user group with handle @${params.groupHandle.replace(/^@/, "")}.`);
  }

  const existingMembers = unique(await getSlackUserGroupMembers(userGroup.id));
  const mergedMembers = unique([...existingMembers, ...params.userIds]);
  const addedCount = Math.max(0, mergedMembers.length - existingMembers.length);

  if (mergedMembers.length !== existingMembers.length) {
    await updateSlackUserGroupMembers(userGroup.id, mergedMembers);
  }

  return {
    userGroupId: userGroup.id,
    normalizedHandle: userGroup.handle,
    existingCount: existingMembers.length,
    finalCount: mergedMembers.length,
    addedCount,
  };
}
