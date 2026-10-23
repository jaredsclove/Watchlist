const SUPABASE_URL = 'https://elunjvvvrotapdtigomo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_yLAuk8Z0Yg_fvwZ0DfypPw_U2_fYUi9';
const TABLE = 'watchlist_items';

const BACKUP_PAGE_SIZE = 500;

const BACKUP_TABLES = ['watchlist_items', 'othertv_shows', 'custom_collections'];
const BACKUP_FORMAT = 'watchlist-tracker-backup';
const BACKUP_FORMAT_VERSION = 1;

const WATCH_WITH_OPTIONS = ['Alone', 'Suzanne', 'Rina', 'Whole Family'];

// Reviewed show-key overrides for built-in rows: "collection|item_key prefix" →
// the show the row belongs to. Used by the TV-show model (not read by the app yet);
// must match private.tv_show_key_override in db/tv_model.sql and
// tests/tv-model-reference.js. Add entries only after review — never by title guessing.
const SHOW_KEY_OVERRIDES = {
  'disney|the clone wars': 'star wars: the clone wars (2008)'
};

// Each entry carries its verified TMDB movie id, so pullUniverse() fetches the
// exact film instead of guessing from a title search. A plain-string entry
// (title only) is still accepted, but it only resolves when the search result
// is unambiguous — see pickTmdbMovieCandidate() in identity.js.
const MCU_MOVIES = [
  // Phase 1
  { t: 'Iron Man', id: 1726 }, { t: 'The Incredible Hulk', id: 1724 }, { t: 'Iron Man 2', id: 10138 },
  { t: 'Thor', id: 10195 }, { t: 'Captain America: The First Avenger', id: 1771 }, { t: 'The Avengers', id: 24428 },
  // Phase 2
  { t: 'Iron Man 3', id: 68721 }, { t: 'Thor: The Dark World', id: 76338 },
  { t: 'Captain America: The Winter Soldier', id: 100402 }, { t: 'Guardians of the Galaxy', id: 118340 },
  { t: 'Avengers: Age of Ultron', id: 99861 }, { t: 'Ant-Man', id: 102899 },
  // Phase 3
  { t: 'Captain America: Civil War', id: 271110 }, { t: 'Doctor Strange', id: 284052 },
  { t: 'Guardians of the Galaxy Vol. 2', id: 283995 }, { t: 'Spider-Man: Homecoming', id: 315635 },
  { t: 'Thor: Ragnarok', id: 284053 }, { t: 'Black Panther', id: 284054 }, { t: 'Avengers: Infinity War', id: 299536 },
  { t: 'Ant-Man and the Wasp', id: 363088 }, { t: 'Captain Marvel', id: 299537 }, { t: 'Avengers: Endgame', id: 299534 },
  { t: 'Spider-Man: Far From Home', id: 429617 },
  // Phase 4
  { t: 'Black Widow', id: 497698 }, { t: 'Shang-Chi and the Legend of the Ten Rings', id: 566525 },
  { t: 'Eternals', id: 524434 }, { t: 'Spider-Man: No Way Home', id: 634649 },
  { t: 'Doctor Strange in the Multiverse of Madness', id: 453395 }, { t: 'Thor: Love and Thunder', id: 616037 },
  { t: 'Black Panther: Wakanda Forever', id: 505642 },
  // Phase 5
  { t: 'Ant-Man and the Wasp: Quantumania', id: 640146 }, { t: 'Guardians of the Galaxy Vol. 3', id: 447365 },
  { t: 'The Marvels', id: 609681 }, { t: 'Captain America: Brave New World', id: 822119 },
  { t: 'Thunderbolts*', id: 986056 },
  // Phase 6
  { t: 'The Fantastic Four: First Steps', id: 617126 }, { t: 'Spider-Man: Brand New Day', id: 969681 },
  { t: 'Avengers: Doomsday', id: 1003596 }, { t: 'Avengers: Secret Wars', id: 1003598 }
];

const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIyOTJhYjcyNDU0ZDFjYzJhZmExNjhiZjBhZTkxZWIxZCIsIm5iZiI6MTc4NTE2NTk4OS45MTEsInN1YiI6IjZhNjc3OGE1ZmNhODlhNWUxOTk4MDNiZCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.IlLvRk2FD-eY2I5SKGzLDAqMrBRhh58Zxz_zx62YzRE';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const NETWORK_COLORS = {
  'HBO': '#8b5cf6', 'HBO Max': '#8b5cf6', 'Max': '#8b5cf6',
  'Netflix': '#e50914',
  'AMC': '#c8a951', 'AMC+': '#c8a951',
  'FX': '#1a73e8', 'FX on Hulu': '#1a73e8',
  'Apple TV+': '#8e8e93',
  'Showtime': '#e63946',
  'NBC': '#f4a261',
  'ABC': '#2a9d8f',
  'CBS': '#457b9d',
  'Amazon': '#00a8e1', 'Prime Video': '#00a8e1',
  'Disney+': '#1a6ef5', 'Disney Plus': '#1a6ef5',
  'Peacock': '#f7c59f',
  'Hulu': '#1ce783',
  'Paramount+': '#0064ff', 'Paramount Plus': '#0064ff',
  'BBC': '#c0392b', 'BBC One': '#c0392b', 'BBC Two': '#c0392b',
  'A&E': '#5b8def', 'Investigation Discovery': '#5b8def', 'ID': '#5b8def',
  // Movie genres (TMDB) — deliberate colors so common ones don't look randomly hashed
  'Action': '#f1c40f', 'Adventure': '#f39c12', 'Animation': '#e91e8c',
  'Comedy': '#8bc34a', 'Crime': '#c0392b', 'Documentary': '#7f8c8d',
  'Drama': '#e67e22', 'Family': '#27ae60', 'Fantasy': '#9b59b6',
  'History': '#a0522d', 'Horror': '#c0392b', 'Music': '#e84393',
  'Mystery': '#5b6ee1', 'Romance': '#ff6b9d', 'Science Fiction': '#1abc9c',
  'TV Movie': '#8e8e93', 'Thriller': '#c0392b', 'War': '#7f5539',
  'Western': '#a0522d'
};

const UNIVERSE_LISTS = {
  mcu: { label: 'MCU', titles: MCU_MOVIES }
};

const LAST_BACKUP_KEY = 'watchlist_last_backup_at';
