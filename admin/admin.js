/* Tony D site admin.
 *
 * Edits content/shared.json, content/en.json and content/zh.json in the
 * browser and posts them to the admin Worker, which commits them to the draft
 * branch. Nothing here talks to GitHub directly — that is deliberate, so the
 * admin works from mainland China where api.github.com is unreliable.
 *
 * The English and Chinese fields for the same item sit next to each other on
 * purpose: the site's long-standing hazard is editing one page and forgetting
 * the other, and pairing them makes that hard to do.
 *
 * Vanilla JS, no build step, matching the site it edits.
 */

const API = '/api/admin';

const state = {
  headSha: null,
  files: null,
  dirty: false,
  tab: 'videos',
  status: null,
};

const SHARED = () => state.files['content/shared.json'];
const LOC = (lang) => state.files[`content/${lang}.json`];
const LANGS = [
  { code: 'en', label: 'EN', cls: 'tag--en', attr: 'en' },
  { code: 'zh', label: '中文', cls: 'tag--zh', attr: 'zh-Hans' },
];

// ---------------------------------------------------------------- helpers

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'className') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function markDirty() {
  state.dirty = true;
  document.getElementById('saveBtn').disabled = false;
  renderStatus();
}

function toast(message, kind, detail) {
  const node = document.getElementById('toast');
  node.className = 'toast' + (kind ? ` toast--${kind}` : '');
  node.replaceChildren(
    el('div', {}, message),
    detail ? el('p', { className: 'toast__detail' }, detail) : null,
  );
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { node.hidden = true; }, kind === 'bad' ? 9000 : 4000);
}

async function api(path, init) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.detail = body && body.detail;
    err.status = res.status;
    throw err;
  }
  return body;
}

const slug = (s) =>
  (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function newId(prefix, taken) {
  let base = prefix || 'item';
  let n = 1;
  let id = base;
  while (taken.includes(id)) id = `${base}-${++n}`;
  return id;
}

// ---------------------------------------------------------------- controls

function input(obj, key, opts = {}) {
  const node = opts.multiline ? el('textarea') : el('input', { type: 'text' });
  node.value = obj[key] ?? '';
  if (opts.lang) node.setAttribute('lang', opts.lang);
  if (opts.mono) node.className = 'mono';
  if (opts.rows) node.rows = opts.rows;
  if (opts.placeholder) node.placeholder = opts.placeholder;
  node.addEventListener('input', () => {
    if (node.value === '' && opts.dropWhenEmpty) delete obj[key];
    else obj[key] = node.value;
    if (opts.onChange) opts.onChange(node.value);
    markDirty();
  });
  return node;
}

function field(label, control, hint, tag) {
  return el(
    'label',
    { className: 'f' },
    el('span', {}, label, tag ? el('span', { className: `tag ${tag.cls}` }, tag.label) : null),
    control,
    hint ? el('p', { className: 'hint', html: hint }) : null,
  );
}

function row(...kids) {
  return el('div', { className: 'row' }, ...kids);
}

/** The same field in both locales, side by side. */
function bi(label, key, getObj, opts = {}) {
  return row(
    ...LANGS.map((lang) =>
      field(
        label,
        input(getObj(lang.code), key, { ...opts, lang: lang.attr }),
        lang.code === 'en' ? opts.hint : null,
        lang,
      ),
    ),
  );
}

function check(label, obj, key, onChange) {
  const box = el('input', { type: 'checkbox' });
  box.checked = !!obj[key];
  box.addEventListener('change', () => {
    obj[key] = box.checked;
    markDirty();
    if (onChange) onChange();
  });
  return el('label', { className: 'check' }, box, el('span', {}, label));
}

function listControls(arr, index, rerender, { onDelete } = {}) {
  const move = (to) => {
    if (to < 0 || to >= arr.length) return;
    const [item] = arr.splice(index, 1);
    arr.splice(to, 0, item);
    markDirty();
    rerender();
  };
  return el(
    'div',
    { className: 'listctl' },
    el('button', { className: 'btn btn--small btn--ghost', type: 'button', title: 'Move up',
                   onclick: () => move(index - 1) }, '↑'),
    el('button', { className: 'btn btn--small btn--ghost', type: 'button', title: 'Move down',
                   onclick: () => move(index + 1) }, '↓'),
    el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                   onclick: () => {
                     if (!confirm('Remove this item? It disappears from both languages.')) return;
                     const [gone] = arr.splice(index, 1);
                     if (onDelete) onDelete(gone);
                     markDirty();
                     rerender();
                   } }, 'Remove'),
  );
}

function card(titleNode, controls, body) {
  return el(
    'div',
    { className: 'card' },
    el('div', { className: 'card__head' }, el('div', { className: 'card__title' }, titleNode), controls),
    el('div', { className: 'card__body' }, body),
  );
}

