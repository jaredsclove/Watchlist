// The Supabase Edge Function entry point for the IGDB proxy; the logic is in core.mjs (tested with Node: tests/igdb-proxy.test.js).
// Deployed with the platform's JWT check off (supabase/config.toml): core.mjs checks the caller through PostgREST itself.
import { handle } from './core.mjs';

Deno.serve(req => handle(req, Deno.env.toObject(), { fetch }));
