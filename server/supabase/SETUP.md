# OrcStrator Cloud Sync — Supabase Setup

Sync your OrcStrator pipeline across multiple machines using a free Supabase project.

## 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in (or create a free account)
2. Click **New Project**
3. Choose a name (e.g., `orcstrator-sync`) and a strong database password
4. Select the region closest to you
5. Wait for the project to finish provisioning (~1 minute)

## 2. Run the Schema

1. In your Supabase dashboard, go to **SQL Editor** (left sidebar)
2. Click **New Query**
3. Copy the entire contents of `server/supabase/schema.sql` and paste it
4. Click **Run** — you should see all tables created successfully

## 3. Get Your Credentials

1. Go to **Settings** > **API** (left sidebar)
2. Copy the **Project URL** (looks like `https://abcdefg.supabase.co`)
3. Copy the **anon / public** key (the long `eyJ...` string)

## 4. Configure OrcStrator

1. Open OrcStrator and go to **Settings** > **Cloud Sync**
2. Paste the **Supabase URL** and **API Key**
3. Set a **Machine Name** (e.g., "Desktop", "Laptop")
4. Click **Test Connection** to verify
5. Click **Save**

## 5. Enable Sync Per Project

1. On the main sidebar, click the cloud icon (☁) next to any project folder
2. The first sync will push all existing tasks to the cloud
3. The cloud icon turns blue when synced

## How It Works

- The Orc checks for changes every 10 seconds (piggybacking on its existing tick loop)
- A timestamp optimization skips unchanged projects — zero overhead when nothing changed
- A full sync runs every hour as a safety net
- Each machine identifies itself with a unique ID and the name you set
- Local SQLite stays authoritative — the cloud is a shared mirror
- If a machine goes offline, it keeps working locally and re-syncs on reconnection

## Cost

The Supabase free tier includes:
- 500 MB database storage
- 2 million realtime messages/month (not used — we poll)
- Unlimited API requests

For typical usage (1-3 machines, polling every 10s), you'll stay well within the free tier.
