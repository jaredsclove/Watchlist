// An existing identified TV season row whose stored date is still a "TBA"
// placeholder gets TMDB's season air_date once TMDB has one. A date already
// confirmed on the row is never overwritten. Returns only the date fields to
// PATCH, or null when there is nothing to update.
function tmdbSeasonDateUpdate(row, season) {
  if (!row || row.media_type !== 'tv' || row.tmdb_id == null) return null;
  if (!/TBA/i.test(row.display_date || '')) return null;
  if (!season || !/^\d{4}-\d{2}-\d{2}$/.test(season.air_date || '')) return null;
  return { display_date: formatDisplayDate(season.air_date), date_sort: season.air_date };
}
