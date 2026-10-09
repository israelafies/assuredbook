// ============================================================================
// Quiz Funnel -- Cloudflare Workers edition
// Single-file Worker. Requires one D1 binding named DB.
// ============================================================================

const SESSION_COOKIE = 'quizapp_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const ALLOWED_WEBHOOK_EVENTS = ['quiz.completed'];

// ---------------------------------------------------------------------------
// Basic response helpers
// ---------------------------------------------------------------------------
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    },
  });
}
function textResponse(body, contentType = 'text/plain; charset=utf-8', status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { 'Content-Type': contentType, ...extraHeaders } });
}
function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

// ---------------------------------------------------------------------------
// Escaping / string helpers
// ---------------------------------------------------------------------------
function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Landing-page theme + sizing helpers
// ---------------------------------------------------------------------------
function quizTheme(template) {
  const themes = {
    default: {
      hero: 'bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 text-white',
      badgeText: 'text-indigo-300',
      button: 'bg-white text-indigo-950',
      bodyText: 'text-slate-300',
      subtitleText: 'text-indigo-100',
      sectionCard: 'bg-slate-50 border-slate-200',
      sectionHeading: 'text-slate-950',
      sectionBody: 'text-slate-600',
    },
    romantic: {
      hero: 'bg-gradient-to-br from-rose-500 via-pink-500 to-fuchsia-600 text-white',
      badgeText: 'text-rose-100',
      button: 'bg-white text-rose-600',
      bodyText: 'text-rose-50',
      subtitleText: 'text-rose-100',
      sectionCard: 'bg-rose-50 border-rose-100',
      sectionHeading: 'text-rose-900',
      sectionBody: 'text-rose-800',
    },
    warm: {
      hero: 'bg-gradient-to-br from-amber-500 via-orange-500 to-red-500 text-white',
      badgeText: 'text-amber-100',
      button: 'bg-white text-amber-700',
      bodyText: 'text-amber-50',
      subtitleText: 'text-amber-100',
      sectionCard: 'bg-amber-50 border-amber-100',
      sectionHeading: 'text-amber-900',
      sectionBody: 'text-amber-800',
    },
    minimal: {
      hero: 'bg-white text-slate-900 border-b border-slate-200',
      badgeText: 'text-slate-500',
      button: 'bg-slate-900 text-white',
      bodyText: 'text-slate-600',
      subtitleText: 'text-slate-600',
      sectionCard: 'bg-white border-slate-200',
      sectionHeading: 'text-slate-950',
      sectionBody: 'text-slate-600',
    },
    bold: {
      hero: 'bg-black text-white',
      badgeText: 'text-lime-400',
      button: 'bg-lime-400 text-black',
      bodyText: 'text-slate-300',
      subtitleText: 'text-slate-300',
      sectionCard: 'bg-slate-900 text-white border-slate-800',
      sectionHeading: 'text-white',
      sectionBody: 'text-slate-300',
    },
  };
  return themes[template] || themes.default;
}

function textScale(scale) {
  const scales = {
    sm: { title: 'text-2xl sm:text-3xl', subtitle: 'text-base', body: 'text-sm sm:text-base' },
    md: { title: 'text-3xl sm:text-5xl', subtitle: 'text-lg', body: 'text-base sm:text-lg' },
    lg: { title: 'text-4xl sm:text-6xl', subtitle: 'text-xl', body: 'text-lg sm:text-xl' },
    xl: { title: 'text-5xl sm:text-7xl', subtitle: 'text-2xl', body: 'text-xl sm:text-2xl' },
  };
  return scales[scale] || scales.md;
}

function imageSizeClass(size) {
  const sizes = {
    sm: 'max-w-xs',
    md: 'max-w-sm',
    lg: 'max-w-md',
    xl: 'max-w-lg',
    full: 'w-full max-w-3xl',
  };
  return sizes[size] || sizes.md;
}

function whatsappLink(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  return 'https://wa.me/' + digits;
}

// ---------------------------------------------------------------------------
// Landing content: sanitizer, legacy migration, shortcode render
// ---------------------------------------------------------------------------
async function sanitizeHtml(dirty) {
  if (!dirty || typeof dirty !== 'string') return '';
  const DANGEROUS = 'script, style, iframe, object, embed, form, input, textarea, select, option, link, meta, base, svg, math';
  const rewritten = new HTMLRewriter()
    .on(DANGEROUS, { element(el) { el.remove(); } })
    .on('*', {
      element(el) {
        const toRemove = [];
        for (const [name] of el.attributes) {
          const lower = String(name).toLowerCase();
          if (lower.startsWith('on')) toRemove.push(name);
        }
        for (const name of toRemove) el.removeAttribute(name);
        const href = el.getAttribute('href');
        if (href && /^\s*(javascript|vbscript|data:text\/html)/i.test(href)) {
          el.removeAttribute('href');
        }
        const src = el.getAttribute('src');
        if (src && /^\s*(javascript|vbscript)/i.test(src)) {
          el.removeAttribute('src');
        }
      },
    });
  const res = rewritten.transform(new Response(dirty, { headers: { 'Content-Type': 'text/html' } }));
  return await res.text();
}

// Converts the old block-array JSON to plain HTML so nothing is lost on migration.
function legacyBlocksToHtml(rawSections) {
  if (!rawSections) return '';
  let blocks;
  try { blocks = JSON.parse(rawSections); } catch { return ''; }
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const align = b.align ? ` style="text-align:${escapeHtml(b.align)}"` : '';
    if (b.type === 'heading') {
      const lvl = ['h1','h2','h3'].includes(b.level) ? b.level : 'h2';
      parts.push(`<${lvl}${align}>${escapeHtml(b.text || '')}</${lvl}>`);
    } else if (b.type === 'text') {
      parts.push(`<div${align}>${b.html || ''}</div>`);
    } else if (b.type === 'image') {
      parts.push(`<p${align}><img src="${escapeHtml(b.url || '')}" alt="${escapeHtml(b.alt || '')}"></p>`);
    } else if (b.type === 'image_text') {
      parts.push(`<div><p><img src="${escapeHtml(b.image || '')}" alt=""></p>${b.html || ''}</div>`);
    } else if (b.type === 'cta') {
      parts.push(`<p>{button}</p>`);
    } else if (b.type === 'divider') {
      parts.push('<hr>');
    }
  }
  return parts.join('\n\n');
}

// Turns {button} into the real quiz CTA. Runs after sanitization on the public page.
function renderLandingContent(html, quiz) {
  if (!html) return '';
  const btnHtml = `<div class="my-6 text-center"><button type="button" @click="stage = 'lead'" class="inline-flex items-center rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-7 py-4 text-lg shadow-lg hover:scale-105 transition">${escapeHtml(quiz.primary_cta || 'Start the quiz')}</button></div>`;
  return String(html)
    .replace(/\{button\}/g, btnHtml)
    .replace(/&#123;button&#125;/g, btnHtml);
}

const e = escapeHtml;

function slugify(text) {
  if (!text) return 'quiz';
  const s = String(text).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'quiz';
}
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}
function uuid4() { return crypto.randomUUID(); }

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toBase64Url(new TextDecoder().decode(new Uint8Array(sig)));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${iterations}$${saltHex}$${hashHex}`;
}
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const expectedHex = parts[3];
  if (!iterations || !saltHex || !expectedHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return constantTimeEqual(hashHex, expectedHex);
}

// ---------------------------------------------------------------------------
// Sessions (signed cookie, no KV)
// ---------------------------------------------------------------------------
async function readSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies[SESSION_COOKIE];
  if (!token || !env.APP_SECRET) return { session: null, needsRefresh: false };
  const dot = token.lastIndexOf('.');
  if (dot === -1) return { session: null, needsRefresh: false };
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSign(env.APP_SECRET, payloadB64);
  if (!constantTimeEqual(sig, expected)) return { session: null, needsRefresh: false };
  let session;
  try { session = JSON.parse(fromBase64Url(payloadB64)); }
  catch { return { session: null, needsRefresh: false }; }
  if (session.exp && session.exp < Math.floor(Date.now() / 1000)) {
    return { session: null, needsRefresh: false };
  }
  return { session, needsRefresh: false };
}
async function signSession(session, env) {
  const payload = JSON.stringify(session);
  const payloadB64 = toBase64Url(payload);
  const sig = await hmacSign(env.APP_SECRET, payloadB64);
  return `${payloadB64}.${sig}`;
}
async function writeSessionCookie(response, session, env) {
  const token = await signSession(session, env);
  const cookie = serializeCookie(SESSION_COOKIE, token, {
    path: '/', maxAge: SESSION_TTL_SECONDS, httpOnly: true, secure: true, sameSite: 'Lax',
  });
  const copy = new Response(response.body, response);
  copy.headers.append('Set-Cookie', cookie);
  return copy;
}
function clearSessionCookie(response) {
  const cookie = serializeCookie(SESSION_COOKIE, '', {
    path: '/', maxAge: 0, httpOnly: true, secure: true, sameSite: 'Lax',
  });
  const copy = new Response(response.body, response);
  copy.headers.append('Set-Cookie', cookie);
  return copy;
}
function freshSession() {
  return {
    userId: null,
    csrf: randomHex(32),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    resultOwners: {},
  };
}

// ---------------------------------------------------------------------------
// D1 model layer
// ---------------------------------------------------------------------------
// -- users --
async function user_find_by_id(env, id) {
  return env.DB.prepare('SELECT id, name, email, is_admin FROM users WHERE id = ?').bind(id).first();
}
async function user_find_by_email(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}
async function user_create_admin(env, name, email, password) {
  const hash = await hashPassword(password);
  const res = await env.DB.prepare(
    'INSERT INTO users (name, email, password, is_admin) VALUES (?, ?, ?, 1)'
  ).bind(name, email, hash).run();
  return res.meta.last_row_id;
}
async function user_count(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
  return row ? row.c : 0;
}

// -- quizzes --
async function quiz_find(env, id) {
  return env.DB.prepare('SELECT * FROM quizzes WHERE id = ?').bind(id).first();
}
async function quiz_find_by_slug(env, slug) {
  return env.DB.prepare('SELECT * FROM quizzes WHERE slug = ?').bind(slug).first();
}
async function quiz_find_published_by_slug(env, slug) {
  return env.DB.prepare("SELECT * FROM quizzes WHERE slug = ? AND status = 'published'").bind(slug).first();
}
async function quiz_search(env, search, status, limit = 100, offset = 0) {
  let sql = 'SELECT * FROM quizzes WHERE 1=1';
  const binds = [];
  if (search) { sql += ' AND title LIKE ?'; binds.push('%' + search + '%'); }
  if (status) { sql += ' AND status = ?'; binds.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);
  const res = await env.DB.prepare(sql).bind(...binds).all();
  return res.results || [];
}
async function quiz_create(env, data) {
  const res = await env.DB.prepare(
    `INSERT INTO quizzes (
       uuid, title, subtitle, description, instructions,
       cover_image, logo, brand_name, primary_cta, result_cta, whatsapp_cta,
       status, slug, template, hero_image, hero_image_size, text_scale,
       accent_color, about_me_title, about_me_text, about_me_image, about_me_image_size,
       sections, landing_content
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    uuid4(),
    data.title, data.subtitle ?? null, data.description ?? null, data.instructions ?? null,
    data.cover_image ?? null, data.logo ?? null, data.brand_name ?? null,
    data.primary_cta ?? null, data.result_cta ?? null, data.whatsapp_cta ?? null,
    data.status || 'draft', data.slug,
    data.template || 'default',
    data.hero_image ?? null,
    data.hero_image_size || 'md',
    data.text_scale || 'md',
    data.accent_color ?? null,
    data.about_me_title ?? null,
    data.about_me_text ?? null,
    data.about_me_image ?? null,
    data.about_me_image_size || 'md',
    null,
    data.landing_content ?? null
  ).run();
  return res.meta.last_row_id;
}
async function quiz_update(env, id, data) {
  await env.DB.prepare(
    `UPDATE quizzes SET
       title=?, subtitle=?, description=?, instructions=?,
       cover_image=?, logo=?, brand_name=?, primary_cta=?, result_cta=?, whatsapp_cta=?,
       status=?, slug=?, template=?, hero_image=?, hero_image_size=?, text_scale=?,
       accent_color=?, about_me_title=?, about_me_text=?, about_me_image=?, about_me_image_size=?,
       sections=NULL, landing_content=?, updated_at=datetime('now')
     WHERE id=?`
  ).bind(
    data.title, data.subtitle ?? null, data.description ?? null, data.instructions ?? null,
    data.cover_image ?? null, data.logo ?? null, data.brand_name ?? null,
    data.primary_cta ?? null, data.result_cta ?? null, data.whatsapp_cta ?? null,
    data.status || 'draft', data.slug,
    data.template || 'default',
    data.hero_image ?? null,
    data.hero_image_size || 'md',
    data.text_scale || 'md',
    data.accent_color ?? null,
    data.about_me_title ?? null,
    data.about_me_text ?? null,
    data.about_me_image ?? null,
    data.about_me_image_size || 'md',
    data.landing_content ?? null,
    id
  ).run();
}
async function quiz_delete(env, id) {
  await env.DB.prepare('DELETE FROM quizzes WHERE id = ?').bind(id).run();
}
async function quiz_slug_taken(env, slug, excludeId) {
  let row;
  if (excludeId) {
    row = await env.DB.prepare('SELECT id FROM quizzes WHERE slug = ? AND id != ?').bind(slug, excludeId).first();
  } else {
    row = await env.DB.prepare('SELECT id FROM quizzes WHERE slug = ?').bind(slug).first();
  }
  return !!row;
}
async function quiz_duplicate(env, id) {
  const quiz = await quiz_find(env, id);
  if (!quiz) return null;
  const newSlug = quiz.slug + '-copy-' + randomHex(2);
  const newId = await quiz_create(env, {
    title: quiz.title + ' (copy)',
    subtitle: quiz.subtitle, description: quiz.description, instructions: quiz.instructions,
    cover_image: quiz.cover_image, logo: quiz.logo, brand_name: quiz.brand_name,
    primary_cta: quiz.primary_cta, result_cta: quiz.result_cta, whatsapp_cta: quiz.whatsapp_cta,
    status: 'draft', slug: newSlug,
  });
  const questions = await question_all_for_quiz(env, id, false);
  for (const q of questions) {
    const newQId = await question_create(env, {
      quiz_id: newId, type: q.type, question_text: q.question_text,
      explanation: q.explanation, is_required: q.is_required, is_active: q.is_active, order: q.order,
    });
    const options = await option_all_for_question(env, q.id);
    for (const o of options) {
      await option_create(env, {
        question_id: newQId, option_text: o.option_text, score_value: o.score_value,
        category_weights: o.category_weights, order: o.order,
      });
    }
  }
  const profiles = await result_profile_all_for_quiz(env, id);
  for (const rp of profiles) {
    await result_profile_create(env, { ...rp, quiz_id: newId, id: null });
  }
  return newId;
}
async function quiz_stats(env) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM quizzes').first()).c;
  const published = (await env.DB.prepare("SELECT COUNT(*) AS c FROM quizzes WHERE status='published'").first()).c;
  const leads = (await env.DB.prepare('SELECT COUNT(*) AS c FROM leads').first()).c;
  const started = (await env.DB.prepare('SELECT COUNT(*) AS c FROM quiz_attempts').first()).c;
  const completed = (await env.DB.prepare("SELECT COUNT(*) AS c FROM quiz_attempts WHERE completion_status='completed'").first()).c;
  const rate = started > 0 ? Math.round((completed / started) * 100) : 0;
  return {
    total_quizzes: total, published_quizzes: published,
    total_leads: leads, completion_rate: rate,
  };
}
async function quiz_recent_submissions(env, limit = 10) {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const res = await env.DB.prepare(
    `SELECT qa.created_at, l.first_name, q.title AS quiz_title
     FROM quiz_attempts qa
     JOIN leads l ON l.id = qa.lead_id
     JOIN quizzes q ON q.id = qa.quiz_id
     ORDER BY qa.created_at DESC LIMIT ${safeLimit}`
  ).all();
  return res.results || [];
}
async function quiz_completions_last_7_days(env) {
  const res = await env.DB.prepare(
    `SELECT date(completed_at) AS d, COUNT(*) AS c FROM quiz_attempts
     WHERE completion_status='completed' AND completed_at > datetime('now','-7 days')
     GROUP BY date(completed_at)`
  ).all();
  const byDate = {};
  for (const r of (res.results || [])) byDate[r.d] = r.c;
  const out = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const label = d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    out[label] = byDate[iso] || 0;
  }
  return out;
}