function addButton(label, onClick) {
  return el('button', { className: 'additem', type: 'button', onclick: onClick }, label);
}

function intro(html) {
  return el('p', { className: 'intro', html });
}

// ---------------------------------------------------------------- uploads

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Upload straight to the draft branch. Uploads commit immediately rather than
 * waiting for Save, because a half-saved image reference is worse than an
 * unreferenced file sitting in the repo.
 */
async function uploadInto(dir, file, onDone) {
  const name = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const path = `${dir}/${name}`;
  toast(`Uploading ${name}…`);
  try {
    const b64 = await fileToBase64(file);
    const res = await api('/upload', {
      method: 'POST',
      body: JSON.stringify({ path, contentBase64: b64 }),
    });
    state.headSha = res.commit;
    toast(`Uploaded ${path}`, 'good', 'It is on the draft branch — Publish to put it on the live site.');
    onDone(path, file);
  } catch (err) {
    toast(err.message, 'bad', err.detail);
  }
}

function uploadButton(dir, label, onDone) {
  const picker = el('input', { type: 'file', accept: '.webp,.jpg,.jpeg,.png' });
  picker.style.display = 'none';
  picker.addEventListener('change', () => {
    if (picker.files[0]) uploadInto(dir, picker.files[0], onDone);
    picker.value = '';
  });
  return el(
    'span',
    {},
    el('button', { className: 'btn btn--small', type: 'button', onclick: () => picker.click() }, label),
    picker,
  );
}

// ---------------------------------------------------------------- tabs

const TABS = [
  { id: 'videos', label: 'Videos', render: renderVideos },
  { id: 'releases', label: 'Releases', render: renderReleases },
  { id: 'about', label: 'About', render: renderAbout },
  { id: 'milestones', label: 'Milestones', render: renderMilestones },
  { id: 'press', label: 'Press', render: renderPress },
  { id: 'contact', label: 'Contact & footer', render: renderContact },
  { id: 'page', label: 'Hero & nav', render: renderPage },
  { id: 'images', label: 'Images', render: renderImages },
  { id: 'raw', label: 'Raw JSON', render: renderRaw },
];

// ---------------------------------------------------------------- videos

function renderVideos() {
  const shared = SHARED();
  const rerender = () => renderPanel();
  const out = [
    intro(
      'Each tile is a link with a poster until someone clicks it — nothing loads from YouTube or Bilibili on page load. ' +
      'The <b>Bilibili BV id</b> is the one to fill in when a video goes up on B站: a tile with an empty BV id stays an ' +
      'ordinary outbound link on the Chinese page instead of becoming a player that cannot load in China.',
    ),
  ];

  shared.videos.forEach((v, i) => {
    const enV = LOC('en').videos[v.id] || (LOC('en').videos[v.id] = { title: '', sub: '' });
    const zhV = LOC('zh').videos[v.id] || (LOC('zh').videos[v.id] = { title: '', sub: '' });

    const badge = v.bv
      ? el('span', { className: 'live' }, 'B站 live')
      : el('span', { className: 'pending' }, 'B站 pending');

    const title = el(
      'span',
      {},
      enV.title || '(untitled)',
      ' ',
      badge,
      v.feature ? el('span', { className: 'live' }, 'feature') : null,
      el('small', {}, v.id),
    );

    const thumb = el('img', {
      className: 'vidrow__thumb',
      src: '/' + v.poster,
      alt: '',
      loading: 'lazy',
    });

    const body = el(
      'div',
      { className: 'vidrow' },
      el(
        'div',
        {},
        thumb,
        el('div', { style: 'margin-top:8px' },
          uploadButton('img/video', 'Replace poster', (path) => {
            v.poster = path;
            markDirty();
            rerender();
          })),
      ),
      el(
        'div',
        { className: 'vidrow__fields' },
        row(
          field('YouTube ID', input(v, 'yt', { mono: true }),
                'The part after <code>youtu.be/</code>. Also names the poster file.'),
          field('Bilibili BV ID', input(v, 'bv', { mono: true, placeholder: 'BV1xx411c7mD', onChange: rerenderSoon }),
                'Leave empty until the video is on B站.'),
        ),
        bi('Title', 'title', (l) => (l === 'en' ? enV : zhV)),
        bi('Subtitle', 'sub', (l) => (l === 'en' ? enV : zhV)),
        v.feature ? bi('Kicker', 'kicker', (l) => (l === 'en' ? enV : zhV),
                       { hint: 'Small label above the title on the feature tile.' }) : null,
        row(
          check('Feature tile (large, above the grid)', v, 'feature', rerender),
          field('Poster path', input(v, 'poster', { mono: true })),
        ),
        el('details', {}, el('summary', { className: 'hint' }, 'Language attributes'),
           row(
             field('EN title lang attr', input(enV, 'titleLang', { mono: true, dropWhenEmpty: true }),
                   'Set to <code>zh</code> if this title is Chinese on the English page.'),
             field('中文 title lang attr', input(zhV, 'titleLang', { mono: true, dropWhenEmpty: true }),
                   'Set to <code>en</code> if this title stays English on the Chinese page.'),
           )),
      ),
    );

    out.push(card(title, listControls(shared.videos, i, rerender, {
      onDelete: (gone) => {
        delete LOC('en').videos[gone.id];
        delete LOC('zh').videos[gone.id];
      },
    }), body));
  });

  out.push(addButton('+ Add a video', () => {
    const id = newId('video', shared.videos.map((v) => v.id));
    shared.videos.push({ id, yt: '', bv: '', poster: 'img/video/placeholder.webp', feature: false });
    LOC('en').videos[id] = { title: '', sub: '' };
    LOC('zh').videos[id] = { title: '', sub: '' };
    markDirty();
    rerender();
  }));

  return out;
}

