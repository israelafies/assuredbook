PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS webhook_jobs;
DROP TABLE IF EXISTS webhooks;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS share_events;
DROP TABLE IF EXISTS quiz_answers;
DROP TABLE IF EXISTS quiz_attempts;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS result_profiles;
DROP TABLE IF EXISTS answer_options;
DROP TABLE IF EXISTS questions;
DROP TABLE IF EXISTS quizzes;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  instructions TEXT,
  cover_image TEXT,
  logo TEXT,
  brand_name TEXT,
  primary_cta TEXT,
  result_cta TEXT,
  whatsapp_cta TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('single_choice','multiple_choice','yes_no','text','email','phone','rating','number','dropdown')),
  question_text TEXT NOT NULL,
  explanation TEXT,
  is_required INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  "order" INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);
CREATE INDEX idx_questions_quiz ON questions(quiz_id, "order");

CREATE TABLE answer_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  option_text TEXT NOT NULL,
  score_value INTEGER NOT NULL DEFAULT 0,
  category_weights TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);
CREATE INDEX idx_options_question ON answer_options(question_id, "order");

CREATE TABLE result_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  score_min INTEGER,
  score_max INTEGER,
  category_conditions TEXT,
  recommendations TEXT,
  cta_text TEXT,
  whatsapp_message TEXT,
  affiliate_cta TEXT,
  affiliate_url TEXT,
  affiliate_text TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  quiz_id INTEGER NOT NULL,
  first_name TEXT,
  email TEXT,
  phone TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);
CREATE INDEX idx_quiz_email ON leads(quiz_id, email);
CREATE INDEX idx_quiz_phone ON leads(quiz_id, phone);
CREATE INDEX idx_ip_created ON leads(ip_address, created_at);

CREATE TABLE quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL UNIQUE,
  lead_id INTEGER NOT NULL,
  quiz_id INTEGER NOT NULL,
  current_question_index INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  score_total INTEGER,
  result_profile_id INTEGER,
  result_category TEXT,
  completion_status TEXT NOT NULL DEFAULT 'started' CHECK (completion_status IN ('started','completed','abandoned')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
  FOREIGN KEY (result_profile_id) REFERENCES result_profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_attempt_lead ON quiz_attempts(lead_id, quiz_id, completion_status);

CREATE TABLE quiz_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  question_id INTEGER NOT NULL,
  answer_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attempt_id, question_id),
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE share_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  shared_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER,
  event_type TEXT NOT NULL,
  attempt_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quiz_event ON events(quiz_id, event_type);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "key" TEXT NOT NULL UNIQUE,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhook_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_status ON webhook_jobs(status);

-- ==========================================================================
-- SEED: the "Freelancer Client Readiness" quiz from the original seed.php
-- ==========================================================================

INSERT INTO quizzes (uuid, title, subtitle, description, instructions, brand_name, primary_cta, result_cta, whatsapp_cta, status, slug)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  'Why Are You Still Struggling to Get Freelance Clients',
  'The 3-minute Client-Getting Readiness Check',
  'Discover what may be holding your freelance client acquisition back -- and the next move you should focus on.',
  'Answer honestly. There are no right or wrong answers.' || char(10) || 'This is not a test and there is no score. Your answers are used to create your result page.',
  'Freelancer Client Readiness',
  'Find Out Why I''m Not Getting Clients ->',
  'Show Me What To Fix Next ->',
  'Send My Result to WhatsApp ->',
  'published',
  'freelancer-client-readiness'
);

-- Q1
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'When you look for freelance clients, what do you usually do first?', 1, 1, 1);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'Post on social media and hope someone reaches out', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'Send proposals/applications on freelance platforms', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'Directly contact businesses or potential clients', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I usually wait until I feel more ready before reaching out', 0, '[]', 4);

-- Q2
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'How clearly can you explain the specific problem your freelance service solves?', 1, 1, 2);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'I mostly describe the skill I have', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'I can explain my service, but not the business result', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I can clearly connect my service to a specific client problem', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I change the explanation depending on who I am talking to', 0, '[]', 4);

