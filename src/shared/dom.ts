// Minimal DOM builder. Text always goes through text nodes, never innerHTML, so values read
// from the chain (addresses, ids, error messages) can't inject markup.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value !== undefined) el.setAttribute(name, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG = "http://www.w3.org/2000/svg";

/** An SVG element; attributes only, no markup strings. */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Node | null | false | undefined)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value !== undefined) el.setAttribute(name, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

/** A definition list from label/value pairs: mono labels, values that may wrap. */
export function facts(rows: [string, Child | Child[]][]): HTMLDListElement {
  return h(
    "dl",
    { class: "my-2 grid gap-1" },
    rows.map(([label, value]) =>
      h(
        "div",
        { class: "grid grid-cols-[5.5rem_1fr] gap-2 items-baseline" },
        h("dt", { class: "font-mono text-[0.7rem] text-soft" }, label),
        h("dd", { class: "m-0 min-w-0 text-[0.85rem]" }, value),
      ),
    ),
  );
}

/** Monospace data value (hash, address, height). */
export function mono(text: string, title?: string): HTMLElement {
  return h("span", { class: "font-mono text-[0.72rem] [overflow-wrap:anywhere]", title }, text);
}

export function link(href: string, ...children: Child[]): HTMLAnchorElement {
  return h("a", { href }, ...children);
}