let rerenderTimer = null;
function rerenderSoon() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(renderPanel, 600);
}

// ---------------------------------------------------------------- releases

function linksEditor(locale, obj) {
  const rerender = () => renderPanel();
  const list = obj.links || (obj.links = []);

  return el(
    'div',
    {},
    el('span', { className: 'hint' }, `Links (${locale})`),
    ...list.map((link, i) =>
      row(
        field('Label', input(link, 'label', { lang: locale === 'zh' ? 'zh-Hans' : 'en' })),
        field('URL', input(link, 'url', { mono: true }),
              'Leave empty and tick “unknown” to grey it out.'),
        el('div', { style: 'flex:0 0 auto;display:flex;gap:8px;align-items:flex-end' },
           check('unknown', link, 'missing'),
           el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                          onclick: () => { list.splice(i, 1); markDirty(); rerender(); } }, '×')),
      ),
    ),
    el('button', { className: 'btn btn--small', type: 'button',
                   onclick: () => { list.push({ label: '', url: '' }); markDirty(); rerender(); } },
       '+ link'),
  );
}

function renderReleases() {
  const shared = SHARED();
  const rerender = () => renderPanel();
  const out = [intro('Albums and singles cards in section 01. The Chinese page deliberately leads with NetEase and QQ Music, so each language keeps its own link list and its own order.')];

  shared.releases.forEach((r, i) => {
    const enR = LOC('en').releases[r.id];
    const zhR = LOC('zh').releases[r.id];

    const body = el(
      'div',
      {},
      row(
        el('div', {},
           el('img', { src: '/' + r.art, alt: '', style: 'width:120px;border-radius:5px;display:block;margin-bottom:8px' }),
           uploadButton('img', 'Replace cover', (path) => { r.art = path; markDirty(); rerender(); })),
        el('div', {},
           field('Cover path', input(r, 'art', { mono: true })),
           el('div', { style: 'margin-top:10px' }, check('Show “new” badge', r, 'badge', rerender))),
      ),
      bi('Title', 'title', (l) => (l === 'en' ? enR : zhR),
         { hint: 'Inline HTML is allowed, e.g. <code>&lt;span lang="zh"&gt;想太多&lt;/span&gt;</code>.' }),
      bi('Meta line', 'meta', (l) => (l === 'en' ? enR : zhR)),
      bi('Description', 'copy', (l) => (l === 'en' ? enR : zhR), { multiline: true, rows: 2 }),
      bi('Cover alt text', 'alt', (l) => (l === 'en' ? enR : zhR),
         { hint: 'Describes the image for screen readers.' }),
      r.badge ? bi('Badge label', 'badge', (l) => (l === 'en' ? enR : zhR)) : null,
      row(linksEditor('en', enR), linksEditor('zh', zhR)),
    );

    out.push(card(
      el('span', {}, enR.title.replace(/<[^>]+>/g, ''), el('small', {}, r.id)),
      listControls(shared.releases, i, rerender, {
        onDelete: (gone) => { delete LOC('en').releases[gone.id]; delete LOC('zh').releases[gone.id]; },
      }),
      body,
    ));
  });

  out.push(addButton('+ Add a release', () => {
    const id = newId('release', shared.releases.map((r) => r.id));
    shared.releases.push({ id, art: 'img/album-overthinking.webp', badge: false });
    for (const l of ['en', 'zh']) {
      LOC(l).releases[id] = { alt: '', title: '', meta: '', copy: '', links: [] };
    }
    markDirty();
    rerender();
  }));

  return out;
}

// ---------------------------------------------------------------- about

