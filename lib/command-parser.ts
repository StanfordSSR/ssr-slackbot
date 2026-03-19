export function parseAddCommand(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const mentionMatch = normalized.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>\s+(.+)/i);

  if (!mentionMatch) {
    return null;
  }

  const [, userId, rawTeamName] = mentionMatch;
  const teamName = rawTeamName.trim();

  if (!teamName) {
    return null;
  }

  return { userId, teamName };
}
