import { decodeEntities } from './text.js';

/**
 * Minimal RSS/Atom reader. We only need <item>/<entry> children, so a full XML
 * parser (and the dependency it drags in) would be overkill.
 */
export function parseFeed(xml = '') {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  for (const block of blocks) {
    const item = {
      title: tag(block, 'title'),
      link: tag(block, 'link') || attr(block, 'link', 'href'),
      description: tag(block, 'description') || tag(block, 'content:encoded') || tag(block, 'summary') || tag(block, 'content'),
      pubDate: tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'),
      guid: tag(block, 'guid') || tag(block, 'id'),
      category: tags(block, 'category'),
      region: tag(block, 'region'),
      type: tag(block, 'type'),
      company: tag(block, 'company'),
    };
    if (item.title || item.link) items.push(item);
  }
  return items;
}

function raw(block, name) {
  const re = new RegExp(`<${escape(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escape(name)}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}

function tag(block, name) {
  const v = raw(block, name);
  return v === null ? null : clean(v);
}

function tags(block, name) {
  const re = new RegExp(`<${escape(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escape(name)}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(clean(m[1]));
  return out;
}

function attr(block, name, attrName) {
  const re = new RegExp(`<${escape(name)}\\b[^>]*\\b${escape(attrName)}=["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

function clean(v) {
  const cdata = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities(cdata ? cdata[1] : v).trim();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