function paragraphList(locale, aboutObj, key, label) {
  const rerender = () => renderPanel();
  const list = aboutObj[key] || (aboutObj[key] = []);
  const lang = locale === 'zh' ? 'zh-Hans' : 'en';

  return el(
    'div',
    {},
    ...list.map((_, i) =>
      el('div', { style: 'margin-bottom:10px' },
         field(`${label} ${i + 1}`,
               input(list, String(i), { multiline: true, rows: 4, lang }),
               null,
               LANGS.find((l) => l.code === locale)),
         el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                        onclick: () => { list.splice(i, 1); markDirty(); rerender(); } }, 'Remove paragraph')),
    ),
    el('button', { className: 'btn btn--small', type: 'button',
                   onclick: () => { list.push(''); markDirty(); rerender(); } }, '+ paragraph'),
  );
}

function renderAbout() {
  const rerender = () => renderPanel();
  const enA = LOC('en').about;
  const zhA = LOC('zh').about;
  const out = [intro('Section 03. The bio is the part of the site most likely to be read by a label or a journalist — every claim here should be something the resume PDF actually supports.')];

  out.push(card('Bio paragraphs', null, el('div', {},
    row(paragraphList('en', enA, 'prose', 'Paragraph'), paragraphList('zh', zhA, 'prose', '段落')),
  )));

  out.push(card('Pull quote', null, bi('Quote', 'quote', (l) => (l === 'en' ? enA : zhA))));

  out.push(card('Paragraphs after the quote', null, el('div', {},
    row(paragraphList('en', enA, 'proseAfterQuote', 'Paragraph'),
        paragraphList('zh', zhA, 'proseAfterQuote', '段落')),
  )));

  // Influences — a per-locale list, because the Chinese page gives the
  // Chinese rendering of bands that have one and leaves the rest in English.
  const infl = el('div', {}, ...LANGS.map((lang) => {
    const list = (lang.code === 'en' ? enA : zhA).influences;
    return el('div', { style: 'flex:1' },
      el('span', { className: 'hint' }, `Influences (${lang.label})`),
      ...list.map((item, i) => row(
        field('Name', input(item, 'label', { lang: lang.attr })),
        field('lang attr', input(item, 'lang', { mono: true, dropWhenEmpty: true })),
        el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                       onclick: () => { list.splice(i, 1); markDirty(); rerender(); } }, '×'),
      )),
      el('button', { className: 'btn btn--small', type: 'button',
                     onclick: () => { list.push({ label: '' }); markDirty(); rerender(); } }, '+ name'),
    );
  }));
  out.push(card('Influences', null, el('div', { className: 'row' }, infl)));

  // Profile table
  const facts = el('div', { className: 'row' }, ...LANGS.map((lang) => {
    const list = (lang.code === 'en' ? enA : zhA).facts;
    return el('div', { style: 'flex:1' },
      el('span', { className: 'hint' }, `Profile rows (${lang.label})`),
      ...list.map((item, i) => row(
        field('Term', input(item, 'term', { lang: lang.attr })),
        field('Value', input(item, 'value', { lang: lang.attr })),
        el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                       onclick: () => { list.splice(i, 1); markDirty(); rerender(); } }, '×'),
      )),
      el('button', { className: 'btn btn--small', type: 'button',
                     onclick: () => { list.push({ term: '', value: '' }); markDirty(); rerender(); } }, '+ row'),
    );
  }));
  out.push(card('Profile table', null, facts));

  out.push(card('Headings', null, el('div', {},
    bi('Influences heading', 'influencesHeading', (l) => (l === 'en' ? enA : zhA)),
    bi('Profile heading', 'profileHeading', (l) => (l === 'en' ? enA : zhA)),
  )));

  out.push(card('Photo captions & alt text', null, el('div', {},
    bi('Top portrait alt', 'altTop', (l) => (l === 'en' ? enA : zhA)),
    bi('Live photo alt', 'altWide', (l) => (l === 'en' ? enA : zhA)),
    bi('Live photo caption', 'captionWide', (l) => (l === 'en' ? enA : zhA)),
    bi('Bottom portrait alt', 'altBottom', (l) => (l === 'en' ? enA : zhA)),
  )));

  return out;
}

// ---------------------------------------------------------------- milestones

