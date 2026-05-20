const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'committee.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = `
CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    department TEXT,
    email TEXT UNIQUE,
    role TEXT DEFAULT 'operator' CHECK(role IN ('super_admin','operator')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','rejected','disabled')),
    approved_by INTEGER,
    approved_at DATETIME,
    rejection_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS committees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    operator_id INTEGER NOT NULL,
    quorum INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (operator_id) REFERENCES operators(id)
);

CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    committee_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    type TEXT NOT NULL CHECK(type IN ('faculty','staff','student','external')),
    sabun TEXT,
    role TEXT,
    affiliation TEXT,
    timetable_cache TEXT,
    timetable_fetched_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (committee_id) REFERENCES committees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    committee_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    duration_minutes INTEGER DEFAULT 60,
    status TEXT DEFAULT 'scheduling' CHECK(status IN ('scheduling','confirmed','completed','cancelled')),
    confirmed_slot_id INTEGER,
    minutes_text TEXT,
    pdf_path TEXT,
    schedule_constraints TEXT,
    notify_channels TEXT DEFAULT 'email,sms',
    ars_after_minutes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (committee_id) REFERENCES committees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meeting_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    suggested_score REAL DEFAULT 0,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slot_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    response TEXT NOT NULL CHECK(response IN ('available','unavailable','maybe')),
    auto_filled INTEGER DEFAULT 0,
    note TEXT,
    responded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (slot_id) REFERENCES meeting_slots(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    UNIQUE(slot_id, member_id)
);

CREATE TABLE IF NOT EXISTS member_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    meeting_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('availability','signature')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    signature_data TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    UNIQUE(meeting_id, member_id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    member_id INTEGER,
    type TEXT NOT NULL,
    channel TEXT DEFAULT 'email',
    subject TEXT,
    content TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_members_committee ON members(committee_id);
CREATE INDEX IF NOT EXISTS idx_meetings_committee ON meetings(committee_id);
CREATE INDEX IF NOT EXISTS idx_slots_meeting ON meeting_slots(meeting_id);
CREATE INDEX IF NOT EXISTS idx_responses_slot ON slot_responses(slot_id);
CREATE INDEX IF NOT EXISTS idx_tokens_token ON member_tokens(token);
`;

db.exec(schema);

function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}
ensureColumn('meetings', 'schedule_constraints', 'TEXT');
ensureColumn('meetings', 'notify_channels', "TEXT DEFAULT 'email,sms'");
ensureColumn('meetings', 'ars_after_minutes', 'INTEGER DEFAULT 0');
ensureColumn('member_tokens', 'last_sms_at', 'DATETIME');
ensureColumn('member_tokens', 'ars_called_at', 'DATETIME');
ensureColumn('members', 'timetable_image_path', 'TEXT');
ensureColumn('members', 'timetable_source', "TEXT");
ensureColumn('operators', 'email', 'TEXT');
ensureColumn('operators', 'role', "TEXT DEFAULT 'operator'");
ensureColumn('operators', 'status', "TEXT DEFAULT 'active'");
ensureColumn('operators', 'approved_by', 'INTEGER');
ensureColumn('operators', 'approved_at', 'DATETIME');
ensureColumn('operators', 'rejection_reason', 'TEXT');

ensureColumn('members', 'timetable_meta', 'TEXT');

function migrateMemberTypes() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'").get();
  if (!row || !row.sql.includes("'internal'")) return;
  db.exec(`
    BEGIN;
    CREATE TABLE members_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      committee_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      type TEXT NOT NULL CHECK(type IN ('faculty','staff','student','external')),
      sabun TEXT,
      role TEXT,
      affiliation TEXT,
      timetable_cache TEXT,
      timetable_fetched_at DATETIME,
      timetable_image_path TEXT,
      timetable_source TEXT,
      timetable_meta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (committee_id) REFERENCES committees(id) ON DELETE CASCADE
    );
    INSERT INTO members_new (id, committee_id, name, email, phone, type, sabun, role, affiliation,
                             timetable_cache, timetable_fetched_at, timetable_image_path, timetable_source, timetable_meta, created_at)
    SELECT id, committee_id, name, email, phone,
           CASE WHEN type = 'internal' AND sabun IS NOT NULL AND sabun != '' THEN 'faculty'
                WHEN type = 'internal' THEN 'staff'
                ELSE 'external' END,
           sabun, role, affiliation,
           timetable_cache, timetable_fetched_at, timetable_image_path, timetable_source, timetable_meta, created_at
    FROM members;
    DROP TABLE members;
    ALTER TABLE members_new RENAME TO members;
    CREATE INDEX IF NOT EXISTS idx_members_committee ON members(committee_id);
    COMMIT;
  `);
  console.log('[db migration] members.type CHECK constraint relaxed to (faculty/staff/student/external).');
}
migrateMemberTypes();

module.exports = db;
