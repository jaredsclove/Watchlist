// The Supabase Edge Function entry point for the books function (BK1); the logic is in core.mjs (tested with Node: tests/books-function.test.mjs).
// Deployed with the platform's JWT check off (supabase/config.toml): core.mjs checks the caller through PostgREST itself.
import { handle } from './core.mjs';

Deno.serve(req => handle(req, Deno.env.toObject(), { fetch }));