function renderMilestones() {
  const shared = SHARED();
  const rerender = () => renderPanel();
  const out = [intro('Section 04, the timeline. Each bullet exists once and carries an English and a Chinese wording, so a new award is one entry rather than two.')];

  shared.milestones.forEach((yearRow, yi) => {
    const items = yearRow.items.map((itemId, ii) => {
      const enM = LOC('en').milestones;
      const zhM = LOC('zh').milestones;
      return el('div', { style: 'margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line)' },
        row(
          field('English', input(enM, itemId, { multiline: true, rows: 2 }), null, LANGS[0]),
          field('中文', input(zhM, itemId, { multiline: true, rows: 2, lang: 'zh-Hans' }), null, LANGS[1]),
          el('div', { style: 'flex:0 0 auto;display:flex;flex-direction:column;gap:5px;justify-content:flex-end' },
             el('button', { className: 'btn btn--small btn--ghost', type: 'button',
                            onclick: () => { if (ii > 0) { const [m] = yearRow.items.splice(ii, 1); yearRow.items.splice(ii - 1, 0, m); markDirty(); rerender(); } } }, '↑'),
             el('button', { className: 'btn btn--small btn--ghost', type: 'button',
                            onclick: () => { if (ii < yearRow.items.length - 1) { const [m] = yearRow.items.splice(ii, 1); yearRow.items.splice(ii + 1, 0, m); markDirty(); rerender(); } } }, '↓'),
             el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                            onclick: () => {
                              if (!confirm('Remove this milestone from both languages?')) return;
                              yearRow.items.splice(ii, 1);
                              delete enM[itemId];
                              delete zhM[itemId];
                              markDirty();
                              rerender();
                            } }, '×')),
        ),
        el('p', { className: 'hint' }, `id: ${itemId} — inline HTML allowed, e.g. <b>…</b> for the song title`),
      );
    });

    const body = el('div', {},
      row(
        field('Year label', input(yearRow, 'year')),
        el('div', { style: 'display:flex;align-items:flex-end' }, check('Highlight as current year', yearRow, 'current')),
      ),
      ...items,
      el('button', { className: 'btn btn--small', type: 'button', onclick: () => {
        const label = prompt('Short name for this milestone (used as its internal id):', '');
        if (label === null) return;
        const taken = Object.keys(LOC('en').milestones);
        const id = newId(slug(label) || 'milestone', taken);
        yearRow.items.push(id);
        LOC('en').milestones[id] = label || '';
        LOC('zh').milestones[id] = '';
        markDirty();
        rerender();
      } }, '+ milestone'),
    );

    out.push(card(el('span', {}, yearRow.year, el('small', {}, `${yearRow.items.length} entries`)),
                  listControls(shared.milestones, yi, rerender, {
                    onDelete: (gone) => gone.items.forEach((id) => {
                      delete LOC('en').milestones[id];
                      delete LOC('zh').milestones[id];
                    }),
                  }), body));
  });

  out.push(addButton('+ Add a year', () => {
    shared.milestones.push({ year: String(new Date().getFullYear()), current: false, items: [] });
    markDirty();
    rerender();
  }));

  return out;
}

// ---------------------------------------------------------------- press

function renderPress() {
  const shared = SHARED();
  const rerender = () => renderPanel();
  const out = [intro('Section 05. The English page shows the original Chinese headline with an English gloss underneath — those glosses are translations for readers, not official titles, so keep them descriptive rather than authoritative.')];

  shared.press.forEach((item, i) => {
    const enP = LOC('en').press[item.id] || (LOC('en').press[item.id] = { src: '', title: '', gloss: '' });
    const zhP = LOC('zh').press[item.id] || (LOC('zh').press[item.id] = { src: '', title: '', gloss: '' });

    const body = el('div', {},
      field('Link', input(item, 'url', { mono: true })),
      bi('Source', 'src', (l) => (l === 'en' ? enP : zhP)),
      bi('Headline', 'title', (l) => (l === 'en' ? enP : zhP)),
      bi('Gloss / subtitle', 'gloss', (l) => (l === 'en' ? enP : zhP)),
    );

    out.push(card(el('span', {}, enP.title || '(untitled)', el('small', {}, item.id)),
                  listControls(shared.press, i, rerender, {
                    onDelete: (gone) => { delete LOC('en').press[gone.id]; delete LOC('zh').press[gone.id]; },
                  }), body));
  });

  out.push(addButton('+ Add a press item', () => {
    const id = newId('press', shared.press.map((p) => p.id));
    shared.press.push({ id, url: '' });
    LOC('en').press[id] = { src: 'Weibo', title: '', titleLang: 'zh', gloss: '' };
    LOC('zh').press[id] = { src: '微博', title: '', gloss: '' };
    markDirty();
    rerender();
  }));

  return out;
}

// ---------------------------------------------------------------- contact