// -- questions --
async function question_all_for_quiz(env, quizId, activeOnly = true) {
  let sql = 'SELECT * FROM questions WHERE quiz_id = ?';
  if (activeOnly) sql += ' AND is_active = 1';
  sql += ' ORDER BY "order" ASC';
  const res = await env.DB.prepare(sql).bind(quizId).all();
  return res.results || [];
}
async function question_with_options_for_quiz(env, quizId, activeOnly = true) {
  const questions = await question_all_for_quiz(env, quizId, activeOnly);
  for (const q of questions) q.options = await option_all_for_question(env, q.id);
  return questions;
}
async function question_find(env, id) {
  return env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
}
async function question_find_in_quiz(env, id, quizId) {
  return env.DB.prepare('SELECT * FROM questions WHERE id = ? AND quiz_id = ?').bind(id, quizId).first();
}
async function question_create(env, data) {
  const res = await env.DB.prepare(
    `INSERT INTO questions (quiz_id, type, question_text, explanation, is_required, is_active, "order")
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    data.quiz_id, data.type, data.question_text, data.explanation ?? null,
    data.is_required ? 1 : 0, data.is_active ? 1 : 0, data.order ?? 0
  ).run();
  return res.meta.last_row_id;
}
async function question_update(env, id, data) {
  await env.DB.prepare(
    `UPDATE questions SET type=?, question_text=?, explanation=?, is_required=?, is_active=?, updated_at=datetime('now') WHERE id=?`
  ).bind(data.type, data.question_text, data.explanation ?? null, data.is_required ? 1 : 0, data.is_active ? 1 : 0, id).run();
}
async function question_delete(env, id) {
  await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(id).run();
}
async function question_next_order(env, quizId) {
  const row = await env.DB.prepare('SELECT MAX("order") AS m FROM questions WHERE quiz_id = ?').bind(quizId).first();
  return (row && row.m ? row.m : 0) + 1;
}
async function question_reorder(env, quizId, orderedIds) {
  let index = 1;
  for (const id of orderedIds) {
    await env.DB.prepare('UPDATE questions SET "order" = ? WHERE id = ? AND quiz_id = ?').bind(index, id, quizId).run();
    index++;
  }
}

// -- options --
async function option_all_for_question(env, questionId) {
  const res = await env.DB.prepare('SELECT * FROM answer_options WHERE question_id = ? ORDER BY "order" ASC').bind(questionId).all();
  const rows = res.results || [];
  for (const r of rows) {
    try { r.category_weights = r.category_weights ? JSON.parse(r.category_weights) : {}; }
    catch { r.category_weights = {}; }
  }
  return rows;
}
async function option_find(env, id) {
  const row = await env.DB.prepare('SELECT * FROM answer_options WHERE id = ?').bind(id).first();
  if (row) {
    try { row.category_weights = row.category_weights ? JSON.parse(row.category_weights) : {}; }
    catch { row.category_weights = {}; }
  }
  return row;
}
async function option_find_in_quiz(env, id, quizId) {
  const row = await env.DB.prepare(
    'SELECT ao.* FROM answer_options ao JOIN questions q ON q.id = ao.question_id WHERE ao.id = ? AND q.quiz_id = ?'
  ).bind(id, quizId).first();
  if (row) {
    try { row.category_weights = row.category_weights ? JSON.parse(row.category_weights) : {}; }
    catch { row.category_weights = {}; }
  }
  return row;
}
async function option_create(env, data) {
  const res = await env.DB.prepare(
    `INSERT INTO answer_options (question_id, option_text, score_value, category_weights, "order")
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    data.question_id, data.option_text, data.score_value || 0,
    JSON.stringify(data.category_weights || {}), data.order ?? 0
  ).run();
  return res.meta.last_row_id;
}
async function option_update(env, id, data) {
  await env.DB.prepare(
    `UPDATE answer_options SET option_text=?, score_value=?, category_weights=?, updated_at=datetime('now') WHERE id=?`
  ).bind(data.option_text, data.score_value || 0, JSON.stringify(data.category_weights || {}), id).run();
}
async function option_delete(env, id) {
  await env.DB.prepare('DELETE FROM answer_options WHERE id = ?').bind(id).run();
}
async function option_next_order(env, questionId) {
  const row = await env.DB.prepare('SELECT MAX("order") AS m FROM answer_options WHERE question_id = ?').bind(questionId).first();
  return (row && row.m ? row.m : 0) + 1;
}

// -- result profiles --
async function result_profile_all_for_quiz(env, quizId) {
  const res = await env.DB.prepare('SELECT * FROM result_profiles WHERE quiz_id = ? AND is_active = 1').bind(quizId).all();
  const rows = res.results || [];
  for (const r of rows) {
    try { r.category_conditions = r.category_conditions ? JSON.parse(r.category_conditions) : null; }
    catch { r.category_conditions = null; }
  }
  return rows;
}
async function result_profile_find(env, id) {
  const row = await env.DB.prepare('SELECT * FROM result_profiles WHERE id = ?').bind(id).first();
  if (row) {
    try { row.category_conditions = row.category_conditions ? JSON.parse(row.category_conditions) : null; }
    catch { row.category_conditions = null; }
  }
  return row;
}
async function result_profile_create(env, data) {
  const res = await env.DB.prepare(
    `INSERT INTO result_profiles (quiz_id, title, description, score_min, score_max, category_conditions, recommendations, cta_text, whatsapp_message, affiliate_cta, affiliate_url, affiliate_text, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    data.quiz_id, data.title, data.description,
    data.score_min ?? null, data.score_max ?? null,
    data.category_conditions ? JSON.stringify(data.category_conditions) : null,
    data.recommendations ?? null, data.cta_text ?? null, data.whatsapp_message ?? null,
    data.affiliate_cta ?? null, data.affiliate_url ?? null, data.affiliate_text ?? null,
    data.is_active ? 1 : (data.is_active === 0 ? 0 : 1)
  ).run();
  return res.meta.last_row_id;
}

// -- leads --
async function lead_find(env, id) {
  return env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first();
}
async function lead_find_by_phone(env, quizId, phone) {
  return env.DB.prepare('SELECT * FROM leads WHERE quiz_id = ? AND phone = ?').bind(quizId, phone).first();
}
async function lead_find_by_email(env, quizId, email) {
  return env.DB.prepare('SELECT * FROM leads WHERE quiz_id = ? AND email = ?').bind(quizId, email).first();
}
async function lead_create(env, data) {
  const res = await env.DB.prepare(
    `INSERT INTO leads (uuid, quiz_id, first_name, email, phone, utm_source, utm_medium, utm_campaign, referrer, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    uuid4(), data.quiz_id, data.first_name ?? null, data.email ?? null, data.phone ?? null,
    data.utm_source ?? null, data.utm_medium ?? null, data.utm_campaign ?? null,
    data.referrer ?? null, data.ip_address ?? null
  ).run();
  return res.meta.last_row_id;
}
async function lead_update(env, id, data) {
  await env.DB.prepare(
    `UPDATE leads SET first_name=?, email=?, phone=?, updated_at=datetime('now') WHERE id=?`
  ).bind(data.first_name ?? null, data.email ?? null, data.phone ?? null, id).run();
}

// -- attempts --
async function attempt_find_by_attempt_id(env, attemptId) {
  const row = await env.DB.prepare('SELECT * FROM quiz_attempts WHERE attempt_id = ?').bind(attemptId).first();
  if (row) {
    try { row.progress = row.progress ? JSON.parse(row.progress) : {}; }
    catch { row.progress = {}; }
  }
  return row;
}
async function attempt_find_started(env, leadId, quizId) {
  return env.DB.prepare(
    `SELECT * FROM quiz_attempts WHERE lead_id = ? AND quiz_id = ? AND completion_status = 'started' ORDER BY id DESC LIMIT 1`
  ).bind(leadId, quizId).first();
}
async function attempt_create(env, leadId, quizId) {
  const attemptId = randomHex(32);
  await env.DB.prepare(
    'INSERT INTO quiz_attempts (attempt_id, lead_id, quiz_id, current_question_index) VALUES (?, ?, ?, 0)'
  ).bind(attemptId, leadId, quizId).run();
  return attempt_find_by_attempt_id(env, attemptId);
}
async function attempt_or_create(env, leadId, quizId) {
  const started = await attempt_find_started(env, leadId, quizId);
  if (started) return started;
  return attempt_create(env, leadId, quizId);
}
async function attempt_save_answers(env, attemptId, answers, currentIndex) {
  const attempt = await env.DB.prepare('SELECT * FROM quiz_attempts WHERE attempt_id = ?').bind(attemptId).first();
  if (!attempt) return false;
  if (attempt.completion_status === 'completed') return true;
  let progress = {};
  try { progress = attempt.progress ? JSON.parse(attempt.progress) : {}; }
  catch { progress = {}; }
  for (const [qid, answer] of Object.entries(answers)) {
    progress[qid] = answer;
    await env.DB.prepare(
      `INSERT INTO quiz_answers (attempt_id, question_id, answer_value) VALUES (?, ?, ?)
       ON CONFLICT(attempt_id, question_id) DO UPDATE SET answer_value = excluded.answer_value, updated_at = datetime('now')`
    ).bind(attemptId, parseInt(qid, 10), JSON.stringify(answer)).run();
  }
  await env.DB.prepare(
    `UPDATE quiz_attempts SET progress = ?, current_question_index = ?, updated_at = datetime('now') WHERE attempt_id = ?`
  ).bind(JSON.stringify(progress), currentIndex, attemptId).run();
  return true;
}
async function attempt_mark_completed(env, attemptId, score, category, resultProfileId) {
  await env.DB.prepare(
    `UPDATE quiz_attempts SET score_total=?, result_category=?, result_profile_id=?, completion_status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE attempt_id=?`
  ).bind(score, category, resultProfileId, attemptId).run();
}

// -- events --
async function event_log(env, type, quizId, attemptId) {
  await env.DB.prepare('INSERT INTO events (quiz_id, event_type, attempt_id) VALUES (?, ?, ?)')
    .bind(quizId ?? null, type, attemptId ?? null).run();
}
async function share_event_create(env, attemptId, platform) {
  await env.DB.prepare('INSERT INTO share_events (attempt_id, platform) VALUES (?, ?)').bind(attemptId, platform).run();
}

// -- settings --
async function setting_get(env, key, fallback = '') {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind(key).first();
  return row && row.value != null ? row.value : fallback;
}
async function setting_set(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings ("key", value) VALUES (?, ?)
     ON CONFLICT("key") DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).bind(key, value).run();
}

// -- webhooks --
async function webhook_all(env) {
  const res = await env.DB.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all();
  const rows = res.results || [];
  for (const r of rows) {
    try { r.events = JSON.parse(r.events); } catch { r.events = []; }
  }
  return rows;
}
async function webhook_active_for_event(env, event) {
  const res = await env.DB.prepare('SELECT * FROM webhooks WHERE is_active = 1').all();
  const matches = [];
  for (const r of (res.results || [])) {
    let evs = [];
    try { evs = JSON.parse(r.events); } catch {}
    if (evs.includes(event)) matches.push(r);
  }
  return matches;
}
async function webhook_create(env, url, events) {
  const res = await env.DB.prepare('INSERT INTO webhooks (url, events, is_active) VALUES (?, ?, 1)')
    .bind(url, JSON.stringify(events)).run();
  return res.meta.last_row_id;
}
async function webhook_toggle(env, id) {
  await env.DB.prepare('UPDATE webhooks SET is_active = 1 - is_active WHERE id = ?').bind(id).run();
}
async function webhook_delete(env, id) {
  await env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(id).run();
}
async function webhook_enqueue(env, url, event, payload) {
  await env.DB.prepare('INSERT INTO webhook_jobs (url, event, payload) VALUES (?, ?, ?)')
    .bind(url, event, JSON.stringify(payload)).run();
}
async function webhook_dispatch_event(env, event, payload) {
  const hooks = await webhook_active_for_event(env, event);
  for (const h of hooks) await webhook_enqueue(env, h.url, event, payload);
}

// ---------------------------------------------------------------------------
// Security helpers (SSRF, IP, rate limit)
// ---------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  // IPv6 checks
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('::ffff:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (lower.startsWith('ff')) return true;
  return false;
}

async function resolveHostViaDoh(host) {
  // Use Cloudflare's DoH endpoint (JSON API). We intentionally prefer CF's own
  // resolver because it is operated by the same provider as the Worker.
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`;
  try {
    const r = await fetch(url, { headers: { 'accept': 'application/dns-json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const answers = (j.Answer || []).filter(a => a.type === 1 || a.type === 28);
    return answers.map(a => a.data);
  } catch { return null; }
}

async function is_url_safe_for_webhook(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { ok: false, reason: 'Invalid URL.' }; }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Webhook URL must use https://' };
  }
  if (parsed.port && parsed.port !== '443') {
    return { ok: false, reason: 'Webhook URL must use port 443.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'Missing hostname.' };
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.onion') || host.endsWith('.home.arpa')) {
    return { ok: false, reason: 'Private hostname not allowed.' };
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) return { ok: false, reason: 'Private IP not allowed.' };
    return { ok: true };
  }
  const ips = await resolveHostViaDoh(host);
  if (!ips || ips.length === 0) {
    return { ok: false, reason: 'Hostname could not be resolved.' };
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      return { ok: false, reason: 'Hostname resolves to a private address.' };
    }
  }
  return { ok: true };
}

function client_ip(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}
async function ip_lead_rate_limited(env, ip, max = 8, seconds = 60) {
  const clamped = Math.max(1, Math.min(3600, seconds));
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE ip_address = ? AND created_at > datetime('now', '-' || ? || ' seconds')`
  ).bind(ip, clamped).first();
  return row && row.c >= max;
}

