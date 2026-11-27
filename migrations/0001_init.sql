-- Notebook Lab: accounts, courses, assignments, students' work and submissions.
--
-- Times are milliseconds since 1970-01-01 UTC. Notebooks are stored as compact .ipynb JSON text,
-- at most about 1 MB each (shared/limits.ts). The notebook column comes last in its table, so
-- that queries which only need the small columns do not read it.
--
-- What deleting takes along (ON DELETE CASCADE):
--   an account     its sessions, reset links, the courses it owns and its enrollments
--   a course       its enrollments and assignments
--   an enrollment  (leaving, or being removed) that student's work and submissions in the course
--   an assignment  the work and the submissions for it
--
-- Comments in this file contain no semicolons, so that any tool can split it into statements.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- Chosen at sign-up. It only shapes the home screen. Permissions come from the course.
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A session needs two secrets: the token in the HttpOnly cookie and the secret the page sends in
-- a header. Only SHA-256 hashes of both are stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);

CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);

-- Single-use password reset links. Only a hash of each token is stored.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS password_resets_by_user ON password_resets(user_id);

CREATE INDEX IF NOT EXISTS password_resets_by_expiry ON password_resets(expires_at);

-- Attempt counters (sign-in, sign-up, join by code, writes), kept here so that they hold across
-- Worker instances.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_by_reset ON rate_limits(reset_at);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  term TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  join_code TEXT NOT NULL UNIQUE,
  join_open INTEGER NOT NULL DEFAULT 1 CHECK (join_open IN (0, 1)),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS courses_by_owner ON courses(owner_id);

CREATE TABLE IF NOT EXISTS enrollments (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (course_id, user_id)
);

CREATE INDEX IF NOT EXISTS enrollments_by_user ON enrollments(user_id);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- Markdown, sanitized by the page when shown.
  instructions TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  points REAL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'closed')),
  published_at INTEGER,
  -- Students see grades and feedback only while this is set.
  grades_released_at INTEGER,
  starter_name TEXT NOT NULL DEFAULT 'notebook.ipynb',
  starter_version INTEGER NOT NULL DEFAULT 1,
  starter_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- The notebook students start from.
  starter TEXT NOT NULL,
  -- Lets work and submissions name their course in a foreign key.
  UNIQUE (id, course_id)
);

CREATE INDEX IF NOT EXISTS assignments_by_course ON assignments(course_id);

-- A student's own copy of an assignment's notebook, created from the starter when they first open
-- it. `version` goes up with every save, so that a second tab cannot overwrite newer work unseen.
CREATE TABLE IF NOT EXISTS work (
  assignment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notebook TEXT NOT NULL,
  PRIMARY KEY (assignment_id, user_id),
  FOREIGN KEY (assignment_id, course_id) REFERENCES assignments(id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (course_id, user_id) REFERENCES enrollments(course_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS work_by_enrollment ON work(course_id, user_id);

-- The latest snapshot a student handed in, how often they handed in, and the teacher's grade.
-- checks_passed / checks_total are what the student's browser reported. They are not proof.
CREATE TABLE IF NOT EXISTS submissions (
  assignment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  first_submitted_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  late INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
  checks_passed INTEGER,
  checks_total INTEGER,
  grade REAL,
  feedback TEXT NOT NULL DEFAULT '',
  graded_at INTEGER,
  notebook TEXT NOT NULL,
  PRIMARY KEY (assignment_id, user_id),
  FOREIGN KEY (assignment_id, course_id) REFERENCES assignments(id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (course_id, user_id) REFERENCES enrollments(course_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS submissions_by_enrollment ON submissions(course_id, user_id);