function renderContact() {
  const shared = SHARED();
  const rerender = () => renderPanel();
  const out = [intro('Section 06 and the footer. The email here is the public-facing management address — it appears on both pages and in the mailto link.')];

  out.push(card('Shared', null, el('div', {},
    row(
      field('Contact email', input(shared, 'contactEmail', { mono: true })),
      field('Copyright year', input(shared, 'copyrightYear')),
    ),
  )));

  out.push(card('Contact heading', null, el('div', {},
    bi('Who to contact', 'who', (l) => LOC(l).contact),
  )));

  LANGS.forEach((lang) => {
    const contact = LOC(lang.code).contact;
    const cols = contact.columns;
    const body = el('div', {}, ...cols.map((col, ci) =>
      el('div', { style: 'margin-bottom:16px' },
        row(
          field('Column heading', input(col, 'heading', { lang: lang.attr })),
          el('div', { style: 'flex:0 0 auto;display:flex;align-items:flex-end' },
             el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                            onclick: () => { cols.splice(ci, 1); markDirty(); rerender(); } }, 'Remove column')),
        ),
        ...col.items.map((item, ii) => row(
          field('Label', input(item, 'label', { lang: lang.attr })),
          field('URL', input(item, 'url', { mono: true, dropWhenEmpty: true }),
                'Empty = plain text, no link.'),
          field('Muted suffix', input(item, 'muted', { lang: lang.attr, dropWhenEmpty: true }),
                'e.g. <code>（海外）</code> or <code>— distribution</code>'),
          el('div', { style: 'flex:0 0 auto;display:flex;gap:6px;align-items:flex-end' },
             check('tight', item, 'mutedTight'),
             el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                            onclick: () => { col.items.splice(ii, 1); markDirty(); rerender(); } }, '×')),
        )),
        el('button', { className: 'btn btn--small', type: 'button',
                       onclick: () => { col.items.push({ label: '' }); markDirty(); rerender(); } }, '+ item'),
      )),
      el('button', { className: 'btn btn--small', type: 'button',
                     onclick: () => { cols.push({ heading: '', items: [] }); markDirty(); rerender(); } },
         '+ column'),
    );
    out.push(card(el('span', {}, `Contact columns `, el('span', { className: `tag ${lang.cls}` }, lang.label)), null, body));
  });

  out.push(card('Footer', null, el('div', {},
    bi('Copyright line', 'copyright', (l) => LOC(l).footer,
       { hint: 'Follows the © and the year. Inline HTML allowed.' }),
    bi('Back-to-top label', 'backToTop', (l) => LOC(l).footer),
  )));

  return out;
}

// ---------------------------------------------------------------- page

function renderPage() {
  const rerender = () => renderPanel();
  const out = [intro('The masthead, the scrolling achievements ticker, and the numbered heading at the top of every section.')];

  out.push(card('Browser tab & search results', null, el('div', {},
    bi('Page title', 'title', (l) => LOC(l).head),
    bi('Meta description', 'description', (l) => LOC(l).head, { multiline: true, rows: 2 }),
  )));

  out.push(card('Hero', null, el('div', {},
    bi('Eyebrow', 'eyebrow', (l) => LOC(l).hero),
    bi('Hidden heading (screen readers)', 'srTitle', (l) => LOC(l).hero,
       { hint: 'The logo is an image, so this is the real <code>h1</code> text.' }),
    bi('Subheading', 'sub', (l) => LOC(l).hero, { multiline: true, rows: 3 }),
    bi('Play button label', 'playLabel', (l) => LOC(l).hero),
    bi('Hero image alt', 'imageAlt', (l) => LOC(l).hero),
  )));

  // Ticker — a plain per-locale list of strings.
  const ticker = el('div', { className: 'row' }, ...LANGS.map((lang) => {
    const items = LOC(lang.code).ticker.items;
    return el('div', { style: 'flex:1' },
      el('span', { className: 'hint' }, `Ticker items (${lang.label}) — <b>…</b> for the emphasised part`),
      ...items.map((_, i) => row(
        field(`Item ${i + 1}`, input(items, String(i), { lang: lang.attr })),
        el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                       onclick: () => { items.splice(i, 1); markDirty(); rerender(); } }, '×'),
      )),
      el('button', { className: 'btn btn--small', type: 'button',
                     onclick: () => { items.push(''); markDirty(); rerender(); } }, '+ item'),
    );
  }));
  out.push(card('Achievements ticker', null, ticker));

  const sectionKeys = Object.keys(LOC('en').sections);
  out.push(card('Section headings', null, el('div', {}, ...sectionKeys.map((key) =>
    el('div', { style: 'margin-bottom:14px' },
      el('span', { className: 'hint' }, `#${key}`),
      row(
        field('Number', input(LOC('en').sections[key], 'num', { mono: true })),
        field('Title', input(LOC('en').sections[key], 'title'), null, LANGS[0]),
        field('Title', input(LOC('zh').sections[key], 'title', { lang: 'zh-Hans' }), null, LANGS[1]),
      ),
      row(
        field('Description', input(LOC('en').sections[key], 'desc', { multiline: true, rows: 2 }), null, LANGS[0]),
        field('Description', input(LOC('zh').sections[key], 'desc', { multiline: true, rows: 2, lang: 'zh-Hans' }), null, LANGS[1]),
      ),
    )))));

  out.push(card('Navigation', null, el('div', {},
    bi('Skip-to-content link', 'skip', (l) => LOC(l).nav),
    ...LOC('en').nav.links.map((_, i) => row(
      field('Link target', input(LOC('en').nav.links[i], 'href', { mono: true })),
      field('Label', input(LOC('en').nav.links[i], 'label'), null, LANGS[0]),
      field('Label', input(LOC('zh').nav.links[i], 'label', { lang: 'zh-Hans' }), null, LANGS[1]),
    )),
    row(
      field('Contact button', input(LOC('en').nav.cta, 'label'), null, LANGS[0]),
      field('Contact button', input(LOC('zh').nav.cta, 'label', { lang: 'zh-Hans' }), null, LANGS[1]),
    ),
  )));

  const notice = LOC('zh').notice;
  if (notice) {
    out.push(card(el('span', {}, 'Bilibili notice ', el('span', { className: 'tag tag--zh' }, '中文 only')), null,
      el('div', {},
        el('p', { className: 'hint' },
          'The box above the video grid on the Chinese page. Delete it once every video has a BV id.'),
        field('Title', input(notice, 'title', { lang: 'zh-Hans' })),
        field('Body', input(notice, 'body', { multiline: true, rows: 4, lang: 'zh-Hans' }),
              'Inline links allowed.'),
        el('button', { className: 'btn btn--small btn--ghost btn--danger', type: 'button',
                       onclick: () => {
                         if (!confirm('Remove the Bilibili notice box from the Chinese page?')) return;
                         delete LOC('zh').notice;
                         markDirty();
                         rerender();
                       } }, 'Remove the notice box'),
      )));
  }

  const flag = LOC('zh').videoFlag;
  if (flag) {
    out.push(card(el('span', {}, 'Pending-video flags ', el('span', { className: 'tag tag--zh' }, '中文 only')), null,
      el('div', {},
        el('p', { className: 'hint' }, 'Shown on tiles whose Bilibili BV id is still empty.'),
        field('Feature tile', input(flag, 'feature', { lang: 'zh-Hans' })),
        field('Grid tiles', input(flag, 'default', { lang: 'zh-Hans' })),
      )));
  }

  return out;
}

