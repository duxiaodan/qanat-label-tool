// site_config.example.js — documents the shape of site_config.js.
//
// Copy to site_config.js (or let build_label_tool_site.py write it from
// --supabase-url / --supabase-anon-key, or $SUPABASE_URL / $SUPABASE_ANON_KEY)
// to enable shared, cross-device progress via Supabase.
//
//   - url:     the Supabase project URL, e.g. https://abcdefgh.supabase.co
//   - anonKey: the project's "anon public" key (Settings → API). This key is
//              public by design; row access is gated by the passcode-encrypted
//              `geom` payload + a permissive anon RLS policy on the `marks` table.
//
// When SUPABASE is null (see site_config.js), the tool falls back to
// localStorage-only mode — no network, no shared progress.

export const SUPABASE = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-ANON-PUBLIC-KEY',
};