// ---------------------------------------------------------------------------
// Services (scoring + lead capture)
// ---------------------------------------------------------------------------
function scoring_find_option(options, id) {
  for (const o of options) {
    if (parseInt(o.id, 10) === parseInt(id, 10)) return o;
  }
  return null;
}
async function scoring_calculate(env, attempt) {
  const answers = attempt.progress || {};
  const questions = await question_with_options_for_quiz(env, attempt.quiz_id, false);
  let totalScore = 0;
  const categoryScores = {};
  for (const question of questions) {
    const answer = answers[question.id] ?? null;
    if (answer === null || answer === undefined || answer === '') continue;
    const options = question.options || [];
    if (['single_choice', 'yes_no', 'dropdown'].includes(question.type)) {
      const opt = scoring_find_option(options, answer);
      if (opt) {
        totalScore += parseInt(opt.score_value, 10) || 0;
        const weights = opt.category_weights || {};
        for (const [cat, w] of Object.entries(weights)) {
          categoryScores[cat] = (categoryScores[cat] || 0) + (parseInt(w, 10) || 0);
        }
      }
    } else if (question.type === 'multiple_choice') {
      const list = Array.isArray(answer) ? answer : [];
      for (const id of list) {
        const opt = scoring_find_option(options, id);
        if (opt) {
          totalScore += parseInt(opt.score_value, 10) || 0;
          const weights = opt.category_weights || {};
          for (const [cat, w] of Object.entries(weights)) {
            categoryScores[cat] = (categoryScores[cat] || 0) + (parseInt(w, 10) || 0);
          }
        }
      }
    }
  }
  const sorted = Object.entries(categoryScores).sort((a, b) => b[1] - a[1]);
  const primary = sorted.length ? sorted[0][0] : null;
  const profile = await scoring_match_result_profile(env, attempt.quiz_id, totalScore, categoryScores);
  return { score: totalScore, primary_category: primary, category_scores: categoryScores, result_profile: profile };
}
async function scoring_match_result_profile(env, quizId, score, categoryScores) {
  const profiles = await result_profile_all_for_quiz(env, quizId);
  for (const profile of profiles) {
    if (profile.score_min != null && score < profile.score_min) continue;
    if (profile.score_max != null && score > profile.score_max) continue;
    if (profile.category_conditions) {
      let match = true;
      for (const [cat, condition] of Object.entries(profile.category_conditions)) {
        const operator = Object.keys(condition)[0];
        const value = condition[operator];
        const catScore = categoryScores[cat] || 0;
        let ok;
        if (operator === '>' || operator === '=') ok = catScore > value;
        else if (operator === '<') ok = catScore < value;
        else if (operator === '>=') ok = catScore >= value;
        else if (operator === '<=') ok = catScore <= value;
        else if (operator === '==') ok = catScore === value;
        else if (operator === '!=') ok = catScore !== value;
        else ok = false;
        if (!ok) { match = false; break; }
      }
      if (!match) continue;
    }
    return profile;
  }
  return profiles.length ? profiles[0] : null;
}

