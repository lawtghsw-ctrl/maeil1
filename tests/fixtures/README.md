# Historical SQL fixtures

`dowon-reference/` contains source SQL used only by the isolated PGlite
regression tests. These files are never deployed or applied to a connected
Supabase project. They recreate historical cases using fabricated records.

The production patch is `supabase/ropower-web-feature-patch.sql`; its dedicated
regression test checks preservation of preexisting record values independently.
