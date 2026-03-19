# SSR Slack Receipt Bot

A Vercel-friendly Slack DM bot for Stanford Student Robotics that:

- accepts receipt images and PDFs in bot DMs
- matches the sender by Slack email to `public.profiles.email`
- checks whether that user is an active `lead` on any active team
- uses OpenAI vision to extract merchant, amount, date, and item name
- lets the user confirm before inserting into `public.purchase_logs`
- optionally uploads the original receipt to Supabase Storage

## What changed

This version drops the old `/add` assignment workflow.

The bot now works like this:
1. A user DMs the bot a receipt image or PDF.
2. The bot calls Slack `users.info` and reads the sender email.
3. The bot matches that email to `public.profiles.email`.
4. The bot loads active lead memberships from `public.team_memberships` joined to `public.teams`.
5. If there is one authorized team, it drafts the receipt for that team.
6. If there are multiple authorized teams, it asks the user which team to use.
7. On confirm, it inserts into `public.purchase_logs`.

## Required Supabase SQL

Run this in the Supabase SQL editor:

```sql
alter table public.profiles
add column if not exists email text;

update public.profiles p
set email = lower(u.email)
from auth.users u
where p.id = u.id
  and u.email is not null
  and (p.email is null or p.email <> lower(u.email));

create unique index if not exists profiles_email_unique_idx
on public.profiles (lower(email));

create index if not exists team_memberships_user_active_idx
on public.team_memberships (user_id, is_active);

create index if not exists teams_active_idx
on public.teams (is_active);
```

## Slack app scopes

Use these bot scopes:
- `app_mentions:read`
- `channels:history`
- `chat:write`
- `files:read`
- `im:history`
- `users:read`
- `users:read.email`

## Slack events and interactivity

- Events request URL: `https://YOUR_DOMAIN/api/slack/events`
- Interactivity request URL: `https://YOUR_DOMAIN/api/slack/interactivity`
- Subscribe to bot event: `message.im`
- Subscribe to bot event: `app_mention`

`/api/slack/commands` is still present, but only replies with a short note that the bot is email-based now.

## Environment variables

Copy `.env.example` into `.env.local` for local testing or set the same values in Vercel.

### Required
- `OPENAI_API_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Optional
- `OPENAI_RECEIPT_MODEL` default: `gpt-4.1-mini`
- `SUPABASE_RECEIPT_PATH_PREFIX` default: `slack-bot`

### Required for production receipt uploads
- `SUPABASE_RECEIPT_BUCKET` should point to your receipt storage bucket, for example `purchase-receipts`

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Expose the app with a public tunnel during local Slack testing.

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import the repo into Vercel.
3. Add the environment variables.
4. Deploy.
5. Put the Vercel URLs into the Slack app.
6. Reinstall the Slack app after changing scopes.

## Notes

- The bot assumes the receipt submitter is the person authorized to log for the team.
- If a user leads multiple teams, the bot prompts them to choose.
- `SUPABASE_RECEIPT_BUCKET` should be set in production so confirmed receipts are uploaded before the purchase log is created.
- All Supabase access uses the service role key and must stay server-side only.