// ---------------------------------------------------------------- images

function renderImages() {
  const shared = SHARED();
  const rerender = () => renderPanel();
  const out = [intro(
    'Every image the pages reference. Uploads commit to the draft branch straight away, so a new photo is visible on ' +
    'the preview URL immediately — but it will 404 in this admin until you publish, because this page loads previews ' +
    'from the live site.',
  )];

  const named = [
    ['Hero portrait', 'hero'],
    ['About — top portrait', 'aboutTop'],
    ['About — live photo', 'aboutWide'],
    ['About — bottom portrait', 'aboutBottom'],
    ['Handwritten logo', 'ink'],
  ];

  const grid = el('div', { className: 'imggrid' },
    ...named.map(([label, key]) =>
      el('div', { className: 'imgcard' },
        el('img', { src: '/' + shared.images[key], alt: '', loading: 'lazy' }),
        el('div', { className: 'imgcard__body' },
          el('div', { className: 'imgcard__name' }, label),
          el('div', { className: 'imgcard__path' }, shared.images[key]),
          uploadButton('img', 'Replace', (path) => { shared.images[key] = path; markDirty(); rerender(); })))),
    ...shared.releases.map((r) =>
      el('div', { className: 'imgcard' },
        el('img', { src: '/' + r.art, alt: '', loading: 'lazy' }),
        el('div', { className: 'imgcard__body' },
          el('div', { className: 'imgcard__name' }, `Cover — ${r.id}`),
          el('div', { className: 'imgcard__path' }, r.art),
          uploadButton('img', 'Replace', (path) => { r.art = path; markDirty(); rerender(); })))),
  );

  out.push(card('Photos & covers', null, grid));

  const posters = el('div', { className: 'imggrid' },
    ...shared.videos.map((v) =>
      el('div', { className: 'imgcard' },
        el('img', { src: '/' + v.poster, alt: '', loading: 'lazy' }),
        el('div', { className: 'imgcard__body' },
          el('div', { className: 'imgcard__name' }, LOC('en').videos[v.id]?.title || v.id),
          el('div', { className: 'imgcard__path' }, v.poster),
          uploadButton('img/video', 'Replace', (path) => { v.poster = path; markDirty(); rerender(); })))),
  );
  out.push(card('Video posters', null, posters));

  out.push(card('Why posters are self-hosted', null, el('p', { className: 'hint' },
    'These used to be hot-linked from i.ytimg.com, which is blocked in mainland China — the Chinese page showed ' +
    'thirteen broken images. Keep them local; do not paste a YouTube thumbnail URL into the poster field.')));

  return out;
}

