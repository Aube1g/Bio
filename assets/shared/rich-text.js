const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const words = [
  'AES-GCM',
  'WebRTC',
  'DataChannel',
  'Telegram',
  'GitHub',
  'JavaScript',
  'TypeScript',
  'Python',
  'SafeShell',
  'HeadlessUI',
  'Neovim',
  'XGO Agent',
  'XLI CLI',
  'XPI',
  'SQLite',
  'SHA-256',
  'HMAC',
  'Blackjack',
  'Plinko',
  'Dice',
  'Slots',
  '3:2',
  'S17',
  'Go',
];
const pattern = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_])`,
  'gu',
);

// Deliberately small, HTML-safe formatting vocabulary. User input is never trusted as markup.
export function richText(value) {
  let chips = 0;
  const plain = (text) => {
    let output = '',
      offset = 0;
    for (const match of text.matchAll(pattern)) {
      output += escape(text.slice(offset, match.index));
      output += chips++ < 5 ? `<span class="inline-pill">${escape(match[0])}</span>` : escape(match[0]);
      offset = match.index + match[0].length;
    }
    return output + escape(text.slice(offset));
  };
  const input = String(value),
    tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let output = '',
    offset = 0;
  for (const match of input.matchAll(tokens)) {
    output += plain(input.slice(offset, match.index));
    const token = match[0];
    output += token.startsWith('`')
      ? `<code class="inline-code">${escape(token.slice(1, -1))}</code>`
      : token.startsWith('**')
        ? `<strong class="rich-emphasis">${escape(token.slice(2, -2))}</strong>`
        : `<em>${escape(token.slice(1, -1))}</em>`;
    offset = match.index + token.length;
  }
  return output + plain(input.slice(offset));
}
