export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(String(value));
    return true;
  } catch {
    const active = document.activeElement;
    const host = active?.closest('dialog[open]') || document.body;
    const input = Object.assign(document.createElement('textarea'), { value: String(value) });
    input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
    host.append(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      /* Leave the value selectable in the UI. */
    }
    input.remove();
    active?.focus?.({ preventScroll: true });
    return copied;
  }
}