// ---------------------------------------------------------------- raw

function renderRaw() {
  const out = [intro(
    'Direct access to the three content files, for anything the forms above do not cover. ' +
    'Invalid JSON will refuse to save.',
  )];

  for (const path of Object.keys(state.files)) {
    const area = el('textarea', { className: 'mono', rows: 24 });
    area.value = JSON.stringify(state.files[path], null, 2);
    const status = el('p', { className: 'hint' }, 'Parsed OK');

    area.addEventListener('input', () => {
      try {
        state.files[path] = JSON.parse(area.value);
        status.textContent = 'Parsed OK';
        status.style.color = '';
        markDirty();
      } catch (err) {
        status.textContent = `Not valid JSON — ${err.message}`;
        status.style.color = '#FF6B93';
      }
    });

    out.push(card(path, null, el('div', {}, area, status)));
  }
  return out;
}

// ---------------------------------------------------------------- shell

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(...TABS.map((tab) =>
    el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(tab.id === state.tab),
      onclick: () => { state.tab = tab.id; renderTabs(); renderPanel(); window.scrollTo(0, 0); },
    }, tab.label)));
}

function renderPanel() {
  const panel = document.getElementById('panel');
  const tab = TABS.find((t) => t.id === state.tab);
  try {
    panel.replaceChildren(...[tab.render()].flat().filter(Boolean));
  } catch (err) {
    panel.replaceChildren(el('p', { className: 'intro' },
      `Could not render this tab: ${err.message}. The Raw JSON tab still works.`));
  }
}

function renderStatus() {
  const node = document.getElementById('status');
  const s = state.status;
  const bits = [];

  if (state.dirty) bits.push('<span class="warn">unsaved changes</span>');
  if (s) {
    bits.push(`signed in as <b>${s.email}</b>`);
    if (s.ahead > 0) bits.push(`<b>${s.ahead}</b> change${s.ahead === 1 ? '' : 's'} waiting to publish`);
    else if (!state.dirty) bits.push('live site is up to date');
    if (!s.canPublish) bits.push('edit &amp; preview only');
  }
  node.innerHTML = bits.join(' &middot; ');

  document.getElementById('publishBtn').disabled =
    !s || !s.canPublish || s.ahead === 0 || state.dirty;
}

async function refreshStatus() {
  try {
    state.status = await api('/status');
  } catch (err) {
    state.status = null;
    toast(err.message, 'bad', err.detail);
  }
  renderStatus();
}

async function load() {
  const data = await api('/content');
  state.headSha = data.headSha;
  state.files = data.files;
  state.dirty = false;
  document.getElementById('saveBtn').disabled = true;
  renderTabs();
  renderPanel();
  await refreshStatus();
}

async function save() {
  const btn = document.getElementById('saveBtn');
  const msgInput = document.getElementById('msg');
  btn.disabled = true;
  try {
    const message = msgInput.value.trim() || 'Update content';
    const res = await api('/content', {
      method: 'PUT',
      body: JSON.stringify({ files: state.files, headSha: state.headSha, message }),
    });
    state.headSha = res.commit;
    state.dirty = false;
    msgInput.value = '';
    toast('Saved to the draft branch', 'good',
          state.status && !state.status.canPublish
            ? 'The site owner can publish it to the live site.'
            : 'Press Publish to put it live.');
    await refreshStatus();
  } catch (err) {
    btn.disabled = false;
    toast(err.message, 'bad', err.detail);
  }
}

async function publish() {
  if (!confirm('Publish all saved changes to the live site?')) return;
  const btn = document.getElementById('publishBtn');
  btn.disabled = true;
  try {
    await api('/publish', { method: 'POST' });
    toast('Published', 'good', 'Cloudflare Pages is rebuilding — the live site updates in under a minute.');
    await refreshStatus();
  } catch (err) {
    toast(err.message, 'bad', err.detail);
    await refreshStatus();
  }
}

window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (state.dirty) save();
  }
});

document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('publishBtn').addEventListener('click', publish);
document.getElementById('reloadBtn').addEventListener('click', async () => {
  if (state.dirty && !confirm('Reload and discard your unsaved changes?')) return;
  await load();
  toast('Reloaded from the draft branch');
});

load().catch((err) => {
  document.getElementById('panel').replaceChildren(
    el('p', { className: 'intro' },
      `Could not load content: ${err.message}${err.detail ? ' — ' + err.detail : ''}`),
  );
  document.getElementById('status').textContent = 'Not connected';
});