async function lead_capture_start(env, quiz, data) {
  const phone = data.phone ? String(data.phone).trim() : null;
  const email = data.email ? String(data.email).trim().toLowerCase() : null;
  let lead = null;
  if (phone) lead = await lead_find_by_phone(env, quiz.id, phone);
  if (!lead && email) lead = await lead_find_by_email(env, quiz.id, email);
  const attributes = {
    quiz_id: quiz.id,
    first_name: data.first_name ?? null,
    email,
    phone,
    utm_source: data.utm_source ?? null,
    utm_medium: data.utm_medium ?? null,
    utm_campaign: data.utm_campaign ?? null,
    referrer: data.referrer ?? null,
    ip_address: data.ip_address ?? null,
  };
  let leadId;
  if (lead) { await lead_update(env, lead.id, attributes); leadId = lead.id; }
  else { leadId = await lead_create(env, attributes); }
  const attempt = await attempt_or_create(env, leadId, quiz.id);
  await event_log(env, 'lead_captured', quiz.id, attempt.attempt_id);
  return { lead_id: leadId, attempt };
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
async function current_user(request, env, session) {
  if (!session || !session.userId) return null;
  return user_find_by_id(env, session.userId);
}
async function is_admin(request, env, session) {
  const u = await current_user(request, env, session);
  return u && u.is_admin ? u : null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function matchRoute(method, pathname, routes) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const parts = pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (parts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.startsWith('{') && p.endsWith('}')) {
        params[p.slice(1, -1)] = decodeURIComponent(pathParts[i]);
      } else if (p !== pathParts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// View: shared page layout
// ---------------------------------------------------------------------------
function adminNav(currentUser, csrf) {
  if (!currentUser) return '';
  return `
<nav x-data="{ open: false }" class="bg-slate-950 text-white sticky top-0 z-40">
  <div class="max-w-7xl mx-auto px-4 sm:px-6">
    <div class="flex h-14 items-center justify-between">
      <a href="/admin" class="font-black tracking-tight text-lg">${e('Quiz Funnel')}</a>
      <div class="hidden md:flex items-center gap-1">
        <a href="/admin" class="px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Dashboard</a>
        <a href="/admin/quizzes" class="px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Quizzes</a>
        <a href="/admin/leads" class="px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Leads</a>
        <a href="/admin/settings" class="px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Settings</a>
      </div>
      <div class="hidden md:flex items-center gap-4">
        <span class="text-sm text-slate-400">${e(currentUser.email)}</span>
        <form method="POST" action="/admin/logout">
          <input type="hidden" name="_csrf" value="${e(csrf)}">
          <button class="text-sm font-medium px-3 py-2 rounded-lg hover:bg-white/10">Log out</button>
        </form>
      </div>
      <button @click="open = !open" class="md:hidden p-2 rounded-lg hover:bg-white/10">
        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
    </div>
  </div>
  <div x-show="open" x-cloak class="md:hidden pb-4 space-y-1">
    <a href="/admin" class="block px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Dashboard</a>
    <a href="/admin/quizzes" class="block px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Quizzes</a>
    <a href="/admin/leads" class="block px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Leads</a>
    <a href="/admin/settings" class="block px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Settings</a>
    <form method="POST" action="/admin/logout">
      <input type="hidden" name="_csrf" value="${e(csrf)}">
      <button class="w-full text-left px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/10">Log out (${e(currentUser.email)})</button>
    </form>
  </div>
</nav>`;
}

function pageLayout({ title, description, pixelId, csrf, body, currentUser }) {
  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${e(csrf || '')}">
<title>${e(title)}</title>
<meta name="description" content="${e(description || '')}">
<script src="https://cdn.tailwindcss.com?plugins=typography"></script>
<script defer src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js"></script>
<style>
[x-cloak]{display:none!important}
@keyframes fade-in-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.animate-fade-in-up{animation:fade-in-up .5s ease-out both}
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
</style>
<script>
function csrfToken(){return document.querySelector('meta[name="csrf-token"]').content;}
async function apiFetch(url,options={}){
  const opts={method:options.method||'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken(),'X-Requested-With':'XMLHttpRequest'}};
  if(options.body)opts.body=JSON.stringify(options.body);
  const res=await fetch(url,opts);
  let data=null;try{data=await res.json();}catch(e){}
  if(!res.ok){const m=(data&&data.message)||('Request failed ('+res.status+')');throw new Error(m);}
  return data;
}
function showToast(message,isError){
  const el=document.createElement('div');
  el.textContent=message;
  el.className='fixed bottom-6 left-1/2 -translate-x-1/2 text-white text-sm font-medium px-4 py-2.5 rounded-full shadow-lg z-50 '+(isError?'bg-red-600':'bg-slate-900');
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),2600);
}
</script>
${pixelId ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${e(pixelId)}');fbq('track','PageView');</script>` : ''}
</head>
<body class="antialiased bg-gray-50 text-slate-900">
${currentUser ? adminNav(currentUser, csrf) : ''}
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------
function viewHome(env) {
  return pageLayout({
    title: env.APP_NAME || 'Quiz Funnel',
    description: 'Lead-generation quiz funnel platform.',
    body: `
<div class="min-h-[70vh] flex items-center justify-center px-4">
  <div class="text-center max-w-md">
    <h1 class="text-2xl font-black text-slate-950">${e(env.APP_NAME || 'Quiz Funnel')}</h1>
    <p class="mt-3 text-slate-500">This is a lead-generation quiz funnel platform. Visit a specific funnel at <code class="bg-slate-100 px-1.5 py-0.5 rounded">/q/your-quiz-slug</code>, or <a href="/admin/login" class="text-indigo-600 hover:underline">log in to the admin panel</a>.</p>
  </div>
</div>`,
  });
}

function view404(env, csrf, currentUser) {
  return pageLayout({
    title: 'Not found',
    body: `
<div class="min-h-[60vh] flex items-center justify-center px-4">
  <div class="text-center">
    <p class="text-6xl font-black text-slate-200">404</p>
    <p class="mt-2 text-slate-600">That page doesn't exist.</p>
    <a href="/" class="mt-4 inline-block text-indigo-600 font-medium hover:underline">Go home</a>
  </div>
</div>`,
    csrf, currentUser,
  });
}

function viewQuizLanding(quiz, csrf) {
  const theme = quizTheme(quiz.template);
  const scale = textScale(quiz.text_scale);
  const heroImgClass = imageSizeClass(quiz.hero_image_size);

  const heroImageBlock = quiz.hero_image
    ? `<img src="${e(quiz.hero_image)}" class="${heroImgClass} w-full h-auto mx-auto mb-6 rounded-2xl object-cover shadow-lg" alt="">`
    : '';

  const brandBlock = quiz.logo
    ? `<img src="${e(quiz.logo)}" class="h-12 mx-auto mb-6 rounded" alt="">`
    : quiz.brand_name
      ? `<p class="text-sm font-bold uppercase tracking-widest ${theme.badgeText} mb-4">${e(quiz.brand_name)}</p>`
      : '';

  // Prefer the new landing_content. Fall back to legacy blocks (migrated on the fly).
  let contentRaw = quiz.landing_content || '';
  if (!contentRaw && quiz.sections) {
    contentRaw = legacyBlocksToHtml(quiz.sections);
  }
  const contentHtml = renderLandingContent(contentRaw, quiz);

  const instructionsBlock = quiz.instructions ? `
  <section class="max-w-3xl mx-auto px-4 py-12">
    <div class="rounded-2xl border p-6 sm:p-7 ${theme.sectionCard}">
      <h3 class="font-bold mb-2 ${theme.sectionHeading}">How it works</h3>
      <p class="leading-relaxed whitespace-pre-line ${theme.sectionBody}">${e(quiz.instructions)}</p>
    </div>
  </section>` : '';

  const body = `
<div x-data="quizFunnel('${e(quiz.slug)}')" x-init="init()" class="min-h-screen bg-white">

<div x-show="stage === 'landing'" x-cloak>
  <section class="relative overflow-hidden ${theme.hero} py-20 sm:py-24 px-4">
    <div class="relative max-w-2xl mx-auto text-center animate-fade-in-up">
      ${heroImageBlock}
      ${brandBlock}
      <h1 class="${scale.title} font-black leading-tight">${e(quiz.title)}</h1>
      ${quiz.subtitle ? `<p class="mt-4 ${scale.subtitle} ${theme.subtitleText}">${e(quiz.subtitle)}</p>` : ''}
      ${quiz.description ? `<p class="mt-4 ${theme.bodyText} leading-relaxed">${e(quiz.description)}</p>` : ''}
      <button @click="stage = 'lead'" class="mt-8 inline-flex items-center rounded-xl ${theme.button} font-bold px-7 py-4 text-lg shadow-xl hover:scale-105 transition">${e(quiz.primary_cta || 'Start')}</button>
    </div>
  </section>

  <article class="max-w-3xl mx-auto px-4 py-10 prose prose-slate lg:prose-lg max-w-none">
    ${contentHtml}
  </article>

  ${instructionsBlock}
</div>

<div x-show="stage === 'lead'" x-cloak class="min-h-screen flex items-center justify-center px-4 py-16 bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900">
  <div class="max-w-md w-full bg-white rounded-2xl p-6 sm:p-8 animate-fade-in-up">
    <h2 class="text-xl font-bold text-slate-950">Almost there</h2>
    <p class="text-sm text-slate-500 mt-1">Tell us where to send your personalized result.</p>
    <form @submit.prevent="submitLead()" class="mt-5 space-y-4">
      <div>
        <label class="block text-sm font-medium text-slate-700">First name</label>
        <input x-model="leadForm.first_name" required maxlength="255" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">WhatsApp / phone</label>
        <input x-model="leadForm.phone" required maxlength="30" placeholder="+1 555 123 4567" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">Email</label>
        <input x-model="leadForm.email" type="email" maxlength="255" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <p x-show="error" x-text="error" class="text-sm text-red-600"></p>
      <button type="submit" :disabled="loading" class="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 transition text-white font-bold py-3.5">
        <span x-show="!loading">${e(quiz.result_cta || 'Continue')}</span>
        <span x-show="loading">Please wait...</span>
      </button>
    </form>
  </div>
</div>

<div x-show="stage === 'quiz'" x-cloak class="min-h-screen bg-slate-50 flex flex-col">
  <div class="h-1.5 bg-slate-200">
    <div class="h-1.5 bg-indigo-600 transition-all duration-300" :style="'width:' + progressPercent + '%'"></div>
  </div>
  <div class="flex-1 flex items-center justify-center px-4 py-10">
    <div class="max-w-xl w-full">
      <template x-for="(q, idx) in questions" :key="q.id">
        <div x-show="currentIndex === idx" x-cloak class="animate-fade-in-up">
          <p class="text-xs font-bold uppercase tracking-widest text-indigo-500" x-text="'Question ' + (idx + 1) + ' of ' + questions.length"></p>
          <h2 class="mt-2 text-xl font-bold text-slate-950" x-text="q.question_text"></h2>
          <p x-show="q.explanation" x-text="q.explanation" class="mt-2 text-slate-500 text-sm"></p>
          <div class="mt-6 space-y-2">
            <template x-if="['single_choice','yes_no','dropdown'].includes(q.type)">
              <div class="space-y-2">
                <template x-for="opt in q.options" :key="opt.id">
                  <button type="button" @click="selectSingle(q, opt)"
                    class="w-full text-left rounded-xl border-2 p-4 hover:border-indigo-500 hover:bg-indigo-50/50 transition"
                    :class="answers[q.id] === opt.id ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200'">
                    <span x-text="opt.option_text"></span>
                  </button>
                </template>
              </div>
            </template>
            <template x-if="q.type === 'multiple_choice'">
              <div class="space-y-2">
                <template x-for="opt in q.options" :key="opt.id">
                  <label class="flex items-center gap-3 rounded-xl border-2 p-4 cursor-pointer hover:border-indigo-500"
                    :class="(answers[q.id] || []).includes(opt.id) ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200'">
                    <input type="checkbox" class="rounded border-slate-300 text-indigo-600" @change="toggleMulti(q, opt)" :checked="(answers[q.id] || []).includes(opt.id)">
                    <span x-text="opt.option_text"></span>
                  </label>
                </template>
                <button type="button" @click="next(q)" class="mt-3 w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5">Next</button>
              </div>
            </template>
            <template x-if="q.type === 'rating'">
              <div>
                <div class="flex gap-2 justify-center">
                  <template x-for="n in 5" :key="n">
                    <button type="button" @click="answers[q.id] = n"
                      class="h-12 w-12 rounded-full border-2 font-bold transition"
                      :class="answers[q.id] === n ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 hover:border-indigo-400'"
                      x-text="n"></button>
                  </template>
                </div>
                <button type="button" @click="next(q)" class="mt-5 w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5">Next</button>
              </div>
            </template>
            <template x-if="['text','email','phone','number'].includes(q.type)">
              <div>
                <input :type="q.type === 'number' ? 'number' : (q.type === 'email' ? 'email' : 'text')" x-model="answers[q.id]" @keydown.enter.prevent="next(q)"
                  class="w-full rounded-xl border-2 border-slate-200 p-4 focus:border-indigo-500 outline-none">
                <button type="button" @click="next(q)" class="mt-4 w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5">Next</button>
              </div>
            </template>
          </div>
          <button x-show="idx > 0" type="button" @click="currentIndex--" class="mt-4 text-sm text-slate-400 hover:text-slate-600">Back</button>
        </div>
      </template>
      <p x-show="submitting" x-cloak class="text-center text-slate-500 mt-6">Calculating your result...</p>
      <p x-show="error" x-text="error" class="text-center text-red-600 mt-4"></p>
    </div>
  </div>
</div>

</div>

<script>
function quizFunnel(slug){
  return {
    slug,
    stage: 'landing',
    leadForm: { first_name: '', phone: '', email: '' },
    attemptId: null,
    questions: [],
    currentIndex: 0,
    answers: {},
    loading: false,
    submitting: false,
    error: '',
    init(){
      const saved = localStorage.getItem('attempt_' + slug);
      if (saved) this.attemptId = saved;
    },
    get progressPercent(){
      if (!this.questions.length) return 0;
      return Math.round((this.currentIndex / this.questions.length) * 100);
    },
    async submitLead(){
      this.error=''; this.loading=true;
      try{
        const qs=new URLSearchParams(window.location.search);
        const data=await apiFetch('/api/quiz/'+this.slug+'/lead',{method:'POST',body:{
          first_name:this.leadForm.first_name,
          phone:this.leadForm.phone,
          email:this.leadForm.email,
          utm_source:qs.get('utm_source')||'',
          utm_medium:qs.get('utm_medium')||'',
          utm_campaign:qs.get('utm_campaign')||'',
          referrer:document.referrer||''
        }});
        this.attemptId=data.attempt_id;
        localStorage.setItem('attempt_'+this.slug,this.attemptId);
        const qdata=await apiFetch('/api/quiz/'+this.slug+'/questions');
        this.questions=qdata.questions;
        this.stage='quiz';
      }catch(e){ this.error=e.message; }
      finally{ this.loading=false; }
    },
    selectSingle(q,opt){
      this.answers[q.id]=opt.id;
      this.save();
      setTimeout(()=>this.next(q), 200);
    },
    toggleMulti(q,opt){
      const list=this.answers[q.id]||[];
      const idx=list.indexOf(opt.id);
      if(idx>=0) list.splice(idx,1); else list.push(opt.id);
      this.answers[q.id]=list;
      this.save();
    },
    async save(){
      if(!this.attemptId) return;
      try{
        await apiFetch('/api/attempt/'+this.attemptId+'/autosave',{method:'POST',body:{answers:this.answers,current_question_index:this.currentIndex}});
      }catch(e){}
    },
    async next(q){
      if(this.currentIndex < this.questions.length-1){
        this.currentIndex++;
        this.save();
      } else {
        this.submitting=true;
        try{
          const data=await apiFetch('/api/attempt/'+this.attemptId+'/submit',{method:'POST'});
          localStorage.removeItem('attempt_'+this.slug);
          window.location.href=data.result_url;
        }catch(e){ this.error=e.message; this.submitting=false; }
      }
    }
  };
}
</script>`;

  return pageLayout({
    title: quiz.title + ' — ' + (quiz.brand_name || 'Quiz'),
    description: quiz.description || '',
    csrf,
    body,
  });
}

function viewQuizResult({ attempt, lead, profile, whatsappNumber, resultUrl, isOwner, csrf }) {
  const title = profile && profile.title ? profile.title : 'Your result';
  const description = profile && profile.description ? profile.description : '';
  const recommendations = profile && profile.recommendations ? profile.recommendations : '';
  const ctaText = profile && profile.cta_text ? profile.cta_text : 'Send My Result to WhatsApp';

  let whatsappMessage;
  if (profile && profile.whatsapp_message) {
    whatsappMessage = String(profile.whatsapp_message).replace(/\{RESULT_LINK\}/g, resultUrl);
  } else {
    whatsappMessage = 'Here is my result: ' + resultUrl;
  }

  const whatsappLink = whatsappNumber
    ? `https://api.whatsapp.com/send?phone=${encodeURIComponent(whatsappNumber)}&text=${encodeURIComponent(whatsappMessage)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(whatsappMessage)}`;

  const body = `
<div class="min-h-screen bg-slate-50">
  <section class="relative overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 text-white py-16 sm:py-20 px-4">
    <div class="relative max-w-2xl mx-auto text-center animate-fade-in-up">
      <div class="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-white/10 border border-white/20 text-3xl">✓</div>
      <p class="mt-6 text-sm font-bold uppercase tracking-widest text-indigo-300">Your result is ready</p>
      <h1 class="mt-2 text-3xl sm:text-4xl font-black leading-tight">${e(title)}</h1>
      ${description ? `<p class="mt-4 text-slate-300 leading-relaxed whitespace-pre-line">${e(description)}</p>` : ''}
    </div>
  </section>

  <section class="max-w-2xl mx-auto px-4 mt-8 sm:-mt-10 pb-16 space-y-5">
    ${recommendations ? `
    <div class="bg-white rounded-2xl border p-5 sm:p-6">
      <p class="font-bold text-slate-950 flex items-center gap-2"><span>📋</span> Recommended next steps</p>
      <p class="mt-3 text-slate-600 leading-relaxed whitespace-pre-line">${e(recommendations)}</p>
    </div>` : ''}

    <div class="bg-white rounded-2xl border p-5 sm:p-6">
      <p class="font-bold text-slate-950">${e(ctaText)}</p>
      <a href="${e(whatsappLink)}" target="_blank" rel="noopener" onclick="trackWhatsappClick()" class="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-emerald-600 hover:bg-emerald-700 transition text-white font-bold py-3.5">
        Send to WhatsApp
      </a>
    </div>

    <div class="bg-white rounded-2xl border p-5 sm:p-6">
      <p class="font-bold text-slate-950">Share your result</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button onclick="share('copy')" class="rounded-xl bg-slate-100 hover:bg-slate-200 transition text-slate-900 px-4 py-2.5 text-sm font-semibold">Copy link</button>
        <button onclick="share('whatsapp')" class="rounded-xl bg-emerald-500 hover:bg-emerald-600 transition text-white px-4 py-2.5 text-sm font-semibold">WhatsApp</button>
        <button onclick="share('facebook')" class="rounded-xl bg-blue-600 hover:bg-blue-700 transition text-white px-4 py-2.5 text-sm font-semibold">Facebook</button>
        <button onclick="share('twitter')" class="rounded-xl bg-black hover:bg-slate-800 transition text-white px-4 py-2.5 text-sm font-semibold">X</button>
        <button onclick="share('linkedin')" class="rounded-xl bg-blue-700 hover:bg-blue-800 transition text-white px-4 py-2.5 text-sm font-semibold">LinkedIn</button>
      </div>
    </div>

    <p class="text-center text-xs text-slate-400">Assessment ID: ${e(attempt.attempt_id)}</p>
  </section>
</div>

<script>
const ATTEMPT_ID = ${JSON.stringify(attempt.attempt_id)};
function trackWhatsappClick(){
  apiFetch('/api/whatsapp-click',{method:'POST',body:{attempt_id:ATTEMPT_ID}}).catch(()=>{});
}
function share(platform){
  const url=window.location.href;
  let shareUrl='';
  switch(platform){
    case 'copy': navigator.clipboard.writeText(url); showToast('Link copied!'); break;
    case 'whatsapp': shareUrl='https://api.whatsapp.com/send?text='+encodeURIComponent('Check out my result: '+url); break;
    case 'facebook': shareUrl='https://www.facebook.com/sharer.php?u='+encodeURIComponent(url); break;
    case 'twitter': shareUrl='https://twitter.com/intent/tweet?url='+encodeURIComponent(url); break;
    case 'linkedin': shareUrl='https://www.linkedin.com/sharing/share-offsite/?url='+encodeURIComponent(url); break;
  }
  if(shareUrl) window.open(shareUrl,'_blank','noopener');
  apiFetch('/api/share',{method:'POST',body:{attempt_id:ATTEMPT_ID,platform}}).catch(()=>{});
}
</script>`;

  return pageLayout({ title, description, csrf, body });
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------
function viewAdminLogin(csrf, error, needSetup) {
  const body = `
<div class="min-h-screen flex items-center justify-center bg-slate-50 px-4">
  <div class="max-w-sm w-full bg-white rounded-2xl border shadow-sm p-7">
    <h1 class="text-xl font-bold text-slate-950">Admin login</h1>
    ${error ? `<p class="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">${e(error)}</p>` : ''}
    ${needSetup ? `<p class="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">No admin account exists yet. <a href="/setup" class="underline font-semibold">Create the first admin</a>.</p>` : ''}
    <form method="POST" action="/admin/login" class="mt-4 space-y-4">
      <input type="hidden" name="_csrf" value="${e(csrf)}">
      <div>
        <label class="block text-sm font-medium text-slate-700">Email</label>
        <input type="email" name="email" required class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">Password</label>
        <input type="password" name="password" required class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <button class="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5">Log in</button>
    </form>
  </div>
</div>`;
  return pageLayout({ title: 'Log in', csrf, body });
}

function viewSetup(csrf, error) {
  const body = `
<div class="min-h-screen flex items-center justify-center bg-slate-50 px-4">
  <div class="max-w-sm w-full bg-white rounded-2xl border shadow-sm p-7">
    <h1 class="text-xl font-bold text-slate-950">Create the first admin</h1>
    <p class="mt-2 text-sm text-slate-500">This form only works while the users table is empty.</p>
    ${error ? `<p class="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">${e(error)}</p>` : ''}
    <form method="POST" action="/setup" class="mt-4 space-y-4">
      <input type="hidden" name="_csrf" value="${e(csrf)}">
      <div>
        <label class="block text-sm font-medium text-slate-700">Name</label>
        <input name="name" required class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">Email</label>
        <input type="email" name="email" required class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">Password (min 8 chars)</label>
        <input type="password" name="password" required minlength="8" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <button class="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5">Create admin</button>
    </form>
  </div>
</div>`;
  return pageLayout({ title: 'Setup', csrf, body });
}

function viewAdminDashboard(stats, recent, chartData, csrf, currentUser) {
  const labels = Object.keys(chartData);
  const values = Object.values(chartData);
  const body = `
<main class="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
  <div>
    <h2 class="text-xl font-bold text-slate-950">Dashboard</h2>
    <p class="text-sm text-slate-500 mt-1">An overview of your funnels and leads.</p>
  </div>
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
    <div class="bg-white p-4 sm:p-5 rounded-2xl border"><h3 class="text-xs sm:text-sm text-slate-500 font-medium">Total Quizzes</h3><p class="text-2xl sm:text-3xl font-black mt-1 text-slate-950">${stats.total_quizzes}</p></div>
    <div class="bg-white p-4 sm:p-5 rounded-2xl border"><h3 class="text-xs sm:text-sm text-slate-500 font-medium">Published</h3><p class="text-2xl sm:text-3xl font-black mt-1 text-slate-950">${stats.published_quizzes}</p></div>
    <div class="bg-white p-4 sm:p-5 rounded-2xl border"><h3 class="text-xs sm:text-sm text-slate-500 font-medium">Total Leads</h3><p class="text-2xl sm:text-3xl font-black mt-1 text-slate-950">${stats.total_leads}</p></div>
    <div class="bg-indigo-600 p-4 sm:p-5 rounded-2xl"><h3 class="text-xs sm:text-sm text-indigo-100 font-medium">Completion Rate</h3><p class="text-2xl sm:text-3xl font-black mt-1 text-white">${stats.completion_rate}%</p></div>
  </div>
  <div class="bg-white p-4 sm:p-5 rounded-2xl border">
    <h3 class="font-semibold mb-3 text-slate-900">Last 7 Days Completions</h3>
    <div class="relative h-56 sm:h-64"><canvas id="completionChart"></canvas></div>
  </div>
  <div class="bg-white rounded-2xl border overflow-hidden">
    <h3 class="font-semibold p-4 sm:p-5 border-b text-slate-900">Recent Submissions</h3>
    <ul class="divide-y">
      ${recent.length === 0 ? `<li class="px-4 sm:px-5 py-6 text-center text-slate-400 text-sm">No submissions yet.</li>` :
        recent.map(r => `<li class="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span class="font-medium text-slate-900">${e(r.first_name || 'Anonymous')}</span>
          <span class="text-slate-500">${e(r.quiz_title)}</span>
          <span class="text-slate-400 text-xs">${e(r.created_at)}</span>
        </li>`).join('')}
    </ul>
  </div>
</main>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
new Chart(document.getElementById('completionChart').getContext('2d'),{
  type:'line',
  data:{labels:${JSON.stringify(labels)},datasets:[{label:'Completions',data:${JSON.stringify(values)},borderColor:'rgb(79,70,229)',backgroundColor:'rgba(79,70,229,0.08)',fill:true,tension:0.3}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
});
</script>`;
  return pageLayout({ title: 'Dashboard', csrf, body, currentUser });
}

function viewAdminQuizzesList(csrf, currentUser) {
  const body = `
<main class="max-w-7xl mx-auto px-4 sm:px-6 py-8" x-data="quizList()" x-init="load()">
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
    <h2 class="text-xl font-bold text-slate-950">Quizzes</h2>
    <a href="/admin/quizzes/create" class="inline-flex items-center justify-center rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-sm font-semibold hover:bg-indigo-700 transition">+ New Quiz</a>
  </div>
  <div class="flex flex-col sm:flex-row gap-3 mb-4">
    <input x-model="search" @input.debounce.300ms="load()" type="text" placeholder="Search quizzes..." class="border border-slate-300 rounded-lg p-2.5 text-sm flex-1">
    <select x-model="status" @change="load()" class="border border-slate-300 rounded-lg p-2.5 text-sm sm:w-48">
      <option value="">All Status</option>
      <option value="draft">Draft</option>
      <option value="published">Published</option>
      <option value="archived">Archived</option>
    </select>
  </div>
  <div class="hidden md:block bg-white rounded-2xl border overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-50 text-slate-600">
        <tr>
          <th class="text-left p-3 font-semibold">Title</th>
          <th class="text-left p-3 font-semibold">Status</th>
          <th class="text-left p-3 font-semibold">Created</th>
          <th class="text-left p-3 font-semibold">Actions</th>
        </tr>
      </thead>
      <tbody class="divide-y">
        <template x-for="quiz in quizzes" :key="quiz.id">
          <tr class="hover:bg-slate-50">
            <td class="p-3 font-medium text-slate-900" x-text="quiz.title"></td>
            <td class="p-3"><span class="inline-flex px-2 py-1 rounded-full text-xs font-semibold" :class="statusClass(quiz.status)" x-text="quiz.status"></span></td>
            <td class="p-3 text-slate-500" x-text="quiz.created_at"></td>
            <td class="p-3">
              <div class="flex gap-3 items-center flex-wrap">
                <a :href="'/admin/quizzes/' + quiz.id + '/edit'" class="text-indigo-600 hover:underline font-medium">Edit</a>
                <a :href="'/admin/quizzes/' + quiz.id + '/leads.csv'" class="text-slate-600 hover:underline font-medium">Export</a>
                <button @click="duplicate(quiz)" class="text-emerald-600 hover:underline font-medium">Duplicate</button>
                <button @click="remove(quiz)" class="text-red-600 hover:underline font-medium">Delete</button>
              </div>
            </td>
          </tr>
        </template>
        <tr x-show="quizzes.length === 0"><td colspan="4" class="p-6 text-center text-slate-400">No quizzes found.</td></tr>
      </tbody>
    </table>
  </div>
  <div class="md:hidden space-y-3">
    <template x-for="quiz in quizzes" :key="quiz.id">
      <div class="bg-white rounded-2xl border p-4">
        <div class="flex items-start justify-between gap-2">
          <p class="font-semibold text-slate-900" x-text="quiz.title"></p>
          <span class="inline-flex px-2 py-1 rounded-full text-xs font-semibold shrink-0" :class="statusClass(quiz.status)" x-text="quiz.status"></span>
        </div>
        <p class="text-xs text-slate-400 mt-1" x-text="quiz.created_at"></p>
        <div class="mt-3 flex gap-4 text-sm flex-wrap">
          <a :href="'/admin/quizzes/' + quiz.id + '/edit'" class="text-indigo-600 font-medium">Edit</a>
          <a :href="'/admin/quizzes/' + quiz.id + '/leads.csv'" class="text-slate-600 font-medium">Export</a>
          <button @click="duplicate(quiz)" class="text-emerald-600 font-medium">Duplicate</button>
          <button @click="remove(quiz)" class="text-red-600 font-medium">Delete</button>
        </div>
      </div>
    </template>
    <div x-show="quizzes.length === 0" class="bg-white rounded-2xl border p-6 text-center text-slate-400">No quizzes found.</div>
  </div>
</main>
<script>
function quizList(){
  return {
    quizzes: [], search: '', status: '',
    statusClass(s){
      return { published: 'bg-green-100 text-green-700', draft: 'bg-amber-100 text-amber-700', archived: 'bg-slate-100 text-slate-600' }[s] || '';
    },
    async load(){
      const qs = new URLSearchParams({ search: this.search, status: this.status });
      const data = await apiFetch('/api/admin/quizzes/search?' + qs);
      this.quizzes = data.quizzes;
    },
    async duplicate(quiz){
      try { await apiFetch('/api/admin/quizzes/' + quiz.id + '/duplicate', { method: 'POST' }); showToast('Quiz duplicated.'); this.load(); }
      catch (e) { showToast(e.message, true); }
    },
    async remove(quiz){
      if (!confirm('Delete this quiz and all its data? This cannot be undone.')) return;
      try { await apiFetch('/api/admin/quizzes/' + quiz.id + '/delete', { method: 'POST' }); showToast('Quiz deleted.'); this.load(); }
      catch (e) { showToast(e.message, true); }
    }
  };
}
</script>`;
  return pageLayout({ title: 'Quizzes', csrf, body, currentUser });
}

function viewAdminQuizForm(quiz, isEdit, csrf, currentUser, appUrl) {
  const q = quiz || {};
  const templates = [
    ['default',  'Default (indigo / slate)'],
    ['romantic', 'Romantic (rose / pink)'],
    ['warm',     'Warm (amber / orange)'],
    ['minimal',  'Minimal (clean white)'],
    ['bold',     'Bold (black / accent)'],
  ];
  const textScales = [['sm','Small'],['md','Medium'],['lg','Large'],['xl','Extra large']];
  const imageSizes = [['sm','Small'],['md','Medium'],['lg','Large'],['xl','Extra large'],['full','Full width']];
  const opt = (list, current) => list.map(([v,l]) =>
    `<option value="${v}" ${current === v ? 'selected' : ''}>${l}</option>`).join('');
  const slugPreviewBase = String(appUrl || '').replace(/\/+$/, '');

  const body = `
<main class="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-bold text-slate-950">${isEdit ? 'Edit Quiz' : 'New Quiz'}</h2>
    <a href="/admin/quizzes" class="text-sm text-slate-500 hover:text-slate-800">&larr; Back to quizzes</a>
  </div>

  <form method="POST" action="/admin/quizzes/save" onsubmit="if (window.tinymce) { try { tinymce.triggerSave(); } catch(e){} }" class="bg-white rounded-2xl border p-5 sm:p-6 space-y-6">
    <input type="hidden" name="_csrf" value="${e(csrf)}">
    <input type="hidden" name="id" value="${isEdit ? q.id : ''}">

    <fieldset class="space-y-4">
      <legend class="font-semibold text-slate-900 mb-2">Basic info</legend>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label class="block text-sm font-medium text-slate-700">Title</label>
          <input name="title" required value="${e(q.title || '')}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div>
          <label class="block text-sm font-medium text-slate-700">Slug</label>
          <input id="quiz-slug-input" name="slug" value="${e(q.slug || '')}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
          <p class="mt-1.5 text-xs text-slate-500 flex items-center gap-2 flex-wrap">
            <span>Quiz URL:</span>
            <a id="quiz-url-preview" href="#" class="text-indigo-600 hover:underline font-mono break-all">(set a slug)</a>
            <button type="button" id="quiz-url-copy" class="text-indigo-600 hover:underline text-xs font-semibold shrink-0">Copy</button>
          </p>
        </div>
        <div class="sm:col-span-2"><label class="block text-sm font-medium text-slate-700">Subtitle</label>
          <input name="subtitle" value="${e(q.subtitle || '')}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div class="sm:col-span-2"><label class="block text-sm font-medium text-slate-700">Description</label>
          <textarea name="description" rows="3" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">${e(q.description || '')}</textarea></div>
      </div>
    </fieldset>

    <fieldset class="space-y-4 pt-6 border-t border-slate-200">
      <legend class="font-semibold text-slate-900 mb-2">Hero (the top of the landing page)</legend>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label class="block text-sm font-medium text-slate-700">Template</label>
          <select name="template" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
            ${opt(templates, q.template || 'default')}
          </select></div>
        <div><label class="block text-sm font-medium text-slate-700">Text scale</label>
          <select name="text_scale" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
            ${opt(textScales, q.text_scale || 'md')}
          </select></div>
        <div><label class="block text-sm font-medium text-slate-700">Hero image URL</label>
          <input name="hero_image" value="${e(q.hero_image || '')}" placeholder="https://..." class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div><label class="block text-sm font-medium text-slate-700">Hero image size</label>
          <select name="hero_image_size" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
            ${opt(imageSizes, q.hero_image_size || 'md')}
          </select></div>
        <div><label class="block text-sm font-medium text-slate-700">Brand name</label>
          <input name="brand_name" value="${e(q.brand_name || '')}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div><label class="block text-sm font-medium text-slate-700">Status</label>
          <select name="status" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
            ${['draft','published','archived'].map(s => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></div>
      </div>
    </fieldset>

    <fieldset class="pt-6 border-t border-slate-200">
      <legend class="font-semibold text-slate-900 mb-2">Landing page content</legend>
      <p class="text-xs text-slate-500 mb-3">Write the main content that appears below the hero. Use the toolbar to format text, add images, links, and lists. Place <code class="bg-slate-100 px-1 rounded">{button}</code> anywhere to render the real quiz CTA button, or click <strong>Insert CTA</strong> in the toolbar.</p>
      <textarea id="landing-content-editor" name="landing_content" class="w-full rounded-lg border border-slate-300 p-2.5 text-sm min-h-[300px]">${e(q.landing_content || '')}</textarea>
    </fieldset>

    <fieldset class="space-y-4 pt-6 border-t border-slate-200">
      <legend class="font-semibold text-slate-900 mb-2">Result page content</legend>
      <p class="text-xs text-slate-500 -mt-2">Everything shown after the visitor completes the quiz. Use <code class="bg-slate-100 px-1 rounded">{RESULT_LINK}</code> in the WhatsApp message to insert their result URL.</p>
      <div><label class="block text-sm font-medium text-slate-700">Result page title</label>
        <input name="result_title" value="${e(q._result_title || '')}" placeholder="Your Report Is Ready" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
      <div><label class="block text-sm font-medium text-slate-700">Result page description</label>
        <textarea name="result_description" rows="3" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">${e(q._result_description || '')}</textarea></div>
      <div><label class="block text-sm font-medium text-slate-700">Recommendations (multi-line)</label>
        <textarea name="result_recommendations" rows="6" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">${e(q._result_recommendations || '')}</textarea></div>
      <div><label class="block text-sm font-medium text-slate-700">CTA text (heading above the WhatsApp button)</label>
        <input name="result_cta_text" value="${e(q._result_cta_text || '')}" placeholder="Send My Result to WhatsApp" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
      <div><label class="block text-sm font-medium text-slate-700">WhatsApp message template</label>
        <textarea name="result_whatsapp_message" rows="3" placeholder="I just completed the quiz. Here is my result: {RESULT_LINK}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">${e(q._result_whatsapp_message || '')}</textarea></div>
    </fieldset>

    <fieldset class="space-y-4 pt-6 border-t border-slate-200">
      <legend class="font-semibold text-slate-900 mb-2">Calls to action</legend>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label class="block text-sm font-medium text-slate-700">Primary CTA (hero button)</label>
          <input name="primary_cta" value="${e(q.primary_cta || '')}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div><label class="block text-sm font-medium text-slate-700">Result CTA (after lead form)</label>
          <input name="result_cta" value="${e(q.result_cta || '')}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div><label class="block text-sm font-medium text-slate-700">WhatsApp CTA (result page hint)</label>
          <input name="whatsapp_cta" value="${e(q.whatsapp_cta || '')}" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
      </div>
    </fieldset>

    <fieldset class="space-y-4 pt-6 border-t border-slate-200">
      <legend class="font-semibold text-slate-900 mb-2">Instructions ("How it works")</legend>
      <textarea name="instructions" rows="3" class="w-full rounded-lg border border-slate-300 p-2.5 text-sm">${e(q.instructions || '')}</textarea>
    </fieldset>

    <div class="flex gap-2 pt-2 border-t border-slate-200">
      <button type="submit" class="rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-semibold hover:bg-indigo-700">Save</button>
      <a href="/admin/quizzes" class="rounded-lg bg-slate-100 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-200">Cancel</a>
    </div>
  </form>

  ${isEdit ? `
  <div x-data="questionBuilder(${q.id})" x-init="load()">
    <h3 class="text-lg font-bold text-slate-950 mb-3">Questions</h3>
    <div class="bg-white rounded-2xl border p-5 sm:p-6 space-y-4">
      <button @click="addQuestion()" class="inline-flex items-center rounded-lg bg-emerald-600 text-white px-4 py-2.5 text-sm font-semibold hover:bg-emerald-700 transition">Add Question</button>
      <div id="sortable-questions" class="space-y-2">
        <template x-for="(q, idx) in questions" :key="q.id">
          <div class="border rounded-xl p-4" :data-id="q.id">
            <div class="flex justify-between items-start gap-3">
              <div class="flex items-start gap-2 min-w-0">
                <span class="drag-handle cursor-move text-slate-400 select-none mt-0.5">☰</span>
                <span class="font-medium text-slate-900 break-words" x-text="(idx + 1) + '. ' + q.question_text"></span>
              </div>
              <div class="flex gap-2 text-sm shrink-0">
                <button @click="editQuestion(q)" class="text-indigo-600 hover:underline">Edit</button>
                <button @click="deleteQuestion(q)" class="text-red-600 hover:underline">Delete</button>
              </div>
            </div>
            <div class="mt-3 pl-6 space-y-1.5">
              <template x-for="opt in q.options" :key="opt.id">
                <div class="flex items-center gap-2 text-sm flex-wrap">
                  <span x-text="opt.option_text"></span>
                  <span class="text-xs text-slate-400" x-text="'(score: ' + opt.score_value + ')'"></span>
                  <button @click="editOption(q, opt)" class="text-indigo-500 text-xs hover:underline">edit</button>
                  <button @click="deleteOption(q, opt)" class="text-red-400 text-xs hover:underline">del</button>
                </div>
              </template>
              <button @click="addOption(q)" class="text-indigo-600 text-xs font-medium hover:underline">+ Add option</button>
            </div>
          </div>
        </template>
        <p x-show="questions.length === 0" class="text-sm text-slate-400 text-center py-6">No questions yet -- add one to begin.</p>
      </div>
    </div>

    <div x-show="questionModal.open" x-cloak class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" @click.self="questionModal.open = false">
      <div class="bg-white p-6 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <h3 class="text-lg font-semibold">Edit Question</h3>
        <div class="mt-4"><label class="block text-sm font-medium text-slate-700">Question Text</label>
          <input x-model="questionModal.form.question_text" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div class="mt-3"><label class="block text-sm font-medium text-slate-700">Explanation</label>
          <input x-model="questionModal.form.explanation" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div class="mt-3"><label class="block text-sm font-medium text-slate-700">Type</label>
          <select x-model="questionModal.form.type" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
            <template x-for="[value, label] in Object.entries(questionTypes)" :key="value">
              <option :value="value" x-text="label"></option>
            </template>
          </select></div>
        <div class="mt-3 flex gap-4">
          <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" x-model="questionModal.form.is_required"> Required</label>
          <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" x-model="questionModal.form.is_active"> Active</label>
        </div>
        <p x-show="questionModal.error" x-text="questionModal.error" class="mt-2 text-xs text-red-600"></p>
        <div class="mt-5 flex justify-end gap-2">
          <button @click="saveQuestion()" class="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold">Save</button>
          <button @click="questionModal.open = false" class="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold">Cancel</button>
        </div>
      </div>
    </div>

    <div x-show="optionModal.open" x-cloak class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" @click.self="optionModal.open = false">
      <div class="bg-white p-6 rounded-2xl max-w-lg w-full">
        <h3 class="text-lg font-semibold">Edit Option</h3>
        <div class="mt-4"><label class="block text-sm font-medium text-slate-700">Option Text</label>
          <input x-model="optionModal.form.option_text" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div class="mt-3"><label class="block text-sm font-medium text-slate-700">Score Value</label>
          <input type="number" x-model="optionModal.form.score_value" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <div class="mt-3"><label class="block text-sm font-medium text-slate-700">Category Weights (JSON)</label>
          <input x-model="optionModal.form.category_weights_json" placeholder='{"category":5}' class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"></div>
        <p x-show="optionModal.error" x-text="optionModal.error" class="mt-2 text-xs text-red-600"></p>
        <div class="mt-5 flex justify-end gap-2">
          <button @click="saveOption()" class="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold">Save</button>
          <button @click="optionModal.open = false" class="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold">Cancel</button>
        </div>
      </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
  <script>
  function questionBuilder(quizId){
    return {
      quizId,
      questions: [],
      questionTypes: { single_choice:'Single choice', multiple_choice:'Multiple choice', yes_no:'Yes / No', text:'Text', email:'Email', phone:'Phone', rating:'Rating (1-5)', number:'Number', dropdown:'Dropdown' },
      questionModal: { open:false, form:{}, error:'' },
      optionModal:   { open:false, form:{}, error:'' },
      sortable: null,
      async load(){
        const data = await apiFetch('/api/admin/quizzes/' + this.quizId + '/questions');
        this.questions = data.questions;
        this.\\$nextTick(() => this.initSortable());
      },
      initSortable(){
        const el = document.getElementById('sortable-questions');
        if (!el || this.sortable) return;
        this.sortable = Sortable.create(el, {
          handle: '.drag-handle',
          onEnd: async () => {
            const ids = Array.from(el.children).map(c => c.dataset.id).filter(Boolean);
            try { await apiFetch('/api/admin/quizzes/' + this.quizId + '/questions/reorder', { method:'POST', body:{ ids } }); }
            catch(e){ showToast(e.message, true); this.load(); }
          }
        });
      },
      addQuestion(){
        this.questionModal = { open:true, error:'', form:{ id:null, question_text:'', explanation:'', type:'single_choice', is_required:true, is_active:true } };
      },
      editQuestion(q){
        this.questionModal = { open:true, error:'', form:{ id:q.id, question_text:q.question_text, explanation:q.explanation||'', type:q.type, is_required:!!q.is_required, is_active:!!q.is_active } };
      },
      async saveQuestion(){
        this.questionModal.error = '';
        if (!this.questionModal.form.question_text.trim()) { this.questionModal.error = 'Question text is required.'; return; }
        try {
          await apiFetch('/api/admin/questions/save', { method:'POST', body:{ ...this.questionModal.form, quiz_id:this.quizId } });
          this.questionModal.open = false;
          await this.load();
        } catch (e) { this.questionModal.error = e.message; }
      },
      async deleteQuestion(q){
        if (!confirm('Delete this question and its options?')) return;
        try { await apiFetch('/api/admin/questions/' + q.id + '/delete', { method:'POST' }); await this.load(); }
        catch (e) { showToast(e.message, true); }
      },
      addOption(q){
        this.optionModal = { open:true, error:'', form:{ id:null, question_id:q.id, option_text:'', score_value:0, category_weights_json:'' } };
      },
      editOption(q, opt){
        this.optionModal = { open:true, error:'', form:{
          id:opt.id, question_id:q.id, option_text:opt.option_text, score_value:opt.score_value,
          category_weights_json: opt.category_weights && Object.keys(opt.category_weights).length ? JSON.stringify(opt.category_weights) : ''
        } };
      },
      async saveOption(){
        this.optionModal.error = '';
        if (!this.optionModal.form.option_text.trim()) { this.optionModal.error = 'Option text is required.'; return; }
        if (this.optionModal.form.category_weights_json.trim()) {
          try { JSON.parse(this.optionModal.form.category_weights_json); }
          catch (e) { this.optionModal.error = 'Category weights must be valid JSON.'; return; }
        }
        try {
          await apiFetch('/api/admin/options/save', { method:'POST', body:this.optionModal.form });
          this.optionModal.open = false;
          await this.load();
        } catch (e) { this.optionModal.error = e.message; }
      },
      async deleteOption(q, opt){
        if (!confirm('Delete this option?')) return;
        try { await apiFetch('/api/admin/options/' + opt.id + '/delete', { method:'POST' }); await this.load(); }
        catch (e) { showToast(e.message, true); }
      }
    };
  }
  </script>
  ` : `<p class="text-sm text-slate-500">Save the quiz first to start adding questions.</p>`}

  <script src="https://cdn.jsdelivr.net/npm/tinymce@6.8.3/tinymce.min.js" referrerpolicy="origin"></script>
  <script>
  (function() {
    var baseUrl = ${JSON.stringify(slugPreviewBase)};
    var input = document.getElementById('quiz-slug-input');
    var preview = document.getElementById('quiz-url-preview');
    var copyBtn = document.getElementById('quiz-url-copy');

    function slugify(s) {
      return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    function updatePreview() {
      if (!input || !preview) return;
      var raw = input.value.trim();
      var slug = raw ? slugify(raw) : '';
      var url = slug ? (baseUrl + '/q/' + slug) : '(set a slug to generate the URL)';
      preview.textContent = url;
      if (slug) { preview.href = url; } else { preview.removeAttribute('href'); }
    }
    if (input && preview) {
      input.addEventListener('input', updatePreview);
      input.addEventListener('change', updatePreview);
      updatePreview();
    }
    if (copyBtn && preview) {
      copyBtn.addEventListener('click', function() {
        if (!preview.href) return;
        navigator.clipboard.writeText(preview.textContent).then(function() {
          var old = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(function() { copyBtn.textContent = old; }, 1500);
        }).catch(function() {});
      });
    }

    function initEditor() {
      if (!window.tinymce) return;
      try {
        tinymce.init({
          selector: '#landing-content-editor',
          base_url: 'https://cdn.jsdelivr.net/npm/tinymce@6.8.3',
          suffix: '.min',
          height: 520,
          menubar: false,
          branding: false,
          promotion: false,
          plugins: 'lists link image code table hr anchor searchreplace wordcount visualblocks visualchars charmap insertdatetime media nonbreaking directionality',
          toolbar: 'undo redo | blocks | bold italic underline strikethrough | forecolor backcolor removeformat | alignleft aligncenter alignright alignjustify | bullist numlist outdent indent | blockquote hr | link image | insertcta | code',
          block_formats: 'Paragraph=p; Heading 1=h1; Heading 2=h2; Heading 3=h3; Heading 4=h4; Heading 5=h5; Heading 6=h6',
          valid_elements: '*[*]',
          extended_valid_elements: 'img[src|alt|title|width|height|style|class|data-*]',
          setup: function(editor) {
            editor.ui.registry.addButton('insertcta', {
              text: 'Insert CTA',
              tooltip: 'Insert the quiz CTA button ({button})',
              onAction: function() { editor.insertContent('{button}'); }
            });
          }
        });
      } catch (err) {
        console.error('TinyMCE init failed, falling back to plain textarea.', err);
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initEditor);
    } else {
      initEditor();
    }
  })();
  </script>
</main>`;
  return pageLayout({ title: isEdit ? 'Edit Quiz' : 'New Quiz', csrf, body, currentUser });
}

function viewAdminLeads(leads, quizzes, selectedQuizId, searchQuery, csrf, currentUser) {
  const rows = leads.map(l => {
    const wa = whatsappLink(l.phone);
    return `<tr class="hover:bg-slate-50">
      <td class="p-3 font-medium text-slate-900">${e(l.first_name || '—')}</td>
      <td class="p-3">${l.email ? `<a href="mailto:${e(l.email)}" class="text-indigo-600 hover:underline">${e(l.email)}</a>` : '<span class="text-slate-400">—</span>'}</td>
      <td class="p-3">${l.phone ? (wa ? `<a href="${e(wa)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-emerald-600 hover:underline font-medium">💬 ${e(l.phone)}</a>` : `<span>${e(l.phone)}</span>`) : '<span class="text-slate-400">—</span>'}</td>
      <td class="p-3 text-slate-500">${e(l.quiz_title || '')}</td>
      <td class="p-3"><span class="inline-flex px-2 py-1 rounded-full text-xs font-semibold ${l.last_status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}">${e(l.last_status || 'started')}</span></td>
      <td class="p-3 text-xs text-slate-400">${e(l.created_at || '')}</td>
    </tr>`;
  }).join('');

  const quizOptions = quizzes.map(q =>
    `<option value="${q.id}" ${selectedQuizId === q.id ? 'selected' : ''}>${e(q.title)}</option>`).join('');

  const body = `
<main class="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
  <div>
    <h2 class="text-xl font-bold text-slate-950">Leads directory</h2>
    <p class="text-sm text-slate-500 mt-1">Every lead captured across all quizzes. Click the WhatsApp number to open a direct chat, or the email to open your mail client.</p>
  </div>

  <form method="GET" action="/admin/leads" class="bg-white rounded-2xl border p-4 flex flex-col sm:flex-row gap-3">
    <select name="quiz_id" class="rounded-lg border border-slate-300 p-2.5 text-sm sm:w-64">
      <option value="">All quizzes</option>
      ${quizOptions}
    </select>
    <input name="q" value="${e(searchQuery || '')}" placeholder="Search name, email, phone..." class="flex-1 rounded-lg border border-slate-300 p-2.5 text-sm">
    <button class="rounded-lg bg-slate-900 text-white px-4 py-2.5 text-sm font-semibold hover:bg-slate-800">Filter</button>
    <a href="/admin/leads" class="rounded-lg bg-slate-100 text-slate-700 px-4 py-2.5 text-sm font-semibold hover:bg-slate-200 text-center">Reset</a>
  </form>

  <div class="bg-white rounded-2xl border overflow-hidden">
    <div class="px-4 sm:px-5 py-3 border-b flex items-center justify-between">
      <p class="text-sm font-semibold text-slate-900">${leads.length} lead${leads.length === 1 ? '' : 's'}</p>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-slate-600">
          <tr>
            <th class="text-left p-3 font-semibold">Name</th>
            <th class="text-left p-3 font-semibold">Email</th>
            <th class="text-left p-3 font-semibold">WhatsApp</th>
            <th class="text-left p-3 font-semibold">Quiz</th>
            <th class="text-left p-3 font-semibold">Status</th>
            <th class="text-left p-3 font-semibold">Captured</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          ${rows || `<tr><td colspan="6" class="p-6 text-center text-slate-400">No leads match this filter.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
</main>`;
  return pageLayout({ title: 'Leads', csrf, body, currentUser });
}

async function handleAdminLeadsPage(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return redirectResponse('/admin/login');
  const url = new URL(request.url);
  const quizIdParam = url.searchParams.get('quiz_id') || '';
  const search = (url.searchParams.get('q') || '').trim();
  const quizId = quizIdParam ? parseInt(quizIdParam, 10) : null;

  let sql = `SELECT l.id, l.first_name, l.email, l.phone, l.created_at,
                    q.title AS quiz_title, q.id AS quiz_id,
                    (SELECT completion_status FROM quiz_attempts qa
                     WHERE qa.lead_id = l.id AND qa.quiz_id = l.quiz_id
                     ORDER BY qa.id DESC LIMIT 1) AS last_status
             FROM leads l JOIN quizzes q ON q.id = l.quiz_id WHERE 1=1`;
  const binds = [];
  if (quizId) { sql += ' AND l.quiz_id = ?'; binds.push(quizId); }
  if (search) {
    sql += ' AND (l.first_name LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)';
    const like = '%' + search + '%';
    binds.push(like, like, like);
  }
  sql += ' ORDER BY l.created_at DESC LIMIT 500';

  const res = await env.DB.prepare(sql).bind(...binds).all();
  const leads = res.results || [];

  const quizzesRes = await env.DB.prepare('SELECT id, title FROM quizzes ORDER BY title ASC').all();
  const quizzes = quizzesRes.results || [];

  return htmlResponse(viewAdminLeads(leads, quizzes, quizId, search, ctx.session.csrf, user));
}

function viewAdminSettings(csrf, currentUser) {
  const body = `
<main class="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6" x-data="settingsPage()" x-init="load()">
  <div>
    <h2 class="text-xl font-bold text-slate-950">Settings</h2>
    <p class="text-sm text-slate-500 mt-1">Configure WhatsApp, tracking pixels, and outbound webhooks.</p>
  </div>
  <div class="bg-white rounded-2xl border p-5 sm:p-6 space-y-4">
    <h3 class="font-semibold text-slate-900">Funnel &amp; tracking</h3>
    <div class="grid sm:grid-cols-2 gap-4">
      <div>
        <label class="block text-sm font-medium text-slate-700">WhatsApp number</label>
        <input x-model="settings.whatsapp_number" placeholder="15551234567" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
        <p class="mt-1 text-xs text-slate-400">Digits only, with country code.</p>
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">Meta Pixel ID</label>
        <input x-model="settings.meta_pixel_id" placeholder="123456789012345" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div class="sm:col-span-2">
        <label class="block text-sm font-medium text-slate-700">Default WhatsApp message</label>
        <input x-model="settings.whatsapp_default_message" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">Google Analytics ID</label>
        <input x-model="settings.google_analytics_id" placeholder="G-XXXXXXXXXX" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div class="flex items-end">
        <button @click="saveSettings()" class="rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-sm font-semibold hover:bg-indigo-700">Save settings</button>
      </div>
    </div>
    <p x-show="settingsError" x-text="settingsError" class="text-xs text-red-600"></p>
  </div>

  <div class="bg-white rounded-2xl border p-5 sm:p-6 space-y-4">
    <h3 class="font-semibold text-slate-900">Webhooks</h3>
    <p class="text-sm text-slate-500">Fires a POST request to your URL when an event happens. URL must be a public <code class="bg-slate-100 px-1 rounded">https://</code> address.</p>
    <div class="space-y-2">
      <template x-for="webhook in webhooks" :key="webhook.id">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border p-3">
          <div class="min-w-0">
            <p class="text-sm font-medium truncate" x-text="webhook.url"></p>
            <p class="text-xs text-slate-500" x-text="webhook.events.join(', ')"></p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span class="text-xs font-semibold px-2 py-1 rounded-full" :class="webhook.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'" x-text="webhook.is_active ? 'Active' : 'Paused'"></span>
            <button @click="toggleWebhook(webhook)" class="text-xs font-medium text-indigo-600 hover:underline">Toggle</button>
            <button @click="deleteWebhook(webhook)" class="text-xs font-medium text-red-600 hover:underline">Delete</button>
          </div>
        </div>
      </template>
      <p x-show="webhooks.length === 0" class="text-xs text-slate-400">No webhooks configured yet.</p>
    </div>
    <div class="pt-3 border-t space-y-3">
      <div>
        <label class="block text-sm font-medium text-slate-700">Endpoint URL</label>
        <input x-model="newWebhook.url" placeholder="https://example.com/webhooks/quiz" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm">
      </div>
      <div>
        <label class="block text-sm font-medium text-slate-700">Events</label>
        <label class="mt-1 inline-flex items-center gap-2 text-sm">
          <input type="checkbox" value="quiz.completed" x-model="newWebhook.events" class="rounded border-slate-300 text-indigo-600"> quiz.completed
        </label>
      </div>
      <p x-show="webhookError" x-text="webhookError" class="text-xs text-red-600"></p>
      <button @click="addWebhook()" class="rounded-lg bg-slate-900 text-white px-4 py-2.5 text-sm font-semibold hover:bg-slate-800">Add webhook</button>
    </div>
  </div>
</main>
<script>
function settingsPage(){
  return {
    settings: { whatsapp_number:'', whatsapp_default_message:'', meta_pixel_id:'', google_analytics_id:'' },
    settingsError: '',
    webhooks: [],
    newWebhook: { url:'', events:[] },
    webhookError: '',
    async load(){
      const data = await apiFetch('/api/admin/settings-data');
      this.settings = data.settings;
      this.webhooks = data.webhooks;
    },
    async saveSettings(){
      this.settingsError = '';
      try { await apiFetch('/api/admin/settings/save', { method:'POST', body:this.settings }); showToast('Settings saved.'); }
      catch (e) { this.settingsError = e.message; }
    },
    async addWebhook(){
      this.webhookError = '';
      try {
        await apiFetch('/api/admin/webhooks/add', { method:'POST', body:this.newWebhook });
        this.newWebhook = { url:'', events:[] };
        await this.load();
        showToast('Webhook added.');
      } catch (e) { this.webhookError = e.message; }
    },
    async toggleWebhook(webhook){
      await apiFetch('/api/admin/webhooks/' + webhook.id + '/toggle', { method:'POST' });
      this.load();
    },
    async deleteWebhook(webhook){
      if (!confirm('Delete this webhook?')) return;
      await apiFetch('/api/admin/webhooks/' + webhook.id + '/delete', { method:'POST' });
      this.load();
    }
  };
}
</script>`;
  return pageLayout({ title: 'Settings', csrf, body, currentUser });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleHome(request, env, ctx) {
  const session = ctx.session;
  if (session && session.userId) {
    const u = await current_user(request, env, session);
    if (u && u.is_admin) return redirectResponse('/admin');
  }
  return htmlResponse(viewHome(env));
}

async function handleQuizLanding(request, env, ctx, params) {
  const quiz = await quiz_find_published_by_slug(env, params.slug);
  if (!quiz) return htmlResponse(view404(env, ctx.session.csrf, await current_user(request, env, ctx.session)), 404);
  return htmlResponse(viewQuizLanding(quiz, ctx.session.csrf));
}

async function handleQuizResult(request, env, ctx, params) {
  const attempt = await attempt_find_by_attempt_id(env, params.attemptId);
  if (!attempt) return htmlResponse(view404(env, ctx.session.csrf, await current_user(request, env, ctx.session)), 404);
  if (attempt.completion_status !== 'completed') {
    const quiz = await quiz_find(env, attempt.quiz_id);
    if (quiz) return redirectResponse('/q/' + quiz.slug);
    return htmlResponse(view404(env, ctx.session.csrf, await current_user(request, env, ctx.session)), 404);
  }
  const lead = await lead_find(env, attempt.lead_id);
  const profile = attempt.result_profile_id ? await result_profile_find(env, attempt.result_profile_id) : null;
  const whatsappNumber = await setting_get(env, 'whatsapp_number', '');
  const resultUrl = (env.APP_URL || '') + '/result/' + attempt.attempt_id;
  const isOwner = ctx.session.resultOwners && ctx.session.resultOwners[attempt.attempt_id];
  return htmlResponse(viewQuizResult({
    attempt, lead, profile, whatsappNumber, resultUrl, isOwner, csrf: ctx.session.csrf,
  }));
}

async function handleLead(request, env, ctx, params) {
  const quiz = await quiz_find_published_by_slug(env, params.slug);
  if (!quiz) return jsonResponse({ message: 'Not found.' }, 404);
  const ip = client_ip(request);
  if (await ip_lead_rate_limited(env, ip)) {
    return jsonResponse({ message: 'Too many attempts. Please try again in a minute.' }, 429);
  }
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const firstName = String(body.first_name || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  const errors = [];
  if (!firstName || firstName.length > 255) errors.push('First name is required.');
  if (!phone || phone.length > 30 || !/^[0-9+\-\s()]+$/.test(phone)) errors.push('A valid phone number is required.');
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255)) errors.push('That email address looks invalid.');
  if (errors.length) return jsonResponse({ message: errors.join(' ') }, 422);
  const result = await lead_capture_start(env, quiz, {
    first_name: firstName,
    phone,
    email: email || null,
    utm_source: body.utm_source || null,
    utm_medium: body.utm_medium || null,
    utm_campaign: body.utm_campaign || null,
    referrer: body.referrer || null,
    ip_address: ip,
  });
  return jsonResponse({ attempt_id: result.attempt.attempt_id });
}

async function handleQuestions(request, env, ctx, params) {
  const quiz = await quiz_find_published_by_slug(env, params.slug);
  if (!quiz) return jsonResponse({ message: 'Not found.' }, 404);
  const questions = await question_with_options_for_quiz(env, quiz.id, true);
  const safe = questions.map(q => ({
    id: q.id,
    type: q.type,
    question_text: q.question_text,
    explanation: q.explanation,
    is_required: !!q.is_required,
    options: (q.options || []).map(o => ({ id: o.id, option_text: o.option_text })),
  }));
  return jsonResponse({ questions: safe });
}

async function handleAutosave(request, env, ctx, params) {
  const attempt = await attempt_find_by_attempt_id(env, params.attemptId);
  if (!attempt) return jsonResponse({ message: 'Not found.' }, 404);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const answers = body && typeof body.answers === 'object' && body.answers ? body.answers : null;
  const idx = Number.isInteger(body.current_question_index) ? body.current_question_index : null;
  if (!answers || idx === null || idx < 0) return jsonResponse({ message: 'Invalid payload.' }, 422);
  const validQuestions = await question_all_for_quiz(env, attempt.quiz_id, false);
  const validIds = new Set(validQuestions.map(q => String(q.id)));
  const filtered = {};
  for (const [k, v] of Object.entries(answers)) {
    if (validIds.has(String(k))) filtered[k] = v;
  }
  for (const v of Object.values(filtered)) {
    if (JSON.stringify(v).length > 5000) return jsonResponse({ message: 'One of your answers is too long.' }, 422);
  }
  await attempt_save_answers(env, attempt.attempt_id, filtered, idx);
  await event_log(env, 'question_answered', attempt.quiz_id, attempt.attempt_id);
  return jsonResponse({ status: 'saved' });
}

async function handleSubmit(request, env, ctx, params) {
  const attempt = await attempt_find_by_attempt_id(env, params.attemptId);
  if (!attempt) return jsonResponse({ message: 'Not found.' }, 404);
  if (attempt.completion_status === 'completed') {
    return jsonResponse({ result_url: (env.APP_URL || '') + '/result/' + attempt.attempt_id });
  }
  const profiles = await result_profile_all_for_quiz(env, attempt.quiz_id);
  const profile = profiles[0] || null;
  await attempt_mark_completed(env, attempt.attempt_id, 0, null, profile ? profile.id : null);
  ctx.session.resultOwners = ctx.session.resultOwners || {};
  ctx.session.resultOwners[attempt.attempt_id] = true;
  await event_log(env, 'quiz_complete', attempt.quiz_id, attempt.attempt_id);
  const lead = await lead_find(env, attempt.lead_id);
  const quiz = await quiz_find(env, attempt.quiz_id);
  await webhook_dispatch_event(env, 'quiz.completed', {
    attempt_id: attempt.attempt_id,
    score: null,
    category: null,
    lead: lead ? { first_name: lead.first_name, email: lead.email, phone: lead.phone } : null,
    quiz: quiz ? { title: quiz.title, slug: quiz.slug } : null,
  });
  return jsonResponse({ result_url: (env.APP_URL || '') + '/result/' + attempt.attempt_id });
}

async function handleWhatsappClick(request, env, ctx) {
  let body; try { body = await request.json(); } catch { body = {}; }
  const attemptId = String(body.attempt_id || '');
  const attempt = attemptId ? await attempt_find_by_attempt_id(env, attemptId) : null;
  if (!attempt) return jsonResponse({ message: 'Not found.' }, 404);
  await event_log(env, 'whatsapp_click', attempt.quiz_id, attemptId);
  return jsonResponse({ status: 'recorded' });
}

async function handleShare(request, env, ctx) {
  let body; try { body = await request.json(); } catch { body = {}; }
  const attemptId = String(body.attempt_id || '');
  const platform = String(body.platform || '');
  const attempt = attemptId ? await attempt_find_by_attempt_id(env, attemptId) : null;
  if (!attempt) return jsonResponse({ message: 'Not found.' }, 404);
  if (!['copy','whatsapp','facebook','twitter','linkedin'].includes(platform)) {
    return jsonResponse({ message: 'Invalid platform.' }, 422);
  }
  await share_event_create(env, attemptId, platform);
  return jsonResponse({ status: 'recorded' });
}

// -- admin auth --
async function handleAdminLoginGet(request, env, ctx) {
  const session = ctx.session;
  if (session && session.userId) {
    const u = await current_user(request, env, session);
    if (u && u.is_admin) return redirectResponse('/admin');
  }
  const needSetup = (await user_count(env)) === 0;
  return htmlResponse(viewAdminLogin(session.csrf, '', needSetup));
}

async function handleAdminLoginPost(request, env, ctx) {
  const form = await request.formData();
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  const user = await user_find_by_email(env, email);
  if (!user || !(await verifyPassword(password, user.password))) {
    return htmlResponse(viewAdminLogin(ctx.session.csrf, 'Invalid email or password.', false), 401);
  }
  if (!user.is_admin) {
    return htmlResponse(viewAdminLogin(ctx.session.csrf, 'That account does not have admin access.', false), 403);
  }
  ctx.session.userId = user.id;
  ctx.session.csrf = randomHex(32);
  ctx.session.exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const res = htmlResponse('', 302);
  res.headers.set('Location', '/admin');
  return res;
}

async function handleAdminLogout(request, env, ctx) {
  ctx.session.userId = null;
  ctx.session.exp = 0;
  const res = htmlResponse('', 302);
  res.headers.set('Location', '/admin/login');
  return res;
}

async function handleSetupGet(request, env, ctx) {
  if ((await user_count(env)) > 0) return redirectResponse('/admin/login');
  return htmlResponse(viewSetup(ctx.session.csrf, ''));
}

async function handleSetupPost(request, env, ctx) {
  if ((await user_count(env)) > 0) return redirectResponse('/admin/login');
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');
  if (!name || !email || password.length < 8) {
    return htmlResponse(viewSetup(ctx.session.csrf, 'All fields are required; password must be at least 8 characters.'), 422);
  }
  await user_create_admin(env, name, email, password);
  return redirectResponse('/admin/login');
}

// -- admin pages --
async function handleAdminDashboard(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return redirectResponse('/admin/login');
  const stats = await quiz_stats(env);
  const recent = await quiz_recent_submissions(env, 10);
  const chartData = await quiz_completions_last_7_days(env);
  return htmlResponse(viewAdminDashboard(stats, recent, chartData, ctx.session.csrf, user));
}


async function handleAdminQuizzesList(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return redirectResponse('/admin/login');
  return htmlResponse(viewAdminQuizzesList(ctx.session.csrf, user));
}
async function handleAdminQuizForm(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return redirectResponse('/admin/login');
  let quiz = null, isEdit = false;
  if (params && params.id) {
    quiz = await quiz_find(env, parseInt(params.id, 10));
    if (!quiz) return htmlResponse(view404(env, ctx.session.csrf, user), 404);
    isEdit = true;

    // Legacy migration: if landing_content is empty but sections has blocks, convert.
    if (!quiz.landing_content && quiz.sections) {
      quiz.landing_content = legacyBlocksToHtml(quiz.sections);
    }

    const profile = await env.DB.prepare(
      'SELECT * FROM result_profiles WHERE quiz_id = ? ORDER BY id ASC LIMIT 1'
    ).bind(quiz.id).first();
    if (profile) {
      quiz._result_title = profile.title || '';
      quiz._result_description = profile.description || '';
      quiz._result_recommendations = profile.recommendations || '';
      quiz._result_cta_text = profile.cta_text || '';
      quiz._result_whatsapp_message = profile.whatsapp_message || '';
    }
  }
  return htmlResponse(viewAdminQuizForm(quiz, isEdit, ctx.session.csrf, user, env.APP_URL || ''));
}

async function handleAdminQuizSave(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return redirectResponse('/admin/login');
  const form = await request.formData();
  const id = form.get('id') ? parseInt(form.get('id'), 10) : null;
  const existing = id ? await quiz_find(env, id) : null;
  const title = String(form.get('title') || '').trim();
  const slugInput = String(form.get('slug') || '').trim();
  let status = String(form.get('status') || 'draft');
  if (!title || title.length > 255) return redirectResponse(id ? '/admin/quizzes/' + id + '/edit' : '/admin/quizzes/create');
  if (!['draft','published','archived'].includes(status)) status = 'draft';
  let slug = slugInput ? slugify(slugInput) : slugify(title);
  if (await quiz_slug_taken(env, slug, id)) slug = slug + '-' + randomHex(2);

  const template = String(form.get('template') || 'default');
  const validTemplates = ['default','romantic','warm','minimal','bold'];
  const text_scale = String(form.get('text_scale') || 'md');
  const validScales = ['sm','md','lg','xl'];
  const hero_image_size = String(form.get('hero_image_size') || 'md');
  const validImageSizes = ['sm','md','lg','xl','full'];

  // Sanitize the rich-text landing content before storing it.
  const landingContentRaw = String(form.get('landing_content') || '').trim();
  let landingContentValue = null;
  if (landingContentRaw) {
    landingContentValue = await sanitizeHtml(landingContentRaw);
  }

  const data = {
    title,
    subtitle: String(form.get('subtitle') || '') || null,
    description: String(form.get('description') || '') || null,
    instructions: String(form.get('instructions') || '') || null,
    cover_image: existing ? existing.cover_image : null,
    logo: existing ? existing.logo : null,
    brand_name: String(form.get('brand_name') || '') || null,
    primary_cta: String(form.get('primary_cta') || '') || null,
    result_cta: String(form.get('result_cta') || '') || null,
    whatsapp_cta: String(form.get('whatsapp_cta') || '') || null,
    status, slug,
    template: validTemplates.includes(template) ? template : 'default',
    hero_image: String(form.get('hero_image') || '') || null,
    hero_image_size: validImageSizes.includes(hero_image_size) ? hero_image_size : 'md',
    text_scale: validScales.includes(text_scale) ? text_scale : 'md',
    accent_color: existing ? existing.accent_color : null,
    about_me_title: existing ? existing.about_me_title : null,
    about_me_text: existing ? existing.about_me_text : null,
    about_me_image: existing ? existing.about_me_image : null,
    about_me_image_size: existing ? existing.about_me_image_size : 'md',
    landing_content: landingContentValue,
  };

  let savedId;
  if (id && existing) {
    await quiz_update(env, id, data);
    savedId = id;
  } else {
    savedId = await quiz_create(env, data);
  }

  // Result profile (unchanged behaviour)
  const existingProfile = await env.DB.prepare(
    'SELECT * FROM result_profiles WHERE quiz_id = ? ORDER BY id ASC LIMIT 1'
  ).bind(savedId).first();

  const profileTitle = String(form.get('result_title') || '').trim();
  const profileDescription = String(form.get('result_description') || '').trim();
  const profileRecommendations = String(form.get('result_recommendations') || '').trim();
  const profileCtaText = String(form.get('result_cta_text') || '').trim();
  const profileWhatsapp = String(form.get('result_whatsapp_message') || '').trim();

  if (existingProfile) {
    await env.DB.prepare(
      `UPDATE result_profiles SET title=?, description=?, recommendations=?, cta_text=?, whatsapp_message=?, updated_at=datetime('now') WHERE id=?`
    ).bind(
      profileTitle || existingProfile.title,
      profileDescription || existingProfile.description || 'Your result is ready.',
      profileRecommendations || null,
      profileCtaText || null,
      profileWhatsapp || null,
      existingProfile.id
    ).run();
  } else if (profileTitle || profileDescription) {
    await result_profile_create(env, {
      quiz_id: savedId,
      title: profileTitle || 'Your result',
      description: profileDescription || 'Your result is ready.',
      recommendations: profileRecommendations || null,
      cta_text: profileCtaText || null,
      whatsapp_message: profileWhatsapp || null,
      is_active: 1,
    });
  }

  return redirectResponse('/admin/quizzes/' + savedId + '/edit');
}

async function handleAdminLeadsExport(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return redirectResponse('/admin/login');
  const quiz = await quiz_find(env, parseInt(params.id, 10));
  if (!quiz) return new Response('Not found.', { status: 404 });
  const res = await env.DB.prepare(
    `SELECT l.first_name, l.email, l.phone, l.utm_source, l.utm_medium, l.utm_campaign,
            l.created_at, qa.score_total, qa.result_category, qa.completion_status, qa.completed_at
     FROM leads l LEFT JOIN quiz_attempts qa ON qa.lead_id = l.id AND qa.quiz_id = l.quiz_id
     WHERE l.quiz_id = ? ORDER BY l.created_at DESC`
  ).bind(quiz.id).all();
  const rows = res.results || [];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = ['First name','Email','Phone','UTM Source','UTM Medium','UTM Campaign','Captured At','Score','Result Category','Status','Completed At'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.first_name, r.email, r.phone, r.utm_source, r.utm_medium, r.utm_campaign,
      r.created_at, r.score_total, r.result_category, r.completion_status, r.completed_at,
    ].map(esc).join(','));
  }
  const filename = (quiz.slug || 'leads').replace(/[^a-z0-9\-]/gi, '-').toLowerCase() + '-leads.csv';
  return textResponse(lines.join('\r\n'), 'text/csv; charset=utf-8', 200, {
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

async function handleAdminSettingsPage(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return redirectResponse('/admin/login');
  return htmlResponse(viewAdminSettings(ctx.session.csrf, user));
}

// -- admin API --
async function handleAdminQuizzesSearch(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  const url = new URL(request.url);
  const search = url.searchParams.get('search') || '';
  const status = url.searchParams.get('status') || '';
  const rows = await quiz_search(env, search, status, 100, 0);
  return jsonResponse({ quizzes: rows });
}

async function handleAdminSettingsData(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  return jsonResponse({
    settings: {
      whatsapp_number: await setting_get(env, 'whatsapp_number', ''),
      whatsapp_default_message: await setting_get(env, 'whatsapp_default_message', ''),
      meta_pixel_id: await setting_get(env, 'meta_pixel_id', ''),
      google_analytics_id: await setting_get(env, 'google_analytics_id', ''),
    },
    webhooks: await webhook_all(env),
  });
}

async function handleAdminSettingsSave(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  let body; try { body = await request.json(); } catch { body = {}; }
  const wa = String(body.whatsapp_number || '').trim();
  if (wa && !/^[0-9]{6,15}$/.test(wa)) return jsonResponse({ message: 'WhatsApp number must be digits only (6-15 digits).' }, 422);
  const pixel = String(body.meta_pixel_id || '').trim();
  if (pixel && !/^[0-9]{1,20}$/.test(pixel)) return jsonResponse({ message: 'Meta Pixel ID must be numeric.' }, 422);
  const msg = String(body.whatsapp_default_message || '').trim();
  if (msg.length > 500) return jsonResponse({ message: 'Default message is too long.' }, 422);
  const ga = String(body.google_analytics_id || '').trim();
  if (ga.length > 50) return jsonResponse({ message: 'Google Analytics ID is too long.' }, 422);
  await setting_set(env, 'whatsapp_number', wa || null);
  await setting_set(env, 'meta_pixel_id', pixel || null);
  await setting_set(env, 'whatsapp_default_message', msg || null);
  await setting_set(env, 'google_analytics_id', ga || null);
  return jsonResponse({ status: 'saved' });
}

async function handleAdminQuizDuplicate(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  const id = parseInt(params.id, 10);
  const quiz = await quiz_find(env, id);
  if (!quiz) return jsonResponse({ message: 'Not found.' }, 404);
  const newId = await quiz_duplicate(env, id);
  return jsonResponse({ id: newId });
}

async function handleAdminQuizDelete(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  const id = parseInt(params.id, 10);
  const quiz = await quiz_find(env, id);
  if (!quiz) return jsonResponse({ message: 'Not found.' }, 404);
  await quiz_delete(env, id);
  return jsonResponse({ status: 'deleted' });
}

async function handleAdminQuestionsList(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  const quiz = await quiz_find(env, parseInt(params.id, 10));
  if (!quiz) return jsonResponse({ message: 'Not found.' }, 404);
  const questions = await question_with_options_for_quiz(env, quiz.id, false);
  return jsonResponse({ questions });
}

async function handleAdminQuestionSave(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  let body; try { body = await request.json(); } catch { body = {}; }
  const quizId = parseInt(body.quiz_id, 10);
  const quiz = await quiz_find(env, quizId);
  if (!quiz) return jsonResponse({ message: 'Quiz not found.' }, 404);
  const validTypes = ['single_choice','multiple_choice','yes_no','text','email','phone','rating','number','dropdown'];
  const type = String(body.type || '');
  const questionText = String(body.question_text || '').trim();
  if (!questionText || questionText.length > 2000) return jsonResponse({ message: 'Question text is required (max 2000 characters).' }, 422);
  if (!validTypes.includes(type)) return jsonResponse({ message: 'Invalid question type.' }, 422);
  const data = {
    quiz_id: quizId,
    type,
    question_text: questionText,
    explanation: String(body.explanation || '').trim() || null,
    is_required: !!body.is_required,
    is_active: !!body.is_active,
    order: await question_next_order(env, quizId),
  };
  const id = body.id ? parseInt(body.id, 10) : null;
  if (id) {
    const existing = await question_find_in_quiz(env, id, quizId);
    if (!existing) return jsonResponse({ message: 'Question not found in this quiz.' }, 404);
    await question_update(env, id, data);
    return jsonResponse({ id });
  }
  const newId = await question_create(env, data);
  return jsonResponse({ id: newId });
}

async function handleAdminQuestionDelete(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  const id = parseInt(params.id, 10);
  const question = await question_find(env, id);
  if (!question) return jsonResponse({ message: 'Not found.' }, 404);
  await question_delete(env, id);
  return jsonResponse({ status: 'deleted' });
}

async function handleAdminQuestionReorder(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  const quiz = await quiz_find(env, parseInt(params.id, 10));
  if (!quiz) return jsonResponse({ message: 'Not found.' }, 404);
  let body; try { body = await request.json(); } catch { body = {}; }
  const ids = Array.isArray(body.ids) ? body.ids.map(x => parseInt(x, 10)).filter(Number.isFinite) : [];
  if (!ids.length) return jsonResponse({ message: 'No question order supplied.' }, 422);
  await question_reorder(env, quiz.id, ids);
  return jsonResponse({ status: 'reordered' });
}

async function handleAdminOptionSave(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  let body; try { body = await request.json(); } catch { body = {}; }
  const questionId = parseInt(body.question_id, 10);
  const question = await question_find(env, questionId);
  if (!question) return jsonResponse({ message: 'Question not found.' }, 404);
  const optionText = String(body.option_text || '').trim();
  if (!optionText || optionText.length > 2000) return jsonResponse({ message: 'Option text is required (max 2000 characters).' }, 422);
  const scoreValue = Number.isFinite(Number(body.score_value)) ? parseInt(body.score_value, 10) : 0;
  let weights = {};
  const wj = String(body.category_weights_json || '').trim();
  if (wj) {
    try {
      const decoded = JSON.parse(wj);
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
      weights = decoded;
    } catch { return jsonResponse({ message: 'Category weights must be valid JSON.' }, 422); }
  }
  const data = {
    question_id: questionId, option_text: optionText, score_value: scoreValue,
    category_weights: weights, order: await option_next_order(env, questionId),
  };
  const id = body.id ? parseInt(body.id, 10) : null;
  if (id) {
    const existing = await option_find(env, id);
    if (!existing || existing.question_id !== questionId) return jsonResponse({ message: 'Option not found for this question.' }, 404);
    await option_update(env, id, data);
    return jsonResponse({ id });
  }
  const newId = await option_create(env, data);
  return jsonResponse({ id: newId });
}

async function handleAdminOptionDelete(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  const id = parseInt(params.id, 10);
  const option = await option_find(env, id);
  if (!option) return jsonResponse({ message: 'Not found.' }, 404);
  await option_delete(env, id);
  return jsonResponse({ status: 'deleted' });
}

async function handleAdminWebhookAdd(request, env, ctx) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  let body; try { body = await request.json(); } catch { body = {}; }
  const url = String(body.url || '').trim();
  const rawEvents = Array.isArray(body.events) ? body.events : [];
  if (!url || url.length > 2048) return jsonResponse({ message: 'A valid URL is required.' }, 422);
  if (!url.startsWith('https://')) return jsonResponse({ message: 'Webhook URL must start with https://.' }, 422);
  const events = rawEvents.filter(x => ALLOWED_WEBHOOK_EVENTS.includes(x));
  if (!events.length) return jsonResponse({ message: 'Select at least one event.' }, 422);
  const safety = await is_url_safe_for_webhook(url);
  if (!safety.ok) return jsonResponse({ message: 'That URL cannot be used for a webhook (' + safety.reason + ')' }, 422);
  const id = await webhook_create(env, url, events);
  return jsonResponse({ id });
}

async function handleAdminWebhookToggle(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  await webhook_toggle(env, parseInt(params.id, 10));
  return jsonResponse({ status: 'toggled' });
}

async function handleAdminWebhookDelete(request, env, ctx, params) {
  const user = await is_admin(request, env, ctx.session);
  if (!user) return jsonResponse({ message: 'Authentication required.' }, 401);
  await webhook_delete(env, parseInt(params.id, 10));
  return jsonResponse({ status: 'deleted' });
}

// ---------------------------------------------------------------------------
// CSRF enforcement helper
// ---------------------------------------------------------------------------
async function verifyCsrf(request, ctx) {
  if (['GET','HEAD','OPTIONS'].includes(request.method)) return true;
  const expected = ctx.session && ctx.session.csrf;
  if (!expected) return false;
  let provided = request.headers.get('X-CSRF-Token');
  if (!provided) {
    const ct = request.headers.get('Content-Type') || '';
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      try {
        const clone = request.clone();
        const form = await clone.formData();
        provided = form.get('_csrf');
      } catch {}
    }
  }
  if (!provided) return false;
  return constantTimeEqual(String(provided), String(expected));
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
const ROUTES = [
  ['GET',  '/',                                              handleHome],
  ['GET',  '/q/{slug}',                                      handleQuizLanding],
  ['GET',  '/result/{attemptId}',                            handleQuizResult],

  ['GET',  '/api/quiz/{slug}/questions',                     handleQuestions],
  ['POST', '/api/quiz/{slug}/lead',                          handleLead],
  ['POST', '/api/attempt/{attemptId}/autosave',              handleAutosave],
  ['POST', '/api/attempt/{attemptId}/submit',                handleSubmit],
  ['POST', '/api/whatsapp-click',                            handleWhatsappClick],
  ['POST', '/api/share',                                     handleShare],

  ['GET',  '/setup',                                         handleSetupGet],
  ['POST', '/setup',                                         handleSetupPost],
  ['GET',  '/admin/login',                                   handleAdminLoginGet],
  ['POST', '/admin/login',                                   handleAdminLoginPost],
  ['POST', '/admin/logout',                                  handleAdminLogout],

  ['GET',  '/admin',                                         handleAdminDashboard],
  ['GET',  '/admin/leads',                                   handleAdminLeadsPage],
  ['GET',  '/admin/quizzes',                                 handleAdminQuizzesList],
  ['GET',  '/admin/quizzes/create',                          handleAdminQuizForm],
  ['GET',  '/admin/quizzes/{id}/edit',                       handleAdminQuizForm],
  ['POST', '/admin/quizzes/save',                            handleAdminQuizSave],
  ['GET',  '/admin/quizzes/{id}/leads.csv',                  handleAdminLeadsExport],
  ['GET',  '/admin/settings',                                handleAdminSettingsPage],

  ['GET',  '/api/admin/quizzes/search',                      handleAdminQuizzesSearch],
  ['GET',  '/api/admin/settings-data',                       handleAdminSettingsData],
  ['POST', '/api/admin/settings/save',                       handleAdminSettingsSave],
  ['POST', '/api/admin/quizzes/{id}/duplicate',              handleAdminQuizDuplicate],
  ['POST', '/api/admin/quizzes/{id}/delete',                 handleAdminQuizDelete],
  ['GET',  '/api/admin/quizzes/{id}/questions',              handleAdminQuestionsList],
  ['POST', '/api/admin/questions/save',                      handleAdminQuestionSave],
  ['POST', '/api/admin/questions/{id}/delete',               handleAdminQuestionDelete],
  ['POST', '/api/admin/quizzes/{id}/questions/reorder',      handleAdminQuestionReorder],
  ['POST', '/api/admin/options/save',                        handleAdminOptionSave],
  ['POST', '/api/admin/options/{id}/delete',                 handleAdminOptionDelete],
  ['POST', '/api/admin/webhooks/add',                        handleAdminWebhookAdd],
  ['POST', '/api/admin/webhooks/{id}/toggle',                handleAdminWebhookToggle],
  ['POST', '/api/admin/webhooks/{id}/delete',                handleAdminWebhookDelete],
];

export default {
  async fetch(request, env) {
    try {
      if (!env.APP_SECRET) {
        return jsonResponse({ message: 'Server misconfigured: APP_SECRET is not set.' }, 500);
      }
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      const { session, needsRefresh } = await readSession(request, env);
      const ctx = { session: session || freshSession(), needsRefresh: !!needsRefresh };

      const match = matchRoute(request.method, pathname, ROUTES);
      if (!match) {
        // SPA-ish fallback: GET unknown → 404 page, else 404 JSON
        if (request.method === 'GET') {
          return htmlResponse(view404(env, ctx.session.csrf, await current_user(request, env, ctx.session)), 404);
        }
        return jsonResponse({ message: 'Not found.' }, 404);
      }

      // CSRF for state-changing requests
      if (!(await verifyCsrf(request, ctx))) {
        if (request.headers.get('X-Requested-With') === 'XMLHttpRequest' ||
            (request.headers.get('Accept') || '').includes('application/json')) {
          return jsonResponse({ message: 'Invalid or missing CSRF token. Refresh the page and try again.' }, 419);
        }
        return htmlResponse('Your session expired or the form token was invalid. Go back and try again.', 419);
      }

      const response = await match.handler(request, env, ctx, match.params);

      // Always refresh the session cookie so the csrf token stays in sync and
      // the resultOwners map persists after /submit.
      const cookieResponse = await writeSessionCookie(response, ctx.session, env);
      return cookieResponse;
    } catch (err) {
      console.error('Unhandled error', err && err.stack || err);
      return jsonResponse({ message: 'Internal error: ' + (err && err.message ? err.message : 'unknown') }, 500);
    }
  },

  async scheduled(event, env) {
    try {
      const res = await env.DB.prepare(
        `SELECT * FROM webhook_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 20`
      ).all();
      const jobs = res.results || [];
      for (const job of jobs) {
        await deliverJob(env, job);
      }
    } catch (e) {
      console.error('Cron error', e && e.stack || e);
    }
  },
};

async function deliverJob(env, job) {
  const safety = await is_url_safe_for_webhook(job.url);
  if (!safety.ok) {
    await env.DB.prepare(`UPDATE webhook_jobs SET status='failed', last_error=? WHERE id=?`)
      .bind('Blocked: ' + safety.reason, job.id).run();
    return;
  }
  let payloadStr;
  try {
    payloadStr = JSON.stringify({
      event: job.event,
      payload: JSON.parse(job.payload),
      timestamp: new Date().toISOString(),
    });
  } catch {
    await env.DB.prepare(`UPDATE webhook_jobs SET status='failed', last_error=? WHERE id=?`)
      .bind('Invalid payload JSON', job.id).run();
    return;
  }
  let ok = false, status = 0, errMsg = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(job.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadStr,
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);
    status = r.status;
    ok = status >= 200 && status < 300;
  } catch (err) {
    errMsg = err && err.message ? err.message : 'fetch failed';
  }
  const attempts = (job.attempts || 0) + 1;
  if (ok) {
    await env.DB.prepare(`UPDATE webhook_jobs SET status='done', attempts=?, updated_at=datetime('now') WHERE id=?`)
      .bind(attempts, job.id).run();
    return;
  }
  const failed = attempts >= 3;
  await env.DB.prepare(
    `UPDATE webhook_jobs SET status=?, attempts=?, last_error=?, updated_at=datetime('now') WHERE id=?`
  ).bind(failed ? 'failed' : 'pending', attempts, errMsg || ('HTTP ' + status), job.id).run();
}