-- Q3
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'If a potential client asked, "Why should I hire you instead of someone else?", what would you say?', 1, 1, 3);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'I would probably mention that I work hard and learn quickly', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'I would point to my skills, tools, or certifications', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I could explain the specific result or advantage I bring', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I''m honestly not sure what makes me different yet', 0, '[]', 4);

-- Q4
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'How strong is your freelance portfolio right now?', 1, 1, 4);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'I have little or nothing to show', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'I have samples, but they are mostly practice or personal projects', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I have relevant work samples that demonstrate what I can do', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I have a portfolio, but it does not clearly target the clients I want', 0, '[]', 4);

-- Q5
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'How often do you deliberately reach out to potential clients?', 1, 1, 5);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'Almost never', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'Only when I urgently need money', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I have a consistent outreach routine', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I start outreach routines but struggle to maintain them', 0, '[]', 4);

-- Q6
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'When a prospect says, "Your price is too high," what usually happens?', 1, 1, 6);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'I immediately reduce my price', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'I start defending my price or explaining how much work is involved', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I ask questions to understand the objection before responding', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I usually do not get far enough in the conversation to discuss price', 0, '[]', 4);

-- Q7
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'What happens most often after you send a proposal or pitch?', 1, 1, 7);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'I rarely get a response', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'People respond but then disappear', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I regularly get conversations or calls from my pitches', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I get interest, but struggle to turn it into a paid project', 0, '[]', 4);

-- Q8
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'How confident are you when talking to a business owner or decision-maker?', 1, 1, 8);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'Very uncomfortable -- I worry I will sound inexperienced', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'I can start the conversation but struggle to keep it going', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I am comfortable asking questions and discussing business problems', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I feel confident until the conversation turns toward selling', 0, '[]', 4);

-- Q9
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'What is your biggest obstacle to getting clients right now?', 1, 1, 9);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'I do not know where to find the right prospects', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'I find prospects but do not know what to say', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I get conversations but struggle to close clients', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I know what to do but lack consistency', 0, '[]', 4);

-- Q10
INSERT INTO questions (quiz_id, type, question_text, is_required, is_active, "order")
VALUES ((SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'), 'single_choice',
        'If you had a proven client-getting process today, how consistently would you follow it for the next 30 days?', 1, 1, 10);
INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order") VALUES
((SELECT MAX(id) FROM questions), 'I would probably start strongly and lose momentum', 0, '[]', 1),
((SELECT MAX(id) FROM questions), 'I would follow it if I could see quick results', 0, '[]', 2),
((SELECT MAX(id) FROM questions), 'I would commit to following it consistently', 0, '[]', 3),
((SELECT MAX(id) FROM questions), 'I need accountability or structure to stay consistent', 0, '[]', 4);

-- Single result profile (no scoring)
INSERT INTO result_profiles (quiz_id, title, description, score_min, score_max, category_conditions, recommendations, cta_text, whatsapp_message, is_active)
VALUES (
  (SELECT id FROM quizzes WHERE slug='freelancer-client-readiness'),
  'Your Client-Getting Readiness Report Is Ready',
  'Your answers give you a clear starting point for improving the way you attract, approach, and convert freelance clients. There is no score here -- the goal is to identify the areas you need to tighten up.',
  NULL, NULL, NULL,
  '1. Pick one specific client type instead of trying to sell to everybody.' || char(10) ||
  '2. Make your offer about a business problem and outcome, not just your freelance skill.' || char(10) ||
  '3. Build proof that makes your desired client believe you can deliver.' || char(10) ||
  '4. Use direct, consistent outreach instead of relying entirely on people discovering you.' || char(10) ||
  '5. Follow up and improve your pitch based on real conversations.',
  'Send My Result to WhatsApp ->',
  'I just completed the Client-Getting Readiness Check. Here is my result: {RESULT_LINK}',
  1
);

INSERT INTO settings ("key", value) VALUES
  ('whatsapp_number', ''),
  ('whatsapp_default_message', ''),
  ('meta_pixel_id', ''),
  ('google_analytics_id', '');