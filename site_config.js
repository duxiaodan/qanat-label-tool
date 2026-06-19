// site_config.prod.js — PRODUCTION Supabase config (project B).
// Holding file: at deploy time this is copied over site_config.js.
// anon key is PUBLIC by design (RLS + passcode gate; geometry AES-encrypted).
export const SUPABASE = {
  url: 'https://euovwswolroytptnlqie.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1b3Z3c3dvbHJveXRwdG5scWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MjkwMzEsImV4cCI6MjA5NzQwNTAzMX0.1caB9P85ddM20632oxt4rcKuVsiNjaYTX2JSwG_AXO8',
};
