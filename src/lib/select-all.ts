import type { PostgrestError } from "@supabase/supabase-js";

// PostgREST silently caps every response at the project's `max_rows`
// (Supabase default 1000) — no error, just fewer rows. Routes that fetch
// "every matching row" and then sort/paginate in JS (see CLAUDE.md) page
// through with .range() instead. Must not exceed the project's max_rows
// (Dashboard → Settings → API), or a capped page looks like the last one.
const PAGE_SIZE = 1000;

type Page<T> = PromiseLike<{ data: T[] | null; error: PostgrestError | null }>;

// `page` builds a fresh query for each slice — a supabase-js builder runs
// once per await, so it can't be reused. Give it a unique sort column
// (e.g. `.order("id")`) so rows can't shift between slices.
export async function selectAll<T>(
  page: (from: number, to: number) => Page<T>,
): Promise<{ data: T[]; error: PostgrestError | null }> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: rows, error: null };
  }
}